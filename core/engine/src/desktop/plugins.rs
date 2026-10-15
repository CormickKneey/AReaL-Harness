//! Plugin packages supply immutable Skill roots; execution stays in the normal Engine loop.
use super::skills::Skill;
use super::*;
use std::{collections::BTreeSet, path::PathBuf};
#[derive(Default)]
pub(super) struct Manager {
    pub(super) store: Option<Arc<areal_plugins::Store>>,
    pub(super) enabled: Vec<areal_plugins::InstalledSkill>,
    pub(super) enabled_plugin_ids: BTreeSet<String>,
}
fn store_error(e: anyhow::Error) -> Error {
    match e.downcast_ref::<areal_plugins::StoreError>() {
        Some(areal_plugins::StoreError::Conflict { .. }) => Error::Conflict,
        Some(areal_plugins::StoreError::NotFound(_)) => Error::NotFound,
        Some(areal_plugins::StoreError::SourceChanged { .. }) => {
            invalid(format!("PLUGIN_SOURCE_CHANGED: {e}"))
        }
        None => invalid(format!("{e:#}")),
    }
}
struct Snapshot {
    skills: Vec<Skill>,
    enabled: Vec<areal_plugins::InstalledSkill>,
    enabled_plugin_ids: BTreeSet<String>,
    hooks: Vec<crate::plugin_hooks::BoundHook>,
    hook_enabled: HashSet<String>,
    hook_sources: Vec<areal_plugins::hook_sources::HookSource>,
}
fn snapshot(
    store: &areal_plugins::Store,
    config: Option<(PathBuf, Option<PathBuf>)>,
) -> anyhow::Result<Snapshot> {
    // Current discovery and retained-reference revocation have different lifetimes.
    // An enabled replacement may remove every skill; its old admitted refs still live.
    let installed = store.installed_snapshot()?;
    let enabled = installed.enabled_skills;
    let retained = installed.retained_skills;
    let enabled_plugin_ids = installed.enabled_ids;
    let skills = retained
        .into_iter()
        .map(Skill::load_plugin)
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut hook_enabled: HashSet<_> = enabled_plugin_ids.iter().cloned().collect();
    let components = installed.components;
    let mut hooks: Vec<_> = components
        .iter()
        .map(crate::plugin_hooks::bind)
        .collect::<anyhow::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    let hook_sources = if let Some((home, path)) = config {
        areal_plugins::hook_sources::configuration_sources(
            &home,
            store.workspace(),
            path.as_deref(),
        )?
    } else {
        vec![]
    };
    if hook_sources.first().is_some_and(|s| !s.enabled) {
        hook_enabled.clear();
    }
    for source in &hook_sources {
        if source.enabled {
            hook_enabled.insert(source.id.clone());
        }
        hooks.extend(crate::plugin_hooks::bind_source(source));
    }
    Ok(Snapshot {
        hooks,
        hook_enabled,
        hook_sources,
        skills,
        enabled,
        enabled_plugin_ids,
    })
}

impl Engine {
    /// Trusted synchronous startup only. Runtime filesystem work uses spawn_blocking.
    pub fn install_plugin_store(
        self: &Arc<Self>,
        store: Arc<areal_plugins::Store>,
    ) -> anyhow::Result<()> {
        self.initialize_plugin_wire(&store)?;
        self.register_plugin_snapshot(snapshot(
            &store,
            self.plugin_hooks.source_config.get().cloned(),
        )?);
        self.desktop.plugins.write().unwrap().store = Some(store);
        self.watch_plugin_state();
        Ok(())
    }
    fn register_plugin_snapshot(&self, snapshot: Snapshot) {
        *self.plugin_hooks.sources.write().unwrap() = snapshot.hook_sources;
        self.plugin_hooks
            .publish(snapshot.hooks, snapshot.hook_enabled);
        let mut catalog = self.desktop.catalog.write().unwrap();
        for skill in snapshot.skills {
            catalog
                .skills
                .entry(format!("{}/{}", skill.location.id, skill.location.revision))
                .or_insert(skill);
        }
        let mut manager = self.desktop.plugins.write().unwrap();
        manager.enabled = snapshot.enabled;
        manager.enabled_plugin_ids = snapshot.enabled_plugin_ids;
    }
    pub(crate) fn plugin_store(&self) -> Result<Arc<areal_plugins::Store>> {
        self.desktop
            .plugins
            .read()
            .unwrap()
            .store
            .clone()
            .ok_or_else(|| invalid("plugin store unavailable"))
    }
    pub(crate) async fn refresh_plugins(&self) -> Result<()> {
        let Some(store) = self.desktop.plugins.read().unwrap().store.clone() else {
            return Ok(());
        };
        let _refresh = self.desktop.plugin_refresh.lock().await;
        let config = self.plugin_hooks.source_config.get().cloned();
        let snapshot = tokio::task::spawn_blocking(move || snapshot(&store, config))
            .await
            .map_err(invalid)?
            .map_err(store_error)?;
        self.register_plugin_snapshot(snapshot);
        drop(_refresh);
        self.reconcile_plugin_connections().await?;
        Ok(())
    }
    pub(super) async fn check_plugin_skill(&self, skill: &Skill) -> Result<()> {
        if let Some(info) = &skill.plugin {
            let store = self.plugin_store()?;
            let (id, revision) = (info.id.clone(), info.revision.clone());
            if !tokio::task::spawn_blocking(move || store.is_skill_enabled(&id, &revision))
                .await
                .map_err(invalid)?
                .map_err(store_error)?
            {
                return Err(invalid("plugin skill is disabled or uninstalled"));
            }
        }
        Ok(())
    }
    pub async fn plugin_list(&self) -> Result<Value> {
        self.refresh_plugins().await?;
        let store = self.plugin_store()?;
        tokio::task::spawn_blocking(move || store.list().and_then(|v| Ok(serde_json::to_value(v)?)))
            .await
            .map_err(invalid)?
            .map_err(store_error)
    }
    pub async fn plugin_read(&self, id: String) -> Result<Value> {
        self.refresh_plugins().await?;
        let store = self.plugin_store()?;
        tokio::task::spawn_blocking(move || {
            store.read(&id).and_then(|v| Ok(serde_json::to_value(v)?))
        })
        .await
        .map_err(invalid)?
        .map_err(store_error)
    }
    async fn plugin_change<F>(self: &Arc<Self>, change: F) -> Result<Value>
    where
        F: FnOnce(&areal_plugins::Store) -> anyhow::Result<Value> + Send + 'static,
    {
        let store = self.plugin_store()?;
        self.mutate(move |engine| async move {
            // Store owns the short cross-process CAS. Fetch/preparation must not
            // hold Engine publication locks needed by disable and hook revocation.
            let result = tokio::task::spawn_blocking(move || change(&store))
                .await
                .map_err(invalid)?
                .map_err(store_error)?;
            engine.refresh_plugins().await?;
            Ok(result)
        })
        .await
    }
    pub async fn plugin_add_marketplace(
        self: &Arc<Self>,
        root: PathBuf,
        expected: u64,
    ) -> Result<Value> {
        self.plugin_change(move |s| Ok(serde_json::to_value(s.add_marketplace(&root, expected)?)?))
            .await
    }
    pub async fn plugin_install(
        self: &Arc<Self>,
        id: String,
        scope: String,
        expected: u64,
        source: PathBuf,
        digest: String,
    ) -> Result<Value> {
        self.plugin_change(move |s| {
            Ok(serde_json::to_value(
                s.install(&id, &scope, expected, &source, &digest)?,
            )?)
        })
        .await
    }
    pub async fn plugin_resolve(self: &Arc<Self>, id: String, expected: u64) -> Result<Value> {
        self.plugin_change(move |s| Ok(serde_json::to_value(s.resolve_remote(&id, expected)?)?))
            .await
    }
    pub async fn plugin_add_git_marketplace(
        self: &Arc<Self>,
        url: String,
        reference: Option<String>,
        expected: u64,
    ) -> Result<Value> {
        self.plugin_change(move |s| {
            Ok(serde_json::to_value(s.add_git_marketplace(
                &url,
                reference.as_deref(),
                expected,
            )?)?)
        })
        .await
    }
    pub async fn plugin_add_git_marketplace_sparse(
        self: &Arc<Self>,
        url: String,
        reference: Option<String>,
        sparse_paths: Vec<String>,
        expected: u64,
    ) -> Result<Value> {
        self.plugin_change(move |s| {
            Ok(serde_json::to_value(s.add_git_marketplace_sparse(
                &url,
                reference.as_deref(),
                &sparse_paths,
                expected,
            )?)?)
        })
        .await
    }
    pub async fn plugin_remove_marketplace(
        self: &Arc<Self>,
        root: PathBuf,
        expected: u64,
    ) -> Result<Value> {
        self.plugin_change(move |s| {
            Ok(serde_json::to_value(
                s.remove_marketplace(&root, expected)?,
            )?)
        })
        .await
    }
    pub async fn plugin_update_marketplaces(self: &Arc<Self>, expected: u64) -> Result<Value> {
        self.plugin_change(move |s| Ok(serde_json::to_value(s.update_marketplaces(expected)?)?))
            .await
    }
    pub async fn plugin_update_selected_marketplaces(
        self: &Arc<Self>,
        name: Option<String>,
        expected: u64,
    ) -> Result<Value> {
        self.plugin_change(move |s| {
            Ok(serde_json::to_value(s.update_selected_marketplaces(
                name.as_deref(),
                expected,
            )?)?)
        })
        .await
    }
    pub async fn plugin_configure(
        self: &Arc<Self>,
        id: String,
        scope: String,
        enabled: bool,
        expected: u64,
    ) -> Result<Value> {
        self.plugin_change(move |s| {
            Ok(serde_json::to_value(
                s.configure(&id, &scope, enabled, expected)?,
            )?)
        })
        .await
    }
    pub async fn plugin_uninstall(self: &Arc<Self>, id: String, expected: u64) -> Result<Value> {
        self.plugin_change(move |s| Ok(serde_json::to_value(s.uninstall(&id, expected)?)?))
            .await
    }
    pub async fn plugin_setup(
        self: &Arc<Self>,
        identity: String,
        id: String,
        thread_id: Option<String>,
        request_id: String,
    ) -> Result<Value> {
        if !valid_id(&request_id) {
            return Err(invalid("invalid requestId"));
        }
        self.refresh_plugins().await?;
        let store = self.plugin_store()?;
        let (detail, installed) = tokio::task::spawn_blocking(move || {
            Ok::<_, anyhow::Error>((store.read(&id)?, store.installed_skills()?))
        })
        .await
        .map_err(invalid)?
        .map_err(store_error)?;
        if !detail.installed || !detail.enabled {
            return Err(invalid("plugin must be installed and enabled"));
        }
        let info = installed
            .into_iter()
            .find(|s| s.plugin_id == detail.id && s.onboarding)
            .ok_or_else(|| invalid("plugin has no onboarding skill"))?;
        let reference = VersionRef {
            id: info.id.clone(),
            revision: info.revision.clone(),
        };
        let config = if let Some(id) = &thread_id {
            let cell = self.cell(id).await?;
            let state = cell.state.lock().await;
            if state.thread.is_side()
                || state.thread.parent_thread_id.is_some()
                || state.thread.source == "nativeTaskAgent"
            {
                return Err(invalid("setup requires an ordinary session"));
            }
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            let config = desktop(&state.thread).configuration;
            if config
                .profile
                .as_ref()
                .is_some_and(|p| p.workflow.is_some())
            {
                return Err(invalid("setup requires an ordinary session"));
            }
            config
        } else {
            let mut config = self.resolve_config(
                self.desktop.default_profile.read().unwrap().clone(),
                None,
                Default::default(),
                1,
            )?;
            config.allow_plugin_skills = true;
            config
        };
        let mut scope = config.clone();
        scope.selected_skills = None;
        if !self
            .effective_skill_refs(&scope, false)
            .contains(&reference)
        {
            return Err(invalid("setup skill is outside the effective profile"));
        }
        self.configured_model(&config)?;
        let skill = tokio::task::spawn_blocking(move || Skill::load_plugin(info))
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
        self.check_plugin_skill(&skill).await?;
        let body = skill
            .read("SKILL.md", 0, 64 * 1024)
            .await
            .map_err(invalid)?;
        if body.size > 64 * 1024 {
            return Err(invalid("setup skill exceeds 64 KiB input budget"));
        }
        let text = String::from_utf8(body.bytes).map_err(invalid)?;
        let input = vec![Input::text(format!(
            "Run the onboarding skill {} from {}.\n\n{}",
            skill.metadata.name, detail.display_name, text
        ))];
        validate_input(&input, &self.configured_model(&config)?.capabilities())?;
        let thread = match thread_id {
            Some(id) => self.read(&id, true).await?,
            None => self.create(self.plugin_workspace()?).await?,
        };
        let result = self
            .start_durable_with_skill(
                identity,
                TurnStart {
                    admission_guard: Some(TurnStartAdmissionGuard {
                        config_revision: config.revision,
                        ordinary_session: true,
                        expected_turn_id: None,
                    }),
                    interaction_mode: None,
                    request_id: request_id.clone(),
                    thread_id: thread.id.clone(),
                    input,
                    expected_config_revision: Some(config.revision),
                },
                reference,
            )
            .await?;
        Ok(
            json!({"thread":self.read(&thread.id, true).await?,"turn":result["turn"],"requestId":request_id}),
        )
    }
    fn plugin_workspace(&self) -> Result<String> {
        Ok(self
            .plugin_store()?
            .workspace()
            .to_string_lossy()
            .into_owned())
    }
}
