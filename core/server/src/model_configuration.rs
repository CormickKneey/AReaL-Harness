use crate::{
    configured_models,
    reload::{self, Reload},
};
use areal_app_server::configuration::ModelConfigurationControl;
use areal_config::models::ModelConfiguration;
use areal_engine::{Engine, desktop::PreparedModelConfiguration};
use areal_protocol::{
    RpcError,
    desktop::{AppliedModelConfiguration, ModelConfigurationApply, ModelConfigurationRead},
    service::Identity,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

type Outcome = Result<Value, RpcError>;
type Response<'a> = Pin<Box<dyn Future<Output = Outcome> + Send + 'a>>;

#[derive(PartialEq, Eq)]
struct Intent {
    generation: String,
    expected: AppliedModelConfiguration,
    target: String,
    credential_names: Vec<String>,
}
struct Operation {
    intent: Intent,
    result: watch::Sender<Option<Outcome>>,
    order: u64,
}
#[derive(Default)]
struct Operations {
    records: BTreeMap<String, Operation>,
    next: u64,
}

pub(super) struct Controller {
    reload: tokio::sync::Mutex<Reload>,
    engine: Arc<Engine>,
    identity: Identity,
    operations: Mutex<Operations>,
}

fn rejected(reason: &str, message: &str) -> RpcError {
    RpcError {
        code: -32010,
        message: message.into(),
        data: Some(json!({"reason":reason,"retryable":false})),
    }
}
fn status(document: &ModelConfiguration, model_revision: &str, sequence: u64) -> Value {
    json!({"applied":{"revision":document.revision,"sequence":sequence},
        "appliedRevision":document.revision,"applySequence":sequence,
        "currentFileRevision":document.revision,"modelRevision":model_revision,
        "credentialStates":document.credential_states,"pendingApply":false,"restartRequired":false,"error":null})
}
fn additions(request: &ModelConfigurationApply) -> BTreeMap<String, String> {
    request
        .credentials
        .iter()
        .map(|(name, value)| {
            (
                name.strip_prefix("AREAL_CREDENTIAL_")
                    .unwrap_or(name)
                    .to_owned(),
                value.clone(),
            )
        })
        .collect()
}

impl Controller {
    pub(super) async fn new(
        reload: Reload,
        engine: Arc<Engine>,
        identity: Identity,
        document: ModelConfiguration,
    ) -> Arc<Self> {
        engine
            .set_configuration_status(status(&document, &reload.current, 0))
            .await;
        Arc::new(Self {
            reload: tokio::sync::Mutex::new(reload),
            engine,
            identity,
            operations: Mutex::new(Operations::default()),
        })
    }

    fn proof(&self) -> Value {
        let status = self.engine.model_configuration_status();
        json!({"serviceId":self.identity.service_id,"generation":self.identity.generation,
            "applied":status["applied"],"modelRevision":status["modelRevision"],"credentialStates":status["credentialStates"]})
    }

    fn inspect(&self, query: ModelConfigurationRead) -> Outcome {
        if query
            .expected_generation
            .as_ref()
            .is_some_and(|generation| generation != &self.identity.generation)
        {
            return Err(rejected(
                "MODEL_CONFIGURATION_GENERATION_MISMATCH",
                "Core generation changed; inspect the new service before applying",
            ));
        }
        let mut proof = self.proof();
        if let Some(id) = query.request_id {
            let operations = self.operations.lock().unwrap();
            proof["operation"] = match operations.records.get(&id) {
                None => json!({"requestId":id,"state":"unknown"}),
                Some(operation) => match &*operation.result.borrow() {
                    None => json!({"requestId":id,"state":"running"}),
                    Some(Ok(result)) => json!({"requestId":id,"state":"applied","result":result}),
                    Some(Err(error))
                        if error.data.as_ref().is_some_and(|data| {
                            data["reason"] == "MODEL_CONFIGURATION_UNKNOWN"
                        }) =>
                    {
                        json!({"requestId":id,"state":"unknown","error":error})
                    }
                    Some(Err(error)) => json!({"requestId":id,"state":"rejected","error":error}),
                },
            };
        }
        Ok(proof)
    }

    fn submit(
        self: &Arc<Self>,
        request: ModelConfigurationApply,
    ) -> Result<watch::Receiver<Option<Outcome>>, RpcError> {
        let intent = Intent {
            generation: request.expected_generation.clone(),
            expected: request.expected_applied.clone(),
            target: request.target_revision.clone(),
            credential_names: request.credentials.keys().cloned().collect(),
        };
        let mut operations = self.operations.lock().unwrap();
        if let Some(operation) = operations.records.get(&request.request_id) {
            self.engine
                .check_configured_credentials(&additions(&request))
                .map_err(|_| {
                    rejected(
                        "MODEL_CONFIGURATION_CREDENTIAL_CONFLICT",
                        "credential references are immutable",
                    )
                })?;
            if operation.intent != intent {
                return Err(rejected(
                    "MODEL_CONFIGURATION_REQUEST_CONFLICT",
                    "requestId already identifies another configuration operation",
                ));
            }
            return Ok(operation.result.subscribe());
        }
        if operations.records.len() >= 128 {
            let oldest = operations
                .records
                .iter()
                .filter(|(_, operation)| match &*operation.result.borrow() {
                    Some(Ok(_)) => true,
                    Some(Err(error)) => !error
                        .data
                        .as_ref()
                        .is_some_and(|data| data["reason"] == "MODEL_CONFIGURATION_UNKNOWN"),
                    None => false,
                })
                .min_by_key(|(_, operation)| operation.order)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                operations.records.remove(&id);
            } else {
                return Err(rejected(
                    "MODEL_CONFIGURATION_CAPACITY",
                    "configuration operation capacity reached",
                ));
            }
        }
        let (result, receiver) = watch::channel(None);
        let id = request.request_id.clone();
        let order = operations.next;
        operations.next += 1;
        operations.records.insert(
            id,
            Operation {
                intent,
                result: result.clone(),
                order,
            },
        );
        let controller = self.clone();
        let execution = tokio::spawn(async move { controller.perform(request).await });
        tokio::spawn(async move {
            let outcome = execution.await.unwrap_or_else(|_| Err(rejected("MODEL_CONFIGURATION_UNKNOWN", "configuration operation did not return a known outcome; inspect its original request")));
            result.send_replace(Some(outcome));
        });
        Ok(receiver)
    }

    async fn perform(&self, request: ModelConfigurationApply) -> Outcome {
        if request.expected_generation != self.identity.generation {
            return Err(rejected(
                "MODEL_CONFIGURATION_GENERATION_MISMATCH",
                "Core generation changed; inspect the new service before applying",
            ));
        }
        let mut reload = self.reload.lock().await;
        if self.engine.model_configuration_status()["applied"] != json!(request.expected_applied) {
            return Err(rejected(
                "MODEL_CONFIGURATION_CONFLICT",
                "applied configuration changed",
            ));
        }
        let mut inputs = reload.inputs.clone();
        for (name, value) in &request.credentials {
            if !name.starts_with("AREAL_CREDENTIAL_")
                || value.trim().is_empty()
                || value.len() > 16384
                || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
            {
                return Err(rejected(
                    "MODEL_CONFIGURATION_INVALID_CREDENTIAL",
                    "invalid credential addition",
                ));
            }
            if inputs
                .env
                .get(std::ffi::OsStr::new(name))
                .is_some_and(|old| old != value.as_str())
            {
                return Err(rejected(
                    "MODEL_CONFIGURATION_CREDENTIAL_CONFLICT",
                    "credential references are immutable",
                ));
            }
            inputs.env.insert(name.into(), value.into());
        }
        let (document, config) =
            areal_config::models::read_resolved(&inputs, &[]).map_err(|_| {
                rejected(
                    "MODEL_CONFIGURATION_INVALID",
                    "canonical model configuration is invalid",
                )
            })?;
        if document.revision != request.target_revision {
            return Err(rejected(
                "MODEL_CONFIGURATION_FILE_CONFLICT",
                "canonical configuration revision changed",
            ));
        }
        if reload::deployment(&config) != reload.deployment {
            return Err(rejected(
                "DEPLOYMENT_CHANGE_REQUIRES_RESTART",
                "non-model deployment configuration changed; update the backend",
            ));
        }
        if request.credentials.keys().any(|name| {
            !document
                .data
                .iter()
                .any(|provider| provider.api_key_env.as_ref() == Some(name))
        }) {
            return Err(rejected(
                "MODEL_CONFIGURATION_UNREFERENCED_CREDENTIAL",
                "credential addition is not referenced by the canonical model configuration",
            ));
        }
        let (catalog, mut credentials) = configured_models(&config, &inputs.env).map_err(|_| {
            rejected(
                "MODEL_CONFIGURATION_INVALID",
                "model catalog preparation failed",
            )
        })?;
        credentials.extend(additions(&request));
        self.engine
            .check_configured_credentials(&credentials)
            .map_err(|_| {
                rejected(
                    "MODEL_CONFIGURATION_CREDENTIAL_CONFLICT",
                    "credential references are immutable",
                )
            })?;
        let default_model =
            reload::model(&config.model, &inputs, &reload.data, true).map_err(|_| {
                rejected(
                    "MODEL_CONFIGURATION_MODEL_UNAVAILABLE",
                    "default model or credential is unavailable",
                )
            })?;
        let revision = config.model.fingerprint();
        let mut archive = reload.models.clone();
        archive.insert(
            revision.clone(),
            serde_json::value::to_raw_value(&config.model).map_err(|_| {
                rejected(
                    "MODEL_CONFIGURATION_INVALID",
                    "default model metadata is invalid",
                )
            })?,
        );
        if archive.len() > 128
            || serde_json::to_vec(&archive).map_or(true, |bytes| bytes.len() > 1024 * 1024)
        {
            return Err(rejected(
                "MODEL_CONFIGURATION_ARCHIVE_FULL",
                "default model archive reached capacity; retain history and use another data directory",
            ));
        }
        let sequence = request
            .expected_applied
            .sequence
            .checked_add(1)
            .ok_or_else(|| {
                rejected(
                    "MODEL_CONFIGURATION_CAPACITY",
                    "configuration sequence reached capacity",
                )
            })?;
        let prepared = PreparedModelConfiguration {
            catalog,
            credentials,
            default_revision: revision.clone(),
            default_model,
            default_name: config.model.name.clone(),
            default_parameters: reload::parameters(&config.model),
            archive: archive.clone(),
            status: status(&document, &revision, sequence),
        };
        self.engine.apply_configured_models(request.expected_applied, prepared).await.map_err(|error| match error {
            areal_engine::Error::Conflict => rejected("MODEL_CONFIGURATION_CONFLICT", "applied configuration changed"),
            areal_engine::Error::Invalid(message) if message.starts_with("MODEL_CONFIGURATION_BUSY") => rejected("MODEL_CONFIGURATION_BUSY", "Core has active or queued work; wait before applying"),
            _ => rejected("MODEL_CONFIGURATION_APPLY_FAILED", "model configuration could not be persisted; the prior configuration remains applied"),
        })?;
        reload.inputs = inputs;
        reload.models = archive;
        reload.current = revision;
        reload.managed = config.model_catalog_managed;
        Ok(self.proof())
    }

    pub(super) async fn run(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut pending = None;
        loop {
            interval.tick().await;
            let mut reload = self.reload.lock().await;
            let mut current = self.engine.model_configuration_status();
            match areal_config::models::read_resolved(&reload.inputs, &[]) {
                Ok((document, config)) => {
                    let candidate = (
                        document.revision.clone(),
                        reload::deployment(&config),
                        config.model.fingerprint(),
                    );
                    if pending.as_ref() != Some(&candidate) {
                        pending = Some(candidate);
                        continue;
                    }
                    current["currentFileRevision"] = json!(document.revision);
                    current["pendingApply"] =
                        json!(current["applied"]["revision"] != document.revision);
                    current["restartRequired"] =
                        json!(reload::deployment(&config) != reload.deployment);
                    current["error"] = Value::Null;
                    if !reload.managed
                        && !config.model_catalog_managed
                        && current["restartRequired"] == false
                    {
                        match reload.apply(&config.model, &self.engine, false) {
                            Ok(()) => {
                                let sequence = current["applied"]["sequence"].as_u64().unwrap_or(0)
                                    + u64::from(
                                        current["applied"]["revision"] != document.revision,
                                    );
                                current = status(&document, &reload.current, sequence);
                            }
                            Err(error) => {
                                current["restartRequired"] =
                                    json!(reload::requires_fresh_credentials(&error));
                                current["error"] = json!(error.to_string());
                            }
                        }
                    }
                }
                Err(_) => {
                    pending = None;
                    current["error"] = json!("canonical model configuration is invalid");
                }
            }
            self.engine.set_configuration_status(current).await;
        }
    }
}

impl ModelConfigurationControl for Controller {
    fn read(&self, query: ModelConfigurationRead) -> Response<'_> {
        Box::pin(async move { self.inspect(query) })
    }
    fn apply(self: Arc<Self>, request: ModelConfigurationApply) -> Response<'static> {
        Box::pin(async move {
            let id = request.request_id.clone();
            let supplied = additions(&request);
            let mut receiver = self.submit(request)?;
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    if result.is_ok() {
                        self.engine
                            .check_configured_credentials(&supplied)
                            .map_err(|_| {
                                rejected(
                                    "MODEL_CONFIGURATION_CREDENTIAL_CONFLICT",
                                    "credential references are immutable",
                                )
                            })?;
                    }
                    return result.map(|mut proof| {
                        proof["operation"] =
                            json!({"requestId":id,"state":"applied","result":proof.clone()});
                        proof
                    });
                }
                if receiver.changed().await.is_err() {
                    return Err(rejected(
                        "MODEL_CONFIGURATION_UNKNOWN",
                        "configuration outcome is unknown",
                    ));
                }
            }
        })
    }
}

#[cfg(test)]
#[path = "model_configuration_tests.rs"]
mod tests;
