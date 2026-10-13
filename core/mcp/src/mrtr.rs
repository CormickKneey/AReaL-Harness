//! MRTR stays inside one caller-owned operation. A received continuation is not a transport retry.
use crate::*;
use futures_util::future::BoxFuture;

/// Core supplies a non-transferable caller token and rechecks authority before every round.
/// Neither the token nor the guard is sent to the MCP server.
#[derive(Clone)]
pub struct RequestOwner {
    pub token: String,
    guard: Arc<dyn Fn() -> BoxFuture<'static, Result<()>> + Send + Sync>,
}
impl std::fmt::Debug for RequestOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestOwner")
    }
}
impl RequestOwner {
    pub fn new(
        token: String,
        guard: impl Fn() -> BoxFuture<'static, Result<()>> + Send + Sync + 'static,
    ) -> Self {
        Self {
            token,
            guard: Arc::new(guard),
        }
    }
}
pub(crate) struct RequestChannel<'a> {
    pub peer: &'a Peer<RoleClient>,
    pub server: &'a str,
    pub generation: u64,
    pub revoked: &'a CancellationToken,
    pub auth_failed: &'a AtomicBool,
    pub auth_rejected: &'a http::AuthRejections,
    pub auth_challenge: &'a http::AuthChallenge,
    pub sent_credentials: &'a http::SentCredentials,
    pub timeout: Option<Duration>,
    pub broker: Option<&'a ElicitationBroker>,
}
impl RequestChannel<'_> {
    pub async fn exchange(
        &self,
        mut request: ClientRequest,
        owner: Option<&RequestOwner>,
        cancel: CancellationToken,
    ) -> Result<ServerResult> {
        let operation = cancel.child_token();
        let _drop = operation.clone().drop_guard();
        let deadline = async {
            match self.timeout {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(deadline);
        for round in 0..10 {
            ensure!(
                !self.revoked.is_cancelled() && !operation.is_cancelled(),
                "MCP operation cancelled; outcome is UNKNOWN"
            );
            if self.auth_failed.load(Ordering::Acquire) {
                return Err(AuthenticationFailed.into());
            }
            if let Some(owner) = owner {
                (owner.guard)().await?;
            }
            let mut handle = tokio::select! {biased;
                _=operation.cancelled()=>bail!("MCP operation cancelled; outcome is UNKNOWN"),
                _=self.revoked.cancelled()=>bail!("MCP generation revoked; outcome is UNKNOWN"),
                _=&mut deadline=>bail!("MCP operation timed out; outcome is UNKNOWN"),
                h=self.peer.send_cancellable_request(request.clone(),PeerRequestOptions::no_options())=>h.map_err(|_|anyhow::anyhow!("MCP request submission failed; outcome is UNKNOWN"))?,
            };
            let id = handle.id.clone();
            let result = tokio::select! {biased;
                _=operation.cancelled()=>None,_=self.revoked.cancelled()=>None,_=&mut deadline=>None,r=&mut handle.rx=>Some(r)
            };
            let Some(result) = result else {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    handle.cancel(Some("Core operation interrupted".into())),
                )
                .await;
                self.sent_credentials.take(&id);
                if http::take_rejection(self.auth_rejected, &id) {
                    return Err(AuthenticationFailed.into());
                }
                bail!("MCP operation interrupted; outcome is UNKNOWN");
            };
            let sent_credential = self.sent_credentials.take(&id);
            let rejected = http::take_rejection(self.auth_rejected, &id);
            if rejected && !matches!(&result, Ok(Ok(_))) {
                return Err(AuthenticationFailed.into());
            }
            let mut result = result
                .map_err(|_| anyhow::anyhow!("MCP disconnected; outcome is UNKNOWN"))?
                .map_err(|_| {
                    anyhow::anyhow!("MCP protocol/transport failure; outcome is UNKNOWN")
                })?;
            ensure!(
                serde_json::to_vec(&result)?.len() <= 24 * 1024 * 1024,
                "MCP result exceeds budget; outcome is UNKNOWN"
            );
            if let ServerResult::CallToolResult(tool_result) = &mut result {
                // Authentication challenges are private even when malformed or attached to a successful result.
                let marker = tool_result
                    .meta
                    .as_mut()
                    .and_then(|m| m.remove("mcp/www_authenticate"));
                if tool_result.is_error == Some(true) {
                    let valid = |s: &str| {
                        !s.trim().is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control)
                    };
                    let challenge = match marker.as_ref() {
                        Some(Value::String(s)) if valid(s) => Some(s.as_str()),
                        Some(Value::Array(values)) => {
                            values.iter().filter_map(Value::as_str).find(|s| valid(s))
                        }
                        _ => None,
                    };
                    if let Some(challenge) = challenge {
                        self.auth_challenge.capture(challenge);
                        self.auth_failed.store(true, Ordering::Release);
                        if let Some((credential, token)) = sent_credential {
                            credential.reject(token.as_deref()).await;
                        }
                        return Err(AuthenticationFailed.into());
                    }
                }
            }
            let ServerResult::InputRequiredResult(input) = result else {
                return Ok(result);
            };
            ensure!(
                self.peer
                    .peer_info()
                    .is_some_and(|i| i.protocol_version >= ProtocolVersion::V_2026_07_28),
                "MRTR requires modern negotiation; outcome is UNKNOWN"
            );
            let owner =
                owner.context("MRTR requires an authoritative caller; outcome is UNKNOWN")?;
            ensure!(
                round < 9,
                "MCP continuation limit exceeded; outcome is UNKNOWN"
            );
            ensure!(
                serde_json::to_vec(&input)?.len() <= 256 * 1024,
                "MCP continuation exceeds budget; outcome is UNKNOWN"
            );
            let requests = input.input_requests.unwrap_or_default();
            ensure!(
                requests.len() <= 16,
                "MCP input request count exceeds budget; outcome is UNKNOWN"
            );
            let mut responses = InputResponses::new();
            for (key, input_request) in requests {
                (owner.guard)().await?;
                let InputRequest::Elicitation(elicit) = input_request else {
                    bail!("Unadvertised MCP input request; outcome is UNKNOWN");
                };
                let params = serde_json::to_value(elicit)?["params"].clone();
                let broker = self
                    .broker
                    .context("MCP elicitation unavailable; outcome is UNKNOWN")?;
                let response = tokio::select! {biased;
                    _=operation.cancelled()=>bail!("MCP operation cancelled; outcome is UNKNOWN"),
                    _=self.revoked.cancelled()=>bail!("MCP generation revoked; outcome is UNKNOWN"),
                    _=&mut deadline=>bail!("MCP operation timed out; outcome is UNKNOWN"),
                    r=broker.request_owned(self.server,self.generation,Value::String(key.clone()),params,owner.token.clone(),operation.clone(),self.revoked.clone())=>r?,
                };
                responses.insert(key, response);
            }
            // Empty input lists may be load shedding; bound and back off rather than spin.
            if responses.is_empty() {
                tokio::select! { biased; _=operation.cancelled()=>bail!("MCP operation cancelled; outcome is UNKNOWN"), _=self.revoked.cancelled()=>bail!("MCP generation revoked; outcome is UNKNOWN"), _=&mut deadline=>bail!("MCP operation timed out; outcome is UNKNOWN"), _=tokio::time::sleep(Duration::from_millis(100))=>{} }
            }
            let responses = (!responses.is_empty()).then_some(responses);
            match &mut request {
                ClientRequest::CallToolRequest(r) => {
                    r.params.input_responses = responses;
                    r.params.request_state = input.request_state;
                }
                ClientRequest::ReadResourceRequest(r) => {
                    r.params.input_responses = responses;
                    r.params.request_state = input.request_state;
                }
                _ => bail!("MRTR unsupported for this method; outcome is UNKNOWN"),
            }
        }
        unreachable!()
    }
}
