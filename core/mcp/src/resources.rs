// Resource reads share the same caller-owned MRTR transport as tool calls.
#![allow(deprecated)]
use crate::*;
#[derive(Clone, Debug, serde::Serialize)]
pub struct ResourceUpdate {
    pub server: String,
    pub generation: u64,
    pub uri: String,
}
#[derive(Debug)]
pub struct ResourceUpdates {
    receiver: tokio::sync::broadcast::Receiver<ResourceUpdate>,
    revoked: CancellationToken,
}
impl ResourceUpdates {
    pub async fn recv(&mut self, cancel: CancellationToken) -> Result<ResourceUpdate> {
        tokio::select! {biased;_ = self.revoked.cancelled()=>bail!("MCP resource generation revoked"),_ = cancel.cancelled()=>bail!("MCP resource update wait cancelled"),update=self.receiver.recv()=>update.map_err(|_|anyhow::anyhow!("MCP resource updates lost; read the authoritative resource again"))}
    }
}

/// 资源句柄与工具共享同一代连接；停止后旧克隆不能再次提交请求。
#[derive(Clone, Debug)]
pub struct McpServer {
    name: Arc<str>,
    generation: u64,
    local_stdio: bool,
    info: Arc<ServerPeerInfo>,
    peer: Peer<RoleClient>,
    revoked: CancellationToken,
    timeout: Option<Duration>,
    auth_failed: Arc<AtomicBool>,
    auth_rejected: http::AuthRejections,
    auth_challenge: http::AuthChallenge,
    sent_credentials: http::SentCredentials,
    updates: tokio::sync::broadcast::Sender<ResourceUpdate>,
    elicitation: Option<ElicitationBroker>,
}
impl McpServer {
    pub(crate) fn new(
        name: &str,
        service: &RunningService<RoleClient, Handler>,
        timeout: Option<u64>,
    ) -> Self {
        Self {
            name: name.into(),
            generation: service.service().generation,
            local_stdio: service.service().local_stdio,
            info: service.peer_info().expect("initialized service").clone(),
            peer: service.peer().clone(),
            revoked: service.service().revoked.clone(),
            timeout: timeout.map(Duration::from_millis),
            auth_failed: service.service().auth_failed.clone(),
            auth_rejected: service.service().auth_rejected.clone(),
            auth_challenge: service.service().auth_challenge.clone(),
            sent_credentials: service.service().sent_credentials.clone(),
            updates: service.service().resource_updates.clone(),
            elicitation: service.service().elicitation.clone(),
        }
    }
    pub fn resource_updates(&self) -> ResourceUpdates {
        ResourceUpdates {
            receiver: self.updates.subscribe(),
            revoked: self.revoked.clone(),
        }
    }
    pub async fn call_app_tool(
        &self,
        tool: &McpTool,
        arguments: Value,
        host_meta: Option<serde_json::Map<String, Value>>,
        cancel: CancellationToken,
    ) -> Result<CallToolResult> {
        ensure!(
            !self.is_revoked()
                && tool.server_name() == self.name()
                && tool.generation() == self.generation
                && tool.is_app_visible(),
            "MCP App tool is outside the live server generation"
        );
        tool.call_raw_with_meta(arguments, host_meta, cancel).await
    }
    pub fn authentication_required(&self) -> bool {
        self.auth_failed.load(Ordering::Acquire)
    }
    pub fn authentication_challenge(&self) -> Option<String> {
        self.auth_challenge.get()
    }
    pub fn is_local_stdio(&self) -> bool {
        self.local_stdio
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn info(&self) -> &ServerPeerInfo {
        &self.info
    }
    pub fn is_revoked(&self) -> bool {
        self.revoked.is_cancelled()
    }
    pub fn revoke(&self) {
        self.revoked.cancel()
    }
    async fn request(
        &self,
        request: ClientRequest,
        cancel: CancellationToken,
    ) -> Result<ServerResult> {
        if self.auth_failed.load(Ordering::Acquire) {
            return Err(AuthenticationFailed.into());
        }
        ensure!(
            self.info.capabilities.resources.is_some(),
            "MCP server does not advertise resources"
        );
        ensure!(!self.is_revoked(), "MCP connection generation revoked");
        mrtr::RequestChannel {
            peer: &self.peer,
            server: &self.name,
            generation: self.generation,
            revoked: &self.revoked,
            auth_failed: &self.auth_failed,
            auth_rejected: &self.auth_rejected,
            auth_challenge: &self.auth_challenge,
            sent_credentials: &self.sent_credentials,
            timeout: self.timeout,
            broker: self.elicitation.as_ref(),
        }
        .exchange(request, None, cancel)
        .await
    }

    pub async fn list_resources(
        &self,
        cursor: Option<String>,
        cancel: CancellationToken,
    ) -> Result<ListResourcesResult> {
        match self
            .request(
                ClientRequest::ListResourcesRequest(ListResourcesRequest::with_param(
                    PaginatedRequestParams::default().with_cursor(cursor),
                )),
                cancel,
            )
            .await?
        {
            ServerResult::ListResourcesResult(r) => Ok(r),
            _ => bail!("unexpected MCP resources result"),
        }
    }
    pub async fn list_resource_templates(
        &self,
        cursor: Option<String>,
        cancel: CancellationToken,
    ) -> Result<ListResourceTemplatesResult> {
        match self
            .request(
                ClientRequest::ListResourceTemplatesRequest(
                    ListResourceTemplatesRequest::with_param(
                        PaginatedRequestParams::default().with_cursor(cursor),
                    ),
                ),
                cancel,
            )
            .await?
        {
            ServerResult::ListResourceTemplatesResult(r) => Ok(r),
            _ => bail!("unexpected MCP templates result"),
        }
    }
    pub async fn read_resource(
        &self,
        uri: &str,
        cancel: CancellationToken,
    ) -> Result<ReadResourceResult> {
        self.read_resource_owned(uri, cancel, None).await
    }
    pub async fn read_resource_owned(
        &self,
        uri: &str,
        cancel: CancellationToken,
        owner: Option<&RequestOwner>,
    ) -> Result<ReadResourceResult> {
        ensure!(uri.len() <= 8192, "resource URI exceeds budget");
        ensure!(
            self.info.capabilities.resources.is_some(),
            "MCP resources unavailable"
        );
        let request = ClientRequest::ReadResourceRequest(ReadResourceRequest::new(
            ReadResourceRequestParams::new(uri),
        ));
        match (mrtr::RequestChannel {
            peer: &self.peer,
            server: &self.name,
            generation: self.generation,
            revoked: &self.revoked,
            auth_failed: &self.auth_failed,
            auth_rejected: &self.auth_rejected,
            auth_challenge: &self.auth_challenge,
            sent_credentials: &self.sent_credentials,
            timeout: self.timeout,
            broker: self.elicitation.as_ref(),
        })
        .exchange(request, owner, cancel)
        .await?
        {
            ServerResult::ReadResourceResult(r) => Ok(r),
            _ => bail!("unexpected MCP read result"),
        }
    }
    pub async fn subscribe(&self, uri: &str, cancel: CancellationToken) -> Result<()> {
        ensure!(
            self.info
                .capabilities
                .resources
                .as_ref()
                .is_some_and(|r| r.subscribe == Some(true)),
            "MCP subscriptions unsupported"
        );
        ensure!(uri.len() <= 8192, "resource URI exceeds budget");
        self.request(
            ClientRequest::SubscribeRequest(SubscribeRequest::new(SubscribeRequestParams::new(
                uri,
            ))),
            cancel,
        )
        .await?;
        Ok(())
    }
    pub async fn unsubscribe(&self, uri: &str, cancel: CancellationToken) -> Result<()> {
        ensure!(uri.len() <= 8192, "resource URI exceeds budget");
        self.request(
            ClientRequest::UnsubscribeRequest(UnsubscribeRequest::new(
                UnsubscribeRequestParams::new(uri),
            )),
            cancel,
        )
        .await?;
        Ok(())
    }
}
