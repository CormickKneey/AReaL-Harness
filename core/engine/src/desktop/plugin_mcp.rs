//! 安装摘要是信任边界；目录刷新不执行包，旧代只在所有已准入所有者排空后关闭。
use super::*;
use areal_mcp::{Connections, McpTool, PluginServerConfig};
use std::{collections::BTreeSet, ffi::OsString, path::PathBuf};
#[derive(Clone)]
pub(super) struct Generation {
    pub plugin: String,
    pub digest: String,
    pub tools: Vec<McpTool>,
    pub servers: Vec<areal_mcp::McpServer>,
    pub configs: BTreeMap<String, PluginServerConfig>,
}
struct Owned {
    view: Generation,
    connection: Connections,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connector {
    plugin: String,
    connector_id: String,
    digest: String,
    credential_ref: String,
}
impl Connector {
    fn credential_environment_key(&self) -> String {
        format!(
            "AREAL_PLUGIN_CONNECTOR_{}",
            server_id(&self.plugin, &self.connector_id).replace('-', "_")
        )
    }
    fn mcp_document(&self) -> Value {
        json!({"mcpServers":{"github":{"url":"https://api.githubcopilot.com/mcp/","bearer_token_env_var":self.credential_environment_key()}}})
    }
    fn private_input(
        &self,
        credentials: &BTreeMap<String, String>,
    ) -> Option<(OsString, OsString)> {
        credentials
            .get(&self.credential_ref)
            .map(|value| (self.credential_environment_key().into(), value.into()))
    }
}
pub(crate) struct Manager {
    live: std::sync::RwLock<BTreeMap<String, Generation>>,
    owners: Mutex<Vec<Owned>>,
    states: std::sync::RwLock<BTreeMap<String, String>>,
    server_states: std::sync::RwLock<BTreeMap<String, (String, BTreeMap<String, String>)>>,
    trusted: std::sync::RwLock<BTreeMap<String, String>>,
    connectors: std::sync::RwLock<BTreeMap<String, Connector>>,
    wire: std::sync::RwLock<BTreeMap<String, Value>>,
    operation: Mutex<()>,
    known: std::sync::RwLock<BTreeMap<u64, (String, bool)>>,
    watching: std::sync::atomic::AtomicBool,
    auth: areal_mcp::AuthManager,
}
impl Manager {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let load = |name: &str| -> anyhow::Result<Value> {
            let p = root.join("desktop").join(format!("{name}.json"));
            if p.exists() {
                let bytes = std::fs::read(p)?;
                anyhow::ensure!(bytes.len() <= 1024 * 1024, "plugin metadata too large");
                Ok(serde_json::from_slice(&bytes)?)
            } else {
                Ok(json!({}))
            }
        };
        Ok(Self {
            live: Default::default(),
            owners: Mutex::new(vec![]),
            states: Default::default(),
            server_states: Default::default(),
            trusted: std::sync::RwLock::new(serde_json::from_value(load("plugin-trust")?)?),
            connectors: std::sync::RwLock::new(serde_json::from_value(load("plugin-connectors")?)?),
            wire: Default::default(),
            operation: Mutex::new(()),
            known: Default::default(),
            watching: Default::default(),
            auth: areal_mcp::AuthManager::new(root.join("private/mcp-auth"), "plugins")?,
        })
    }
    pub fn tools(&self) -> Vec<McpTool> {
        self.live
            .read()
            .unwrap()
            .values()
            .flat_map(|g| g.tools.clone())
            .filter(|t| {
                serde_json::to_value(t.metadata()).is_ok_and(|v| {
                    v["_meta"]["ui"]["visibility"]
                        .as_array()
                        .is_none_or(|visibility| visibility.iter().any(|v| v == "model"))
                })
            })
            .collect()
    }
    pub(super) fn generations(&self) -> Vec<Generation> {
        self.live.read().unwrap().values().cloned().collect()
    }
    pub async fn shutdown(&self) -> Result<()> {
        let mut owners = self.owners.lock().await;
        let mut failed = false;
        for o in owners.iter_mut() {
            o.connection.revoke();
            failed |= o.connection.shutdown().await.is_err();
        }
        owners.clear();
        self.live.write().unwrap().clear();
        if failed {
            Err(invalid("plugin MCP cleanupUnknown"))
        } else {
            Ok(())
        }
    }
}
fn server_id(plugin: &str, name: &str) -> String {
    use sha2::Digest;
    format!(
        "p{}_{}",
        &format!(
            "{:x}",
            sha2::Sha256::digest(format!("{plugin}\0{name}").as_bytes())
        )[..16],
        name.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            })
            .take(14)
            .collect::<String>()
    )
}
fn app_declarations(c: &areal_plugins::InstalledComponents) -> Vec<Value> {
    let mut rows = vec![];
    for document in &c.app_documents {
        let apps = document.value.get("apps").unwrap_or(&document.value);
        let values = if let Some(array) = apps.as_array() {
            array.clone()
        } else if apps.get("id").is_some() {
            vec![apps.clone()]
        } else if let Some(object) = apps.as_object() {
            object
                .iter()
                .map(|(key, value)| {
                    let mut value = value.clone();
                    if value.is_object() && value.get("id").is_none() {
                        value["id"] = json!(key);
                    }
                    value
                })
                .collect()
        } else {
            vec![]
        };
        for value in values {
            if let Some(id) = value["id"].as_str() {
                let mut summary = json!({"id":id,"name":value["name"].as_str().unwrap_or(id)});
                for key in ["description", "installUrl", "category"] {
                    summary[key] = value
                        .get(key)
                        .cloned()
                        .filter(Value::is_string)
                        .unwrap_or(Value::Null);
                }
                rows.push(summary);
            }
        }
    }
    rows
}
fn connector_ids(c: &areal_plugins::InstalledComponents) -> Vec<String> {
    app_declarations(c)
        .iter()
        .filter_map(|v| v["id"].as_str().map(str::to_owned))
        .collect()
}

impl Engine {
    pub(super) fn initialize_plugin_wire(
        &self,
        store: &areal_plugins::Store,
    ) -> anyhow::Result<()> {
        *self.desktop.plugin_mcp.wire.write().unwrap() = wire_snapshot(store)?;
        Ok(())
    }
    pub async fn plugin_wire_list(&self, cwds: Option<Vec<PathBuf>>) -> Result<Value> {
        let store = self.plugin_store()?;
        let cwds = cwds.unwrap_or_default();
        tokio::task::spawn_blocking(move || {
            store
                .list_for_workspaces(&cwds)
                .and_then(|v| Ok(serde_json::to_value(v)?))
        })
        .await
        .map_err(invalid)?
        .map_err(invalid)
    }
    pub async fn plugin_reconcile_wire(&self) -> Result<Value> {
        self.refresh_plugins().await?;
        let store = self.plugin_store()?;
        let next = tokio::task::spawn_blocking(move || wire_snapshot(&store))
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
        let mut previous = self.desktop.plugin_mcp.wire.write().unwrap();
        let ids: BTreeSet<_> = previous.keys().chain(next.keys()).cloned().collect();
        let changed:Vec<_>=ids.into_iter().filter(|id|previous.get(id)!=next.get(id)).map(|id|json!({"id":id,"hasMcps":component_flag(previous.get(&id),next.get(&id),"mcp"),"hasApps":component_flag(previous.get(&id),next.get(&id),"apps"),"hasHooks":component_flag(previous.get(&id),next.get(&id),"hooks"),"hasSkills":component_flag(previous.get(&id),next.get(&id),"skills")})).collect();
        *previous = next;
        Ok(
            json!({"changedPlugins":changed,"failedRemotePluginIds":[],"failedMaterializationRemotePluginIds":[]}),
        )
    }
    pub async fn plugin_component_summary(&self, id: String) -> Result<Value> {
        let store = self.plugin_store()?;
        let component = tokio::task::spawn_blocking(move || {
            match store
                .installed_components()?
                .into_iter()
                .find(|c| c.id == id)
            {
                Some(c) => Ok(c),
                None => store.component_preview(&id),
            }
        })
        .await
        .map_err(invalid)?
        .map_err(invalid)?;
        let mut names = vec![];
        for document in &component.mcp_documents {
            let normalized = areal_mcp::normalize_plugin_document(
                document.portable,
                &document.value,
                &component.root,
                &component.data_root,
            )
            .map_err(|_| invalid("invalid MCP document"))?;
            names.extend(normalized.servers.into_keys());
        }
        let apps = app_declarations(&component);
        let apps_needing_auth: Vec<_> = apps
            .iter()
            .filter(|app| {
                app["id"].as_str().is_some_and(|id| {
                    matches!(
                        self.connector_state(&component.id, &component.digest, id),
                        "missingMapping" | "authRequired"
                    )
                })
            })
            .cloned()
            .collect();
        Ok(json!({"mcpServers":names,"apps":apps,"appsNeedingAuth":apps_needing_auth}))
    }
    fn component_configs(
        &self,
        c: &areal_plugins::InstalledComponents,
    ) -> Result<BTreeMap<String, PluginServerConfig>> {
        self.component_configuration(c).map(|(configs, _)| configs)
    }
    fn component_configuration(
        &self,
        c: &areal_plugins::InstalledComponents,
    ) -> Result<(BTreeMap<String, PluginServerConfig>, Vec<Value>)> {
        let mut result = BTreeMap::new();
        let mut diagnostics = vec![];
        for document in &c.mcp_documents {
            let normalized = areal_mcp::normalize_plugin_document(
                document.portable,
                &document.value,
                &c.root,
                &c.data_root,
            )
            .map_err(|_| invalid("invalid plugin MCP document"))?;
            diagnostics.extend(normalized.diagnostics.iter().map(|d| json!({"serverId":server_id(&c.id,&d.server),"server":d.server,"class":if normalized.servers.contains_key(&d.server){"policy"}else{"configuration"},"message":"MCP declaration has a host policy restriction or invalid configuration; inspect the trusted package"})));
            for (name, config) in normalized.servers {
                let name = server_id(&c.id, &name);
                if result.insert(name, config).is_some() {
                    return Err(invalid("duplicate plugin MCP server"));
                }
            }
        }
        let mappings = self.desktop.plugin_mcp.connectors.read().unwrap();
        for mapping in mappings
            .values()
            .filter(|m| m.plugin == c.id && m.digest == c.digest)
        {
            let config = mapping.mcp_document();
            let mut normalized =
                areal_mcp::normalize_plugin_document(false, &config, &c.root, &c.data_root)
                    .map_err(invalid)?;
            result.insert(
                server_id(&c.id, &mapping.connector_id),
                normalized
                    .servers
                    .remove("github")
                    .ok_or_else(|| invalid("GitHub adapter configuration rejected"))?,
            );
        }
        Ok((result, diagnostics))
    }
    pub(super) async fn plugin_component(
        &self,
        id: &str,
    ) -> Result<areal_plugins::InstalledComponents> {
        let store = self.plugin_store()?;
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            store
                .enabled_components()?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| anyhow::anyhow!("plugin disabled or uninstalled"))
        })
        .await
        .map_err(invalid)?
        .map_err(invalid)
    }
    pub(crate) async fn check_plugin_mcp(&self, tool: &McpTool) -> anyhow::Result<()> {
        let owner = self
            .desktop
            .plugin_mcp
            .known
            .read()
            .unwrap()
            .get(&tool.generation())
            .cloned();
        let Some((plugin, revoked)) = owner else {
            return Ok(());
        };
        anyhow::ensure!(!revoked, "plugin generation revoked");
        if self.plugin_component(&plugin).await.is_err() {
            self.revoke_plugin_mcp(&plugin).await?;
            anyhow::bail!("plugin disabled or uninstalled");
        }
        anyhow::ensure!(!tool.is_stale(), "plugin generation is revoked or stale");
        Ok(())
    }
    async fn revoke_plugin_mcp(&self, id: &str) -> Result<()> {
        self.desktop.plugin_mcp.live.write().unwrap().remove(id);
        self.desktop
            .plugin_mcp
            .server_states
            .write()
            .unwrap()
            .remove(id);
        for (plugin, revoked) in self.desktop.plugin_mcp.known.write().unwrap().values_mut() {
            if plugin == id {
                *revoked = true;
            }
        }
        let mut owners = self.desktop.plugin_mcp.owners.lock().await;
        for o in owners.iter().filter(|o| o.view.plugin == id) {
            o.connection.revoke();
        }
        let mut failed = false;
        let mut index = 0;
        while index < owners.len() {
            if owners[index].view.plugin == id {
                let mut owner = owners.remove(index);
                failed |= owner.connection.shutdown().await.is_err();
            } else {
                index += 1;
            }
        }
        self.desktop.plugin_mcp.states.write().unwrap().insert(
            id.into(),
            if failed {
                "cleanupUnknown"
            } else {
                "disconnected"
            }
            .into(),
        );
        if failed {
            Err(invalid("plugin MCP cleanupUnknown"))
        } else {
            Ok(())
        }
    }
    pub(super) async fn reconcile_plugin_connections(&self) -> Result<()> {
        let Some(store) = self.desktop.plugins.read().unwrap().store.clone() else {
            return Ok(());
        };
        let components = tokio::task::spawn_blocking(move || store.enabled_components())
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
        let current: BTreeMap<_, _> = components.into_iter().map(|c| (c.id, c.digest)).collect();
        let owners: BTreeSet<_> = self
            .desktop
            .plugin_mcp
            .owners
            .lock()
            .await
            .iter()
            .map(|o| o.view.plugin.clone())
            .collect();
        for id in owners {
            if !current.contains_key(&id) {
                self.revoke_plugin_mcp(&id).await?;
            }
        }
        self.desktop
            .plugin_mcp
            .live
            .write()
            .unwrap()
            .retain(|id, g| current.get(id) == Some(&g.digest));
        // 所有者扫描只读取已冻结的代；已受理旧工具在新包安装后仍可结算。
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        let mut active = BTreeSet::new();
        for cell in cells {
            let state = cell.state.lock().await;
            if let Some(a) = &state.active {
                if let Ok(registry) = &a.registry {
                    for generation in registry.mcp_generations() {
                        active.insert(generation);
                    }
                }
            }
        }
        active.extend(self.desktop.mcp_apps.generations());
        let live: BTreeSet<_> = self
            .desktop
            .plugin_mcp
            .generations()
            .iter()
            .flat_map(|g| g.servers.iter().map(|s| s.generation()))
            .collect();
        let mut owners = self.desktop.plugin_mcp.owners.lock().await;
        let mut index = 0;
        while index < owners.len() {
            if owners[index]
                .view
                .servers
                .iter()
                .all(|s| !live.contains(&s.generation()) && !active.contains(&s.generation()))
            {
                let mut o = owners.remove(index);
                if o.connection.shutdown().await.is_err() {
                    self.desktop
                        .plugin_mcp
                        .states
                        .write()
                        .unwrap()
                        .insert(o.view.plugin, "cleanupUnknown".into());
                    return Err(invalid("plugin MCP cleanupUnknown"));
                }
            } else {
                index += 1;
            }
        }
        Ok(())
    }
    pub async fn plugin_mcp_list(&self) -> Result<Value> {
        self.refresh_plugins().await?;
        let store = self.plugin_store()?;
        let components = tokio::task::spawn_blocking(move || store.installed_components())
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
        let mut rows = vec![];
        for c in components {
            let (configs, mut diagnostics) = self.component_configuration(&c)?;
            diagnostics.extend(c.diagnostics.iter().map(|d| json!(d)));
            let outcomes = self
                .desktop
                .plugin_mcp
                .server_states
                .read()
                .unwrap()
                .get(&c.id)
                .filter(|(digest, _)| digest == &c.digest)
                .map(|(_, states)| states.clone())
                .unwrap_or_default();
            diagnostics.extend(
                outcomes
                    .iter()
                    .filter(|(_, state)| {
                        !matches!(state.as_str(), "connected" | "disabled" | "disconnected")
                    })
                    .map(|(server, state)| json!({"serverId":server,"class":state})),
            );
            let live = self
                .desktop
                .plugin_mcp
                .live
                .read()
                .unwrap()
                .get(&c.id)
                .cloned();
            let state = self
                .desktop
                .plugin_mcp
                .states
                .read()
                .unwrap()
                .get(&c.id)
                .cloned()
                .unwrap_or_else(|| "disconnected".into());
            rows.push(json!({"pluginId":c.id,"installedDigest":c.digest,"state":state,"authenticationTiming":c.policy["authentication"],"trusted":self.desktop.plugin_mcp.trusted.read().unwrap().get(&c.id)==Some(&c.digest),"servers":configs.iter().map(|(name,cfg)|{
                let state=if !cfg.policy().enabled {"disabled"} else if live.as_ref().is_some_and(|g|g.servers.iter().any(|s|s.name()==name)){"connected"}else{match outcomes.get(name).map(String::as_str).unwrap_or("disconnected") {"startup"|"discovery"=>"failed","authentication"=>"authRequired",state=>state}};
                json!({"serverId":name,"state":state,"config":cfg.redacted_view(),"policy":cfg.policy(),"authenticationTiming":c.policy["authentication"],"authentication":if cfg.auth_policy().is_some(){"required"}else{"none"}})
            }).collect::<Vec<_>>(),"connectors":connector_ids(&c).iter().map(|id|json!({"id":id,"state":self.connector_state(&c.id,&c.digest,id)})).collect::<Vec<_>>(),"diagnostics":diagnostics}));
        }
        Ok(json!({"data":rows}))
    }
    pub async fn plugin_connection(
        self: &Arc<Self>,
        id: String,
        expected_digest: String,
        connect: bool,
    ) -> Result<Value> {
        let _operation = self.desktop.plugin_mcp.operation.lock().await;
        let component = self.plugin_component(&id).await?;
        if component.digest != expected_digest {
            return Err(Error::Conflict);
        }
        if !connect {
            self.revoke_plugin_mcp(&id).await?;
            self.desktop.plugin_mcp.trusted.write().unwrap().remove(&id);
            let trusted = self.desktop.plugin_mcp.trusted.read().unwrap().clone();
            self.store
                .save_metadata("plugin-trust", &trusted)
                .await
                .map_err(invalid)?;
            return self.plugin_mcp_list().await;
        }
        if self
            .desktop
            .plugin_mcp
            .states
            .read()
            .unwrap()
            .get(&id)
            .is_some_and(|s| s == "cleanupUnknown")
        {
            return Err(invalid("previous plugin cleanup remains UNKNOWN"));
        }
        // Explicit Connect is also retry/reauth: new handles replace discovery,
        // while admitted Turns and Apps retain the previous generation until drain.
        // Automatic trusted admission separately skips already-live digests.
        let (configs, configuration_diagnostics) = self.component_configuration(&component)?;
        if configs.keys().any(|name| {
            self.extensions.mcp_servers.contains_key(name)
                || self.desktop.mcp.contains_definition(name)
        }) {
            return Err(invalid(
                "plugin MCP server ID is owned by deployment or manual configuration",
            ));
        }
        if configs.is_empty() {
            return Err(invalid(if component.app_documents.is_empty() {
                "plugin has no MCP servers"
            } else {
                "connector missingMapping"
            }));
        }
        if self
            .desktop
            .plugin_mcp
            .known
            .read()
            .unwrap()
            .len()
            .saturating_add(configs.len())
            > 8192
        {
            return Err(invalid("plugin generation capacity reached"));
        }
        let mut options = areal_mcp::ConnectionOptions::default();
        let mut eligible = BTreeMap::new();
        let mut outcomes = BTreeMap::<String, String>::new();
        for (server, config) in &configs {
            if !config.policy().enabled {
                outcomes.insert(server.clone(), "disabled".into());
                continue;
            }
            if let Some(policy) = config.auth_policy() {
                let credential = if policy.is_supported() {
                    self.desktop
                        .plugin_mcp
                        .auth
                        .ready_credential(&format!("{server}/{}", component.digest))
                        .await
                        .ok()
                } else {
                    None
                };
                if let Some(credential) = credential {
                    options.credentials.insert(server.clone(), credential);
                } else {
                    let state = if policy.is_supported() {
                        "authRequired"
                    } else {
                        "unsupported"
                    };
                    outcomes.insert(server.clone(), state.into());
                    if config.policy().required {
                        self.desktop
                            .plugin_mcp
                            .server_states
                            .write()
                            .unwrap()
                            .insert(id.clone(), (component.digest.clone(), outcomes));
                        self.desktop
                            .plugin_mcp
                            .states
                            .write()
                            .unwrap()
                            .insert(id.clone(), "authRequired".into());
                        return Err(invalid(format!("required plugin MCP {state}")));
                    }
                    continue;
                }
            }
            eligible.insert(server.clone(), config.clone());
        }
        let mappings: Vec<_> = self
            .desktop
            .plugin_mcp
            .connectors
            .read()
            .unwrap()
            .values()
            .filter(|m| m.plugin == id && m.digest == expected_digest)
            .cloned()
            .collect();
        let mut env: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
        for mapping in mappings {
            let server = server_id(&id, &mapping.connector_id);
            if !eligible.contains_key(&server) {
                continue;
            }
            let input = mapping.private_input(&self.desktop.credentials.read().unwrap());
            let Some((key, credential)) = input else {
                outcomes.insert(server.clone(), "authRequired".into());
                eligible.remove(&server);
                continue;
            };
            env.insert(key, credential);
        }
        let (broker, receiver) = areal_mcp::ElicitationBroker::channel();
        options.elicitation = Some(broker);
        let mut connection = Connections::connect_plugins_with_options(
            &eligible,
            &options,
            &env,
            &component.root,
            self.shutdown.child_token(),
        )
        .await
        .map_err(|error| {
            let state = if error
                .chain()
                .any(|e| e.to_string() == "MCP cleanup unconfirmed")
            {
                "cleanupUnknown"
            } else {
                "failed"
            };
            for server in eligible.keys() {
                outcomes.insert(server.clone(), state.into());
            }
            self.desktop
                .plugin_mcp
                .server_states
                .write()
                .unwrap()
                .insert(id.clone(), (component.digest.clone(), outcomes.clone()));
            self.desktop
                .plugin_mcp
                .states
                .write()
                .unwrap()
                .insert(id.clone(), state.into());
            invalid("plugin MCP required connection failed; inspect redacted server states")
        })?;
        for failure in connection.failures() {
            outcomes.insert(failure.server.clone(), failure.class.into());
        }
        for server in connection.servers() {
            outcomes.insert(server.name().into(), "connected".into());
        }
        let has_configuration_failures = configuration_diagnostics
            .iter()
            .any(|d| d["class"] == "configuration");
        let has_failures = has_configuration_failures
            || outcomes
                .values()
                .any(|s| !matches!(s.as_str(), "connected" | "disabled"));
        self.desktop
            .plugin_mcp
            .server_states
            .write()
            .unwrap()
            .insert(id.clone(), (component.digest.clone(), outcomes.clone()));
        if connection.servers().is_empty() {
            let state = if configs.values().all(|c| !c.policy().enabled) {
                "disabled"
            } else if outcomes.values().any(|s| {
                matches!(
                    s.as_str(),
                    "authRequired" | "unsupported" | "authentication"
                )
            }) {
                "authRequired"
            } else {
                "failed"
            };
            self.desktop
                .plugin_mcp
                .states
                .write()
                .unwrap()
                .insert(id.clone(), state.into());
            return self.plugin_mcp_list().await;
        }
        if self
            .plugin_component(&id)
            .await
            .map_or(true, |c| c.digest != expected_digest)
        {
            if connection.shutdown().await.is_err() {
                self.desktop
                    .plugin_mcp
                    .states
                    .write()
                    .unwrap()
                    .insert(id, "cleanupUnknown".into());
                return Err(invalid("plugin changed during connect; cleanupUnknown"));
            }
            return Err(Error::Conflict);
        }
        let tools = connection.tools();
        let mut combined = self.desktop.mcp.tools();
        combined.extend(
            self.desktop
                .plugin_mcp
                .tools()
                .into_iter()
                .filter(|t| !configs.contains_key(t.server_name())),
        );
        combined.extend(tools.clone());
        if self.registry.clone().with_mcp(combined).is_err() {
            if connection.shutdown().await.is_err() {
                self.desktop
                    .plugin_mcp
                    .states
                    .write()
                    .unwrap()
                    .insert(id, "cleanupUnknown".into());
                return Err(invalid("plugin MCP cleanupUnknown"));
            }
            return Err(invalid(
                "plugin MCP directory conflicts or exceeds tool budget",
            ));
        }
        let generation = Generation {
            plugin: id.clone(),
            digest: expected_digest.clone(),
            tools,
            servers: connection.servers(),
            configs,
        };
        for server in &generation.servers {
            self.desktop
                .plugin_mcp
                .known
                .write()
                .unwrap()
                .insert(server.generation(), (id.clone(), false));
            self.spawn_mcp_resource_updates(server.clone());
        }
        self.desktop.plugin_mcp.owners.lock().await.push(Owned {
            view: generation.clone(),
            connection,
        });
        self.desktop
            .plugin_mcp
            .live
            .write()
            .unwrap()
            .insert(id.clone(), generation);
        self.desktop
            .plugin_mcp
            .trusted
            .write()
            .unwrap()
            .insert(id.clone(), expected_digest);
        let trusted = self.desktop.plugin_mcp.trusted.read().unwrap().clone();
        self.store
            .save_metadata("plugin-trust", &trusted)
            .await
            .map_err(invalid)?;
        self.desktop.plugin_mcp.states.write().unwrap().insert(
            id,
            if has_failures { "partial" } else { "connected" }.into(),
        );
        self.spawn_mcp_forms(receiver);
        self.watch_plugin_mcp();
        self.plugin_mcp_list().await
    }
    pub async fn plugin_auth(
        self: &Arc<Self>,
        id: String,
        server: String,
        operation: String,
    ) -> Result<Value> {
        let c = self.plugin_component(&id).await?;
        let configs = self.component_configs(&c)?;
        let cfg = configs.get(&server).ok_or(Error::NotFound)?;
        let auth = &self.desktop.plugin_mcp.auth;
        let auth_key = format!("{server}/{}", c.digest);
        match operation.as_str() {
            "start" => {
                let policy = cfg
                    .auth_policy()
                    .ok_or_else(|| invalid("authentication unsupported"))?;
                let endpoint = cfg
                    .endpoint()
                    .ok_or_else(|| invalid("authentication unsupported"))?;
                serde_json::to_value(
                    auth.start(&auth_key, endpoint, policy, None)
                        .await
                        .map_err(|_| invalid("authentication failed"))?,
                )
                .map_err(invalid)
            }
            "status" => Ok(serde_json::to_value(auth.status(&auth_key).await).map_err(invalid)?),
            "cancel" => {
                auth.cancel(&auth_key).await;
                Ok(json!({"status":"cancelled"}))
            }
            _ => Err(invalid("unsupported authentication operation")),
        }
    }
    pub async fn connector_configure(
        self: &Arc<Self>,
        id: String,
        connector_id: String,
        provider: String,
        credential_ref: String,
        expected_digest: String,
    ) -> Result<Value> {
        let c = self.plugin_component(&id).await?;
        if c.digest != expected_digest {
            return Err(Error::Conflict);
        }
        if provider != "github" {
            return Err(invalid("connector provider unsupported"));
        }
        if !connector_ids(&c).contains(&connector_id) {
            return Err(invalid(
                "connector missingMapping: original App ID is not declared",
            ));
        }
        if !valid_id(&credential_ref) {
            return Err(invalid("invalid credential reference"));
        }
        let _guard = self.desktop.plugin_mcp.operation.lock().await;
        if self
            .desktop
            .plugin_mcp
            .live
            .read()
            .unwrap()
            .contains_key(&id)
        {
            return Err(invalid(
                "disconnect plugin before changing connector mapping",
            ));
        }
        self.desktop.plugin_mcp.connectors.write().unwrap().insert(
            format!("{id}/{connector_id}"),
            Connector {
                plugin: id.clone(),
                connector_id: connector_id.clone(),
                digest: expected_digest,
                credential_ref,
            },
        );
        let mappings = self.desktop.plugin_mcp.connectors.read().unwrap().clone();
        self.store
            .save_metadata("plugin-connectors", &mappings)
            .await
            .map_err(invalid)?;
        Ok(json!({"pluginId":id,"connectorId":connector_id,"provider":provider,"state":"mapped"}))
    }
    pub(super) async fn plugin_server(
        &self,
        id: &str,
        generation: u64,
    ) -> Result<(Generation, areal_mcp::McpServer)> {
        let found = {
            let owners = self.desktop.plugin_mcp.owners.lock().await;
            owners.iter().find_map(|o| {
                o.view
                    .servers
                    .iter()
                    .find(|s| s.name() == id && s.generation() == generation)
                    .map(|s| (o.view.clone(), s.clone()))
            })
        }
        .ok_or(Error::NotFound)?;
        if self.plugin_component(&found.0.plugin).await.is_err() {
            self.revoke_plugin_mcp(&found.0.plugin).await?;
            return Err(invalid("plugin disabled or uninstalled"));
        }
        if found.1.is_revoked() {
            return Err(invalid("server generation revoked"));
        }
        Ok(found)
    }
}
fn wire_snapshot(store: &areal_plugins::Store) -> anyhow::Result<BTreeMap<String, Value>> {
    Ok(store.list()?.data.into_iter().filter(|p|p.installed).map(|p|(p.id.clone(),json!({"id":p.id,"digest":p.installed_digest,"enabled":p.enabled,"components":p.components}))).collect())
}
impl Engine {
    fn watch_plugin_mcp(self: &Arc<Self>) {
        if self
            .desktop
            .plugin_mcp
            .watching
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let weak = Arc::downgrade(self);
        let cancel = self.shutdown.clone();
        self.tasks.spawn(async move{loop{
            tokio::select!{_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(250))=>{}}
            let Some(engine)=weak.upgrade()else{break;};if let Err(error)=engine.reconcile_plugin_connections().await{tracing::warn!(%error,"plugin MCP reconciliation failed closed");}
        }});
    }
    pub(crate) async fn mcp_output_limit(&self, tool: &McpTool) -> Option<usize> {
        let owners = self.desktop.plugin_mcp.owners.lock().await;
        owners
            .iter()
            .find(|o| {
                o.view
                    .servers
                    .iter()
                    .any(|s| s.generation() == tool.generation())
            })
            .and_then(|o| o.view.configs.get(tool.server_name()))
            .and_then(|c| c.policy().tools.get(tool.original_name()))
            .and_then(|p| p.output_token_limit)
            .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
    }
    pub(crate) async fn connect_trusted_plugins(self: &Arc<Self>, thread_id: &str) -> Result<()> {
        let cell = self.cell(thread_id).await?;
        let state = cell.state.lock().await;
        let config = desktop(&state.thread).configuration;
        if state.active.is_some() || state.compacting {
            return Ok(());
        }
        if state.thread.is_side()
            || cell.research
            || state.thread.parent_thread_id.is_some()
            || cell.exclusive_writer
            || !config.allow_plugin_skills
            || config.read_only
        {
            return Ok(());
        }
        drop(state);
        let store = match self.plugin_store() {
            Ok(s) => s,
            Err(_) => return Ok(()),
        };
        let components = tokio::task::spawn_blocking(move || store.enabled_components())
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
        for c in components {
            let trusted =
                self.desktop.plugin_mcp.trusted.read().unwrap().get(&c.id) == Some(&c.digest);
            let connected = self
                .desktop
                .plugin_mcp
                .live
                .read()
                .unwrap()
                .contains_key(&c.id);
            if trusted && !connected && !c.mcp_documents.is_empty() {
                self.plugin_connection(c.id, c.digest, true).await?;
            }
        }
        Ok(())
    }
}
fn component_flag(old: Option<&Value>, new: Option<&Value>, component: &str) -> bool {
    [old, new].into_iter().flatten().any(|v| {
        v["components"].as_array().is_some_and(|values| {
            values.iter().any(|v| {
                v.as_str()
                    .is_some_and(|s| s == component || component == "mcp" && s == "mcpServers")
            })
        })
    })
}
impl Engine {
    pub(crate) async fn plugin_mcp_instructions(&self, cell: &Cell) -> Vec<Value> {
        let generations = cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .and_then(|a| a.registry.as_ref().ok())
            .map(|r| r.mcp_generations())
            .unwrap_or_default();
        self.desktop.plugin_mcp.owners.lock().await.iter().flat_map(|o|o.view.servers.iter()).filter(|s|generations.contains(&s.generation())).filter_map(|s|s.info().instructions.as_ref().map(|v|json!({"serverId":s.name(),"instructions":v.chars().take(65536).collect::<String>()}))).collect()
    }
}
impl Engine {
    fn connector_state(&self, plugin: &str, digest: &str, id: &str) -> &'static str {
        let mapping = self
            .desktop
            .plugin_mcp
            .connectors
            .read()
            .unwrap()
            .get(&format!("{plugin}/{id}"))
            .cloned();
        let Some(mapping) = mapping.filter(|m| m.digest == digest) else {
            return "missingMapping";
        };
        if !self
            .desktop
            .credentials
            .read()
            .unwrap()
            .contains_key(&mapping.credential_ref)
        {
            return "authRequired";
        }
        if self
            .desktop
            .plugin_mcp
            .live
            .read()
            .unwrap()
            .get(plugin)
            .is_some_and(|g| {
                g.digest == digest
                    && g.servers
                        .iter()
                        .any(|server| server.name() == server_id(plugin, id))
            })
        {
            "connected"
        } else {
            "mapped"
        }
    }
}

#[cfg(test)]
mod connector_input_tests {
    use super::*;
    #[test]
    fn connector_transport_inputs_do_not_cross_accounts() {
        let first = Connector {
            plugin: "multi@apps".into(),
            connector_id: "opaque-one".into(),
            digest: "digest".into(),
            credential_ref: "first-ref".into(),
        };
        let second = Connector {
            connector_id: "opaque-two".into(),
            credential_ref: "second-ref".into(),
            ..first.clone()
        };
        let credentials = BTreeMap::from([
            ("first-ref".into(), "synthetic-account-one".into()),
            ("second-ref".into(), "synthetic-account-two".into()),
        ]);
        let inputs: BTreeMap<OsString, OsString> = [
            first.private_input(&credentials).unwrap(),
            second.private_input(&credentials).unwrap(),
        ]
        .into();
        for connector in [&first, &second] {
            let document = connector.mcp_document();
            let key = OsString::from(
                document["mcpServers"]["github"]["bearer_token_env_var"]
                    .as_str()
                    .unwrap(),
            );
            assert!(
                inputs.get(&key) == Some(&OsString::from(&credentials[&connector.credential_ref])),
                "connector resolves another account's credential"
            );
            let normalized = areal_mcp::normalize_plugin_document(
                false,
                &document,
                Path::new("/tmp"),
                Path::new("/tmp"),
            )
            .unwrap();
            let public = normalized.servers["github"].redacted_view().to_string();
            assert!(credentials.values().all(|value| !public.contains(value)));
        }
        assert_eq!(inputs.len(), 2);
    }
}
