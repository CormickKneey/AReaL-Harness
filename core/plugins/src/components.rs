use crate::{Store, package};
use anyhow::{Context, Result, ensure};
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
/// One atomic state-file read for publishing an activation directory. Package
/// bytes remain immutable; concurrent commits cannot mix selection revisions.
pub struct InstalledSnapshot {
    pub retained_skills: Vec<crate::InstalledSkill>,
    pub enabled_skills: Vec<crate::InstalledSkill>,
    pub enabled_ids: std::collections::BTreeSet<String>,
    pub components: Vec<InstalledComponents>,
}
impl Store {
    pub fn installed_snapshot(&self) -> Result<InstalledSnapshot> {
        let state = self.state()?;
        let enabled_ids: std::collections::BTreeSet<_> = state
            .installed
            .keys()
            .filter(|id| self.enabled(&state, id))
            .cloned()
            .collect();
        let enabled_skills = state
            .installed
            .iter()
            .filter(|(id, _)| enabled_ids.contains(*id))
            .flat_map(|(_, detail)| detail.skills.clone())
            .collect();
        let components = state
            .installed
            .values()
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
            .collect::<Result<_>>()?;
        Ok(InstalledSnapshot {
            retained_skills: state.history,
            enabled_skills,
            enabled_ids,
            components,
        })
    }
    pub fn installed_components(&self) -> Result<Vec<InstalledComponents>> {
        self.components(false)
    }
    pub fn enabled_components(&self) -> Result<Vec<InstalledComponents>> {
        self.components(true)
    }
    /// Validate only the selected package. Unrelated packages do not enter a tool's
    /// authorization hot path; metadata changes still force full integrity checks.
    pub fn enabled_component(&self, id: &str) -> Result<InstalledComponents> {
        let state = self.state()?;
        ensure!(self.enabled(&state, id), "plugin disabled or uninstalled");
        let detail = state.installed.get(id).context("plugin not installed")?;
        self.read_components(
            detail,
            self.root.join("cache").join(&detail.source_digest),
            state
                .installed_policies
                .get(id)
                .cloned()
                .unwrap_or(Value::Null),
        )
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
        let fingerprint = package::fingerprint(&root)?;
        if let Some((previous, component)) = self.component_cache.lock().unwrap().get(&detail.id)
            && previous == &fingerprint
            && component.root == root
            && component.digest == detail.source_digest
            && component.policy == policy
        {
            return Ok(component.clone());
        }
        #[cfg(test)]
        self.component_reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
        ensure!(
            package::fingerprint(&result.root)? == fingerprint,
            "package changed during component validation"
        );
        self.component_cache
            .lock()
            .unwrap()
            .insert(detail.id.clone(), (fingerprint, result.clone()));
        Ok(result)
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, sync::atomic::Ordering};

    #[test]
    fn unchanged_component_refresh_reuses_content_but_tampering_invalidates() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join(".agents/plugins")).unwrap();
        fs::create_dir_all(t.path().join("pkg/.codex-plugin")).unwrap();
        fs::write(
            t.path().join(".agents/plugins/marketplace.json"),
            r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
        )
        .unwrap();
        fs::write(
            t.path().join("pkg/.codex-plugin/plugin.json"),
            r#"{"name":"sample"}"#,
        )
        .unwrap();
        fs::write(t.path().join("pkg/asset"), vec![b'a'; 1024 * 1024]).unwrap();
        let store = Store::open(t.path().join("plugins"), t.path().into(), None).unwrap();
        let d = store.read("sample@local").unwrap();
        store
            .install(&d.id, "user", d.revision, &d.source, &d.source_digest)
            .unwrap();
        for _ in 0..5 {
            assert_eq!(store.enabled_components().unwrap().len(), 1);
        }
        assert_eq!(
            store.component_reads.load(Ordering::Relaxed),
            1,
            "unchanged refresh reread package bytes"
        );
        let path = store
            .root
            .join("cache")
            .join(&d.source_digest)
            .join("asset");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(&path, vec![b'b'; 1024 * 1024]).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(
            store.enabled_components().is_err(),
            "same-size modified asset reused trusted cache"
        );
    }
}
