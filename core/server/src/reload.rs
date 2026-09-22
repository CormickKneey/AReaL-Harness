//! 文件更新先完整校验并持久化模型版本；失败时保留当前配置。
use anyhow::{Result, ensure};
use areal_config::{ConfigInputs, ModelProtocolConfig, ResolvedCoreConfig, SelectedModelConfig};
use areal_engine::{
    Engine,
    model::{HttpModel, Model, ModelOptions, ModelProtocol, UnconfiguredModel},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

pub fn model(
    config: &SelectedModelConfig,
    credential: Option<String>,
    data: &Path,
) -> Result<Arc<dyn Model>> {
    if config.name.is_empty() {
        return Ok(Arc::new(UnconfiguredModel));
    }
    Ok(Arc::new(
        HttpModel::with_protocol(
            config.endpoint.clone(),
            config.name.clone(),
            credential,
            match config.protocol {
                ModelProtocolConfig::ChatCompletions => ModelProtocol::ChatCompletions,
                ModelProtocolConfig::Responses => ModelProtocol::Responses,
            },
        )?
        .with_audit_directory(data.join("model-requests"))
        .with_options(ModelOptions {
            reasoning_effort: config.reasoning_effort.clone(),
            reasoning_summary: config.reasoning_summary.clone(),
            max_output_tokens: config.max_output_tokens,
            max_retries: config.max_retries,
            temperature: config.temperature,
            top_p: config.top_p,
            top_k: config.top_k,
            min_p: config.min_p,
            presence_penalty: config.presence_penalty,
            repetition_penalty: config.repetition_penalty,
        })?,
    ))
}

fn deployment(config: &ResolvedCoreConfig) -> Value {
    let mut value = config.diagnostic(false);
    value.as_object_mut().unwrap().remove("model");
    value
}

pub struct Reload {
    inputs: ConfigInputs,
    deployment: Value,
    models: BTreeMap<String, SelectedModelConfig>,
    current: String,
    data: std::path::PathBuf,
}

impl Reload {
    pub fn open(
        inputs: ConfigInputs,
        config: &ResolvedCoreConfig,
        engine: &Engine,
    ) -> Result<Self> {
        let path = config.data_dir.join("desktop/default-models.json");
        std::fs::create_dir_all(path.parent().unwrap())?;
        let models: BTreeMap<String, SelectedModelConfig> = if path.exists() {
            ensure!(
                path.metadata()?.len() <= 1024 * 1024,
                "model configuration archive exceeds 1 MiB"
            );
            serde_json::from_slice(&std::fs::read(&path)?)?
        } else {
            BTreeMap::new()
        };
        ensure!(
            models.len() <= 128,
            "model configuration archive exceeds 128 revisions"
        );
        for (revision, previous) in &models {
            ensure!(
                *revision == previous.fingerprint(),
                "model configuration archive digest mismatch"
            );
            // 退役凭据缺失不阻止服务启动；使用该版本的队列恢复会明确拒绝。
            if let Ok(model) = previous
                .credential(&inputs)
                .map_err(anyhow::Error::from)
                .and_then(|credential| model(previous, credential, &config.data_dir))
            {
                engine.register_default_model(revision.clone(), model, false);
            }
        }
        let mut reload = Self {
            inputs,
            deployment: deployment(config),
            models,
            current: String::new(),
            data: config.data_dir.clone(),
        };
        reload.apply(&config.model, engine)?;
        Ok(reload)
    }

    fn apply(&mut self, config: &SelectedModelConfig, engine: &Engine) -> Result<()> {
        let revision = config.fingerprint();
        if revision == self.current {
            return Ok(());
        }
        let model = model(config, config.credential(&self.inputs)?, &self.data)?;
        let mut candidate = self.models.clone();
        candidate.insert(revision.clone(), config.clone());
        ensure!(
            candidate.len() <= 128,
            "model configuration archive is full (128 revisions); retain queued history and use another data directory"
        );
        let bytes = serde_json::to_vec(&candidate)?;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "model configuration archive exceeds 1 MiB"
        );
        let mut file = tempfile::NamedTempFile::new_in(self.data.join("desktop"))?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(self.data.join("desktop/default-models.json"))?;
        std::fs::File::open(self.data.join("desktop"))?.sync_all()?;
        engine.register_default_model(revision.clone(), model, true);
        self.models = candidate;
        self.current = revision;
        Ok(())
    }

    pub async fn run(mut self, engine: Arc<Engine>) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        engine
            .set_configuration_status(
                json!({"modelRevision":self.current,"restartRequired":false,"error":null}),
            )
            .await;
        let mut pending = None;
        loop {
            interval.tick().await;
            let result = match areal_config::load_management_config(&self.inputs) {
                Ok(config) => {
                    let candidate = (deployment(&config), config.model.fingerprint());
                    // 连续两次读到同一有效配置后再应用，兼容编辑器的替换保存与连续写入。
                    if pending.as_ref() != Some(&candidate) {
                        pending = Some(candidate);
                        continue;
                    }
                    if candidate.0 != self.deployment {
                        Ok(true)
                    } else {
                        self.apply(&config.model, &engine).map(|()| false)
                    }
                }
                Err(error) => {
                    pending = None;
                    Err(anyhow::Error::from(error))
                }
            };
            let (restart, error) = match result {
                Ok(restart) => (restart, None),
                Err(error) => (false, Some(error.to_string())),
            };
            engine
                .set_configuration_status(
                    json!({"modelRevision":self.current,"restartRequired":restart,"error":error}),
                )
                .await;
        }
    }
}
