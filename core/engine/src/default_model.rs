use super::*;
use areal_protocol::desktop::{EffectiveConfig, ModelParameters};

#[derive(Default)]
pub(crate) struct DefaultModels {
    current: Option<String>,
    versions: BTreeMap<String, Arc<dyn Model>>,
    metadata: BTreeMap<String, (String, ModelParameters)>,
}

impl Engine {
    pub fn register_default_model(&self, revision: String, model: Arc<dyn Model>, current: bool) {
        let mut models = self.default_models.write().unwrap();
        models
            .versions
            .insert(revision.clone(), self.model.share_capacity(model));
        if current {
            models.current = Some(revision);
        }
    }

    pub fn register_default_model_metadata(
        &self,
        revision: String,
        name: String,
        parameters: ModelParameters,
    ) {
        self.default_models
            .write()
            .unwrap()
            .metadata
            .insert(revision, (name, parameters));
    }

    pub(crate) fn default_model_metadata(
        &self,
        revision: Option<&str>,
    ) -> Option<(String, ModelParameters)> {
        let models = self.default_models.read().unwrap();
        let revision = revision.or(models.current.as_deref())?;
        models.metadata.get(revision).cloned()
    }

    pub(crate) fn pin_desktop_default(&self, configuration: &mut EffectiveConfig) {
        if configuration.model.is_none() && configuration.default_model_revision.is_none() {
            configuration.default_model_revision =
                self.default_models.read().unwrap().current.clone();
        }
    }

    pub async fn recover_desktop_default_models(&self) -> Result<()> {
        for cell in self.threads.read().await.values() {
            let mut state = cell.state.lock().await;
            let Some(desktop) = &state.thread.desktop else {
                continue;
            };
            if desktop.configuration.model.is_some()
                || desktop.configuration.default_model_revision.is_some()
            {
                continue;
            }
            let Some(configuration) = state
                .thread
                .turns
                .last()
                .and_then(|turn| turn.configuration.as_ref())
            else {
                continue;
            };
            if configuration.model.is_some() || configuration.default_model_revision.is_none() {
                continue;
            }
            let mut candidate = state.thread.clone();
            let previous = &mut candidate.desktop.as_mut().unwrap().configuration;
            previous.default_model_revision = configuration.default_model_revision.clone();
            previous.revision += 1;
            if self
                .default_model_metadata(previous.default_model_revision.as_deref())
                .is_some()
            {
                self.update_model_parameters(previous, previous.parameters.clone());
            }
            self.persist(&candidate).await?;
            state.thread = candidate;
        }
        Ok(())
    }

    pub(crate) fn default_model(&self) -> Arc<dyn Model> {
        let models = self.default_models.read().unwrap();
        models
            .current
            .as_ref()
            .and_then(|r| models.versions.get(r))
            .cloned()
            .unwrap_or_else(|| self.model.clone())
    }

    pub(crate) fn freeze_configuration(
        &self,
        mut configuration: EffectiveConfig,
    ) -> EffectiveConfig {
        self.pin_desktop_default(&mut configuration);
        self.freeze_plugin_skills(&mut configuration);
        configuration
    }

    pub(crate) fn default_model_for(
        &self,
        configuration: &EffectiveConfig,
    ) -> Result<Arc<dyn Model>> {
        match &configuration.default_model_revision {
            Some(revision) => self.default_models.read().unwrap().versions.get(revision).cloned()
                .ok_or_else(|| Error::Invalid("DEFAULT_MODEL_REVISION_UNAVAILABLE: restore its configuration and credential before resuming queued work".into())),
            None => Ok(self.default_model()),
        }
    }

    pub async fn set_configuration_status(&self, status: Value) {
        {
            let mut previous = self.configuration_status.write().unwrap();
            if *previous == status {
                return;
            }
            *previous = status.clone();
        }
        for cell in self.threads.read().await.values() {
            cell.emit(
                "areal/server/configurationChanged",
                json!({"threadId":cell.id,"configuration":status}),
            );
        }
    }
}
