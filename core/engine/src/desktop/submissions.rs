//! 管理写入复用持久受理日志；崩溃后的 pending 是 UNKNOWN，禁止自动执行重试。
use super::*;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Submission {
    identity: String,
    request_id: String,
    method: String,
    digest: String,
    state: String,
    response: Option<Value>,
    #[serde(default)]
    target: Option<OperationTarget>,
}
impl Submission {
    fn response(&self, hash: &str, operation: OperationRef) -> Result<Value> {
        if self.digest != hash {
            return Err(Error::Rejected(Box::new(Error::Conflict)));
        }
        self.response.clone().ok_or_else(|| {
            let admitted = self.state != "unconfirmed";
            outcome_error(
                operation,
                admitted,
                if admitted {
                    "COMPLETION_UNCONFIRMED"
                } else {
                    "ADMISSION_UNCONFIRMED"
                },
            )
        })
    }
}
pub(super) struct Submissions {
    gate: Mutex<BTreeMap<String, std::sync::Weak<Mutex<()>>>>,
    entries: Mutex<BTreeMap<String, Submission>>,
}
impl Submissions {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        let path = root.join("desktop/submissions.json");
        let mut entries: BTreeMap<String, Submission> = if path.exists() {
            anyhow::ensure!(
                std::fs::metadata(&path)?.len() <= 8 * 1024 * 1024,
                "submission journal exceeds 8 MiB"
            );
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            BTreeMap::new()
        };
        for record in entries.values_mut() {
            if record.state == "accepted" {
                record.state = "unknown".into();
            }
        }
        Ok(Self {
            gate: Mutex::new(BTreeMap::new()),
            entries: Mutex::new(entries),
        })
    }
}
impl Engine {
    pub const MANAGEMENT_RECEIPT_MAX_BYTES: usize = 256 * 1024;

    pub async fn management_submission_result(
        &self,
        identity: &str,
        request_id: &str,
        method: &str,
        parameters: &Value,
    ) -> Result<Option<Value>> {
        if !valid_id(request_id) {
            return Err(Error::Rejected(Box::new(invalid("invalid requestId"))));
        }
        let key = digest(&(identity, method, request_id))?;
        let entries = self.desktop.submissions.entries.lock().await;
        entries
            .get(&key)
            .map(|record| {
                record.response(
                    &digest(parameters)?,
                    submission_operation(request_id, method, parameters),
                )
            })
            .transpose()
    }

    pub async fn management_submission<F, Fut>(
        self: &Arc<Self>,
        identity: String,
        request_id: String,
        method: String,
        parameters: Value,
        run: F,
    ) -> Result<Value>
    where
        F: FnOnce(Arc<Engine>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Value> + Send + 'static,
    {
        self.mutate(move |engine| async move {
            if !valid_id(&request_id) {
                return Err(Error::Rejected(Box::new(invalid("invalid requestId"))));
            }
            let key = digest(&(&identity, &method, &request_id))?;
            let hash = digest(&parameters)?;
            let serial = {
                let mut gates = engine.desktop.submissions.gate.lock().await;
                gates.retain(|_, gate| gate.strong_count() > 0);
                if let Some(gate) = gates.get(&key).and_then(std::sync::Weak::upgrade) {
                    gate
                } else {
                    let gate = Arc::new(Mutex::new(()));
                    gates.insert(key.clone(), Arc::downgrade(&gate));
                    gate
                }
            };
            let _request = serial.lock().await;
            let mut entries = engine.desktop.submissions.entries.lock().await;
            let operation = submission_operation(&request_id, &method, &parameters);
            if let Some(record) = entries.get(&key) {
                return record.response(&hash, operation);
            }
            if entries.len() >= 4096 {
                return Err(Error::Rejected(Box::new(Error::Exhausted("management submission capacity reached; keys are retained for deployment lifetime".into()))));
            }
            entries.insert(key.clone(), Submission {
                identity, request_id, method, digest: hash, state: "accepted".into(), response: None,
                target: Some(operation.target.clone()),
            });
            let reserved = entries.values().filter(|r| r.state == "accepted").count()
                .saturating_mul(Self::MANAGEMENT_RECEIPT_MAX_BYTES + 512);
            if serde_json::to_vec(&*entries).map_err(invalid)?.len().saturating_add(reserved) > 8 * 1024 * 1024 {
                entries.remove(&key);
                return Err(Error::Rejected(Box::new(Error::Exhausted("management receipt capacity cannot reserve this response".into()))));
            }
            if engine.store.save_metadata("submissions", &*entries).await.is_err() {
                // 原子替换之后目录同步也可能失败，不能断言回执从未发布或允许再次执行。
                entries.get_mut(&key).unwrap().state = "unconfirmed".into();
                return Err(outcome_error(operation, false, "ADMISSION_UNCONFIRMED"));
            }
            drop(entries);
            let mut result = run(engine.clone()).await;
            let mut entries = engine.desktop.submissions.entries.lock().await;
            if serde_json::to_vec(&result).map_err(invalid)?.len() > Self::MANAGEMENT_RECEIPT_MAX_BYTES {
                result = json!({"error":{"code":-32005,
                    "message":"mutation completed; response exceeds receipt budget; inspect authoritative state",
                    "data":{"reason":"RESPONSE_TOO_LARGE"}}});
            }
            if let Some(error) = result.get_mut("error").and_then(Value::as_object_mut) {
                let reason = error.get("data").and_then(|data| data.get("reason"))
                    .and_then(Value::as_str).filter(|value| valid_id(value))
                    .unwrap_or("OPERATION_FAILED").to_owned();
                error.insert("data".into(), json!(OperationFailure {
                    reason, outcome: FailureOutcome::Admitted { operation: operation.clone() }, recovery: Recovery::QueryOriginal,
                }));
            }
            let record = entries.get_mut(&key).unwrap();
            record.state = "completed".into();
            record.response = Some(result.clone());
            if engine.store.save_metadata("submissions", &*entries).await.is_err() {
                let record = entries.get_mut(&key).unwrap();
                record.state = "unknown".into();
                record.response = None;
                return Err(outcome_error(operation, true, "COMPLETION_UNCONFIRMED"));
            }
            Ok(result)
        }).await
    }
    pub async fn management_receipts(&self, identity: &str, request_id: &str) -> Value {
        let entries = self.desktop.submissions.entries.lock().await;
        let records: Vec<Value> = entries
            .values()
            .filter(|r| r.identity == identity && r.request_id == request_id)
            .map(|r| {
                let mut value = json!(r);
                let operation = OperationRef {
                    request_id: r.request_id.clone(),
                    method: r.method.clone(),
                    target: r.target.clone().unwrap_or(OperationTarget::Project),
                };
                value["operation"] = json!(operation);
                value["status"] = json!(if r.state == "unconfirmed" {
                    "unconfirmed"
                } else if r
                    .response
                    .as_ref()
                    .is_some_and(|reply| reply.get("error").is_some())
                {
                    "failed"
                } else if r.response.is_some() {
                    "completed"
                } else {
                    "admitted"
                });
                if let Some(response) = &r.response {
                    if let Some(result) = response.get("result") {
                        value["result"] = result.clone();
                    }
                    if let Some(error) = response.get("error") {
                        value["error"] = error.clone();
                    }
                }
                if let OperationTarget::Thread { thread_id } = operation.target {
                    value["threadId"] = json!(thread_id);
                }
                value
            })
            .collect();
        json!({"data":records,"retention":"deploymentLifetime","capacity":4096})
    }
}

fn submission_operation(request_id: &str, method: &str, parameters: &Value) -> OperationRef {
    OperationRef {
        request_id: request_id.into(),
        method: method.into(),
        target: parameters
            .get("taskId")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .map(|id| OperationTarget::Task { task_id: id.into() })
            .or_else(|| {
                parameters
                    .get("threadId")
                    .and_then(Value::as_str)
                    .filter(|id| valid_id(id))
                    .map(|id| OperationTarget::Thread {
                        thread_id: id.into(),
                    })
            })
            .unwrap_or(OperationTarget::Project),
    }
}

fn outcome_error(operation: OperationRef, admitted: bool, reason: &str) -> Error {
    Error::OperationOutcome(Box::new(OperationFailure {
        reason: reason.into(),
        outcome: if admitted {
            FailureOutcome::Admitted { operation }
        } else {
            FailureOutcome::Unconfirmed { operation }
        },
        recovery: Recovery::QueryOriginal,
    }))
}
