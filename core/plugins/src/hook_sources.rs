//! Explicit local user/project config sources, not a managed/profile/session config stack.
//! Hosts still authorize the selected workspace and every definition; Codex trust is ignored.
use crate::{
    ComponentDocument,
    hooks::{HookEvent, HookPlan, normalize_documents},
    package,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use toml_edit::{Document, Item};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HookSourceKind {
    User,
    Project,
}
#[derive(Clone, Debug)]
pub struct HookSource {
    pub id: String,
    pub origin: String,
    pub root: PathBuf,
    /// Ordinary configuration source context, not a plugin data directory.
    pub data_root: PathBuf,
    pub digest: String,
    pub plan: HookPlan,
    pub kind: HookSourceKind,
    /// The USER global feature gate. This is never evidence of definition trust.
    pub enabled: bool,
}

/// Reads only the explicitly selected local stack. User and project definitions are
/// cumulative, JSON before TOML. Always includes the user row so the caller can apply
/// its global gate to bundle hooks even when no user definitions exist.
pub fn configuration_sources(
    home: &Path,
    workspace: &Path,
    config_path: Option<&Path>,
) -> Result<Vec<HookSource>> {
    ensure!(
        home.is_absolute() && workspace.is_absolute(),
        "hook source roots must be absolute"
    );
    // The host-selected roots may use an OS alias such as /var. Resolve only these
    // trusted boundaries; descendants (.codex, hooks.json, config.toml) remain NOFOLLOW.
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let user_config = config_path
        .map(|path| {
            path.parent()
                .and_then(|parent| parent.canonicalize().ok())
                .zip(path.file_name())
                .map(|(parent, name)| parent.join(name))
                .unwrap_or_else(|| path.to_path_buf())
        })
        .unwrap_or_else(|| home.join("config.toml"));
    ensure!(
        user_config.is_absolute(),
        "hook config path must be absolute"
    );
    let (user, enabled) = layer(&home, &user_config, HookSourceKind::User, true)?;
    let mut sources = vec![user];
    let project = workspace.join(".codex");
    let same = project == home
        || project
            .canonicalize()
            .ok()
            .zip(home.canonicalize().ok())
            .is_some_and(|(a, b)| a == b);
    if !same {
        let (mut source, _) = layer(
            &project,
            &project.join("config.toml"),
            HookSourceKind::Project,
            enabled,
        )?;
        source.enabled = enabled;
        sources.push(source);
    }
    Ok(sources)
}

fn read(path: &Path, diagnostics: &mut Vec<String>) -> std::result::Result<Option<Vec<u8>>, ()> {
    // Do not emit OS/parser error strings: TOML error renderings may include secrets.
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => {}
    }
    match path
        .parent()
        .and_then(|parent| package::read_catalog(parent, path).ok())
    {
        Some(bytes) => Ok(Some(bytes)),
        None => {
            diagnostics.push(format!("hooks: {}: source rejected (requires a stable regular file, no links, at most 1 MiB)",path.display()));
            Err(())
        }
    }
}
fn layer(
    root: &Path,
    config: &Path,
    kind: HookSourceKind,
    inherited_gate: bool,
) -> Result<(HookSource, bool)> {
    let mut documents = vec![];
    let mut diagnostics = vec![];
    let json_path = root.join("hooks.json");
    let mut enabled = inherited_gate;
    if let Ok(Some(bytes)) = read(&json_path, &mut diagnostics) {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => documents.push(ComponentDocument {
                portable: false,
                origin: json_path.display().to_string(),
                value,
            }),
            Err(_) => diagnostics.push(format!(
                "hooks: {}: invalid JSON hooks source",
                json_path.display()
            )),
        }
    }
    match read(config, &mut diagnostics) {
        Ok(Some(bytes)) => {
            let parsed = String::from_utf8(bytes)
                .ok()
                .and_then(|text| Document::parse(text).ok());
            if let Some(doc) = parsed {
                if kind == HookSourceKind::User {
                    match global_gate(&doc) {
                        Ok((gate, alias)) => {
                            enabled = gate;
                            if alias {
                                diagnostics.push("hooks: features.codex_hooks is a deprecated alias for features.hooks".into());
                            }
                        }
                        Err(_) => {
                            enabled = false;
                            diagnostics.push(
                                "hooks: invalid user feature gate; hooks disabled until corrected"
                                    .into(),
                            );
                        }
                    }
                } else if doc
                    .get("features")
                    .and_then(Item::as_table_like)
                    .is_some_and(|f| f.contains_key("hooks") || f.contains_key("codex_hooks"))
                {
                    diagnostics.push("hooks: project feature gate ignored; user global gate controls hook execution".into());
                }
                if let Some(hooks) = doc.get("hooks") {
                    let extracted = (|| -> Result<Value> {
                        let table = hooks.as_table_like().context("hooks must be a table")?;
                        if table.contains_key("state") {
                            diagnostics.push("hooks: local hooks.state is ignored; AReaL requires explicit definition trust".into());
                        }
                        let mut events = Map::new();
                        for event in HookEvent::ALL {
                            if let Some(item) = table.get(event.as_str()) {
                                events.insert(event.as_str().into(), json_item(item)?);
                            }
                        }
                        Ok(json!({"hooks":events}))
                    })();
                    match extracted {
                        Ok(value) => documents.push(ComponentDocument {
                            portable: false,
                            origin: config.display().to_string(),
                            value,
                        }),
                        Err(_) => diagnostics.push(format!(
                            "hooks: {}: invalid TOML hook definitions",
                            config.display()
                        )),
                    }
                }
            } else {
                diagnostics.push(format!(
                    "hooks: {}: invalid TOML configuration",
                    config.display()
                ));
                if kind == HookSourceKind::User {
                    enabled = false;
                    diagnostics.push(
                        "hooks: user feature gate unavailable; hooks disabled until corrected"
                            .into(),
                    );
                }
            }
        }
        Err(()) if kind == HookSourceKind::User => {
            enabled = false;
        }
        _ => {}
    }
    // Normalize each source separately; malformed siblings never poison valid entries.
    let mut plan = HookPlan {
        entries: vec![],
        diagnostics,
    };
    let mut populated = 0;
    for document in documents {
        let normalized = normalize_documents(&[document], &[])?;
        if !normalized.entries.is_empty() {
            populated += 1;
        }
        plan.entries.extend(normalized.entries);
        // Normalizer errors may embed an untrusted value; source loading deliberately
        // projects safe fixed diagnostics while retaining the useful source location.
        for _ in normalized.diagnostics {
            plan.diagnostics.push(format!(
                "hooks: {}: invalid or unsupported hook definition; review source",
                root.display()
            ));
        }
    }
    if populated > 1 {
        plan.diagnostics.push("hooks: loading both hooks.json and config.toml in this layer; prefer one representation".into());
    }
    let origin = root.display().to_string();
    // Bind the trusted definition set to its source location; unrelated config values,
    // imported trust claims and feature enablement do not change the definition digest.
    let identity = json!({"origin":origin,"definitions":plan.entries.iter().map(|e|&e.digest).collect::<Vec<_>>()});
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&identity)?)
    );
    let id = if kind == HookSourceKind::User {
        "__hooks_user__"
    } else {
        "__hooks_project__"
    }
    .into();
    Ok((
        HookSource {
            id,
            origin,
            root: root.into(),
            data_root: root.into(),
            digest,
            plan,
            kind,
            enabled,
        },
        enabled,
    ))
}
fn global_gate(doc: &Document<String>) -> Result<(bool, bool)> {
    let Some(features) = doc.get("features") else {
        return Ok((true, false));
    };
    let features = features
        .as_table_like()
        .context("features must be a table")?;
    let alias = features.contains_key("codex_hooks");
    let value = features
        .get("hooks")
        .or_else(|| features.get("codex_hooks"));
    Ok((
        match value {
            Some(value) => value.as_bool().context("feature must be boolean")?,
            None => true,
        },
        alias,
    ))
}
fn json_item(item: &Item) -> Result<Value> {
    if let Some(table) = item.as_table_like() {
        return Ok(Value::Object(
            table
                .iter()
                .map(|(k, v)| Ok((k.into(), json_item(v)?)))
                .collect::<Result<_>>()?,
        ));
    }
    if let Some(tables) = item.as_array_of_tables() {
        return Ok(Value::Array(
            tables
                .iter()
                .map(|t| json_item(&Item::Table(t.clone())))
                .collect::<Result<_>>()?,
        ));
    }
    if let Some(array) = item.as_array() {
        return Ok(Value::Array(
            array
                .iter()
                .map(|v| json_item(&Item::Value(v.clone())))
                .collect::<Result<_>>()?,
        ));
    }
    if let Some(v) = item.as_str() {
        return Ok(json!(v));
    }
    if let Some(v) = item.as_integer() {
        return Ok(json!(v));
    }
    if let Some(v) = item.as_bool() {
        return Ok(json!(v));
    }
    if let Some(v) = item.as_float() {
        ensure!(v.is_finite(), "non-finite number");
        return Ok(json!(v));
    }
    if let Some(v) = item.as_datetime() {
        return Ok(json!(v.to_string()));
    }
    bail!("unsupported hook TOML value")
}
