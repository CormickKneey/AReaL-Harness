//! 原生/Core 交互所有者消费有界请求；传输层不自行接受表单或读取文件。
use crate::*;
use tokio::sync::{mpsc, oneshot};
#[derive(Clone, Debug)]
pub struct ElicitationBroker {
    sender: mpsc::Sender<ElicitationRequest>,
    pub(crate) clocks: Arc<crate::active_timeout::Clocks>,
}
#[derive(Debug)]
pub struct ElicitationRequest {
    pub server: String,
    pub generation: u64,
    pub request_id: Value,
    pub method: String,
    pub owner: Option<String>,
    pub params: Value,
    pub cancellation: CancellationToken,
    response: oneshot::Sender<Value>,
}
impl ElicitationRequest {
    pub fn respond(self, response: Value) -> Result<()> {
        ensure!(
            !self.cancellation.is_cancelled(),
            "MCP elicitation request expired"
        );
        ensure!(
            serde_json::to_vec(&response)?.len() <= 65536,
            "MCP elicitation response exceeds budget"
        );
        ensure!(
            matches!(
                response["action"].as_str(),
                Some("accept" | "decline" | "cancel")
            ),
            "invalid MCP elicitation action"
        );
        ensure!(
            response.get("content").is_none_or(|v| v.is_object()),
            "invalid MCP elicitation content"
        );
        self.response
            .send(response)
            .map_err(|_| anyhow::anyhow!("MCP elicitation request expired"))
    }
}
impl ElicitationBroker {
    pub fn channel() -> (Self, mpsc::Receiver<ElicitationRequest>) {
        let (sender, receiver) = mpsc::channel(16);
        (
            Self {
                sender,
                clocks: Arc::default(),
            },
            receiver,
        )
    }
    pub(crate) async fn request_owned(
        &self,
        server_generation: (&str, u64),
        request_id: Value,
        mut params: Value,
        owner: String,
        cancel: CancellationToken,
        revoked: CancellationToken,
    ) -> Result<Value> {
        let (server, generation) = server_generation;
        ensure!(
            serde_json::to_vec(&params)?.len() <= 65536,
            "MCP elicitation exceeds budget"
        );
        if params
            .get("mode")
            .and_then(Value::as_str)
            .is_some_and(|v| v != "form")
        {
            return Ok(serde_json::json!({"action":"decline"}));
        }
        let extended = params["_meta"]["openai/elicitation"]["requestedSchema"].clone();
        let placeholder = params["requestedSchema"]["properties"]
            .as_object()
            .is_some_and(|v| v.is_empty());
        if !extended.is_null() || placeholder {
            if !extended.is_object() {
                return Ok(serde_json::json!({"action":"decline"}));
            }
            params["requestedSchema"] = extended;
        }
        if !params["requestedSchema"].is_object() {
            return Ok(serde_json::json!({"action":"decline"}));
        }
        let cancellation = cancel.child_token();
        let _active_wait = self.clocks.pause(server, generation, Some(&owner));
        let _drop = cancellation.clone().drop_guard();
        let (tx, rx) = oneshot::channel();
        self.sender
            .try_send(ElicitationRequest {
                server: server.into(),
                generation,
                request_id,
                method: "elicitation/create".into(),
                owner: Some(owner),
                params,
                cancellation: cancellation.clone(),
                response: tx,
            })
            .map_err(|_| anyhow::anyhow!("MCP elicitation queue unavailable"))?;
        tokio::select! {biased;
            _=cancellation.cancelled()=>bail!("MCP elicitation cancelled"),
            _=revoked.cancelled()=>bail!("MCP elicitation generation revoked"),
            r=tokio::time::timeout(Duration::from_secs(120),rx)=>r.context("MCP elicitation timed out")?.context("MCP elicitation owner ended"),
        }
    }
    pub(crate) async fn request(
        &self,
        handler: &Handler,
        method: &str,
        params: Value,
        context: rmcp::service::RequestContext<RoleClient>,
    ) -> std::result::Result<Value, ErrorData> {
        let error = || ErrorData::internal_error("MCP elicitation unavailable", None);
        if serde_json::to_vec(&params).map_err(|_| error())?.len() > 65536 {
            return Err(error());
        }
        if params
            .get("mode")
            .and_then(Value::as_str)
            .is_some_and(|v| v != "form")
            || !params["requestedSchema"].is_object()
        {
            return Err(ErrorData::invalid_params(
                "Only form elicitation is supported",
                None,
            ));
        }
        let cancellation = handler.revoked.child_token();
        // Legacy reverse forms carry no backlink. Core admits one unambiguous
        // caller per server generation; modern forms use their exact owner token.
        let _active_wait = self.clocks.pause(&handler.server, handler.generation, None);
        let guard = cancellation.clone().drop_guard();
        let (tx, rx) = oneshot::channel();
        let request = ElicitationRequest {
            server: handler.server.to_string(),
            generation: handler.generation,
            request_id: serde_json::to_value(context.id).map_err(|_| error())?,
            method: method.into(),
            owner: None,
            params,
            cancellation: cancellation.clone(),
            response: tx,
        };
        self.sender.try_send(request).map_err(|_| error())?;
        let result = tokio::select! {biased;_ = cancellation.cancelled()=>Err(error()),_ = context.ct.cancelled()=>Err(error()),r=tokio::time::timeout(Duration::from_secs(120),rx)=>r.map_err(|_|error())?.map_err(|_|error())};
        drop(guard);
        result
    }
}
#[derive(Clone, Default)]
pub struct ConnectionOptions {
    pub credentials: BTreeMap<String, AuthorizedCredential>,
    pub elicitation: Option<ElicitationBroker>,
}
