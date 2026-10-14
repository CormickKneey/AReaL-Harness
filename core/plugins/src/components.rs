use crate::{Store, package};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::path::PathBuf;

/// 内部输入可以含凭据，禁止作为管理 API 的 JSON 投影。
#[derive(Clone, Debug)]
pub struct ComponentDocument {
    pub portable: bool,
    pub origin: String,
    pub value: Value,
}
#[derive(Clone, Debug)]
pub struct InstalledComponents {
    pub id: String,
    pub root: PathBuf,
    pub data_root: PathBuf,
    pub digest: String,
    pub mcp_documents: Vec<ComponentDocument>,
    pub hook_documents: Vec<ComponentDocument>,
    pub app_documents: Vec<ComponentDocument>,
    pub policy: Value,
    pub diagnostics: Vec<String>,
}
impl Store {
    pub fn installed_components(&self) -> Result<Vec<InstalledComponents>> {
        self.components(false)
    }
    pub fn enabled_components(&self) -> Result<Vec<InstalledComponents>> {
        self.components(true)
    }
    fn components(&self, enabled_only: bool) -> Result<Vec<InstalledComponents>> {
        let state = self.state()?;
        state
            .installed
            .values()
            .filter(|d| !enabled_only || self.enabled(&state, &d.id))
            .map(|detail| {
                self.read_components(
                    detail,
                    self.root.join("cache").join(&detail.source_digest),
                    state
                        .installed_policies
                        .get(&detail.id)
                        .cloned()
                        .unwrap_or(Value::Null),
                )
            })
            .collect()
    }
    pub fn component_preview(&self, id: &str) -> Result<InstalledComponents> {
        let state = self.state()?;
        let (_, details, _) = self.catalogs(&state);
        let detail = details
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| anyhow::anyhow!("plugin source unavailable"))?;
        ensure!(
            !detail.source_digest.is_empty(),
            "remote component preview requires explicit source resolution"
        );
        let root = state
            .candidates
            .get(id)
            .filter(|c| c.detail.source_digest == detail.source_digest)
            .map(|c| c.root.clone())
            .unwrap_or_else(|| detail.source.clone());
        self.read_components(&detail, root, detail.policy.clone())
    }
    fn read_components(
        &self,
        detail: &crate::PluginDetail,
        root: PathBuf,
        policy: Value,
    ) -> Result<InstalledComponents> {
        let files = package::snapshot(&root)?;
        ensure!(
            package::digest(&files) == detail.source_digest,
            "installed package integrity mismatch: {}",
            detail.id
        );
        package::parse(&files, &detail.id, &detail.source, &root)?;
        let read = |path: &str| {
            files
                .get(path)
                .and_then(|f| serde_json::from_slice::<Value>(&f.bytes).ok())
        };
        let manifest = read("plugin.json");
        let portable = manifest
            .as_ref()
            .and_then(|v| v["$schema"].as_str())
            .is_some_and(|s| s.contains("agent-plugins.org/"));
        let inline = manifest
            .as_ref()
            .and_then(|v| v.pointer("/extensions/com.openai"))
            .filter(|v| v.is_object());
        let legacy = [
            ".codex-plugin/plugin.json",
            ".claude-plugin/plugin.json",
            ".cursor-plugin/plugin.json",
        ]
        .into_iter()
        .find(|p| files.contains_key(*p))
        .and_then(read);
        let overlay = if portable {
            inline.or(legacy.as_ref())
        } else {
            legacy.as_ref()
        };
        let mut result = InstalledComponents {
            id: detail.id.clone(),
            root,
            data_root: self.root.join("data").join(&detail.id),
            digest: detail.source_digest.clone(),
            mcp_documents: vec![],
            hook_documents: vec![],
            app_documents: vec![],
            policy,
            diagnostics: vec![],
        };
        let mut load = |declaration: Option<&Value>,
                        default: &str,
                        target: &mut Vec<ComponentDocument>| {
            fn one(
                value: &Value,
                default: &str,
                files: &package::Files,
                portable: bool,
                target: &mut Vec<ComponentDocument>,
                diagnostics: &mut Vec<String>,
            ) {
                match value {
                    Value::Object(_) => target.push(ComponentDocument {
                        portable,
                        origin: "manifest".into(),
                        value: value.clone(),
                    }),
                    Value::Array(values) => {
                        for v in values {
                            one(v, default, files, portable, target, diagnostics);
                        }
                    }
                    Value::String(path) => {
                        match package::relative(path).and_then(|path| {
                            let bytes = files
                                .get(&path)
                                .ok_or_else(|| anyhow::anyhow!("missing component document"))?;
                            let value: Value = serde_json::from_slice(&bytes.bytes)?;
                            ensure!(
                                value.is_object() || (default == ".app.json" && value.is_array()),
                                "component document must be an object"
                            );
                            Ok(ComponentDocument {
                                portable,
                                origin: path,
                                value,
                            })
                        }) {
                            Ok(v) => target.push(v),
                            Err(_) => diagnostics.push(format!(
                                "{default}: invalid or missing component document: {path}"
                            )),
                        }
                    }
                    _ => diagnostics.push(format!("{default}: invalid component declaration")),
                }
            }
            if let Some(v) = declaration {
                one(
                    v,
                    default,
                    &files,
                    portable,
                    target,
                    &mut result.diagnostics,
                );
            } else if files.contains_key(default) {
                one(
                    &Value::String(default.into()),
                    default,
                    &files,
                    portable,
                    target,
                    &mut result.diagnostics,
                );
            }
        };
        load(
            if portable {
                None
            } else {
                overlay.and_then(|v| v.get("mcpServers"))
            },
            if portable { "mcp.json" } else { ".mcp.json" },
            &mut result.mcp_documents,
        );
        load(
            overlay.and_then(|v| v.get("apps")),
            ".app.json",
            &mut result.app_documents,
        );
        if detail.components.iter().any(|v| v == "hooks") {
            result.diagnostics.push("hooks: declarations do not execute during discovery; explicit hook definition trust is required".into());
        }
        result.hook_documents = crate::hooks::discover(
            overlay.and_then(|v| v.get("hooks")),
            &files,
            portable,
            &mut result.diagnostics,
        );
        Ok(result)
    }
}
