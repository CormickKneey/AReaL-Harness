// 固定协商 2025-11-25；2026 subscriptions/listen 未宣告。
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
    info: Arc<ServerPeerInfo>,
    peer: Peer<RoleClient>,
    revoked: CancellationToken,
    timeout: Option<Duration>,
    auth_failed: Arc<AtomicBool>,
    auth_rejected: http::AuthRejections,
    updates: tokio::sync::broadcast::Sender<ResourceUpdate>,
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
            info: service.peer_info().expect("initialized service").clone(),
            peer: service.peer().clone(),
            revoked: service.service().revoked.clone(),
            timeout: timeout.map(Duration::from_millis),
            auth_failed: service.service().auth_failed.clone(),
            auth_rejected: service.service().auth_rejected.clone(),
            updates: service.service().resource_updates.clone(),
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
        let deadline = async {
            match self.timeout {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(deadline);
        let mut handle = tokio::select! {biased;_ = cancel.cancelled()=>bail!("MCP resource request cancelled before submission"),_ = self.revoked.cancelled()=>bail!("MCP generation revoked before submission"),_=&mut deadline=>bail!("MCP resource submission timed out; outcome is UNKNOWN"),h=self.peer.send_cancellable_request(request,PeerRequestOptions::no_options())=>h.map_err(|_|anyhow::anyhow!("MCP resource submission failed; outcome is UNKNOWN"))?};
        let request_id = handle.id.clone();
        let result = tokio::select! {biased;_ = cancel.cancelled()=>None,_ = self.revoked.cancelled()=>None,_=&mut deadline=>None,r=&mut handle.rx=>Some(r)};
        let Some(result) = result else {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                handle.cancel(Some("resource request cancelled".into())),
            )
            .await;
            if http::take_rejection(&self.auth_rejected, &request_id) {
                return Err(AuthenticationFailed.into());
            }
            bail!("MCP resource request interrupted; outcome is UNKNOWN")
        };
        let rejected = http::take_rejection(&self.auth_rejected, &request_id);
        if rejected && !matches!(&result, Ok(Ok(_))) {
            return Err(AuthenticationFailed.into());
        }
        let result = result
            .map_err(|_| anyhow::anyhow!("MCP resource disconnected; outcome is UNKNOWN"))?
            .map_err(|_| anyhow::anyhow!("MCP resource failed; outcome is UNKNOWN"))?;
        ensure!(
            serde_json::to_vec(&result)?.len() <= 24 * 1024 * 1024,
            "MCP resource response exceeds budget"
        );
        Ok(result)
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
        ensure!(uri.len() <= 8192, "resource URI exceeds budget");
        match self
            .request(
                ClientRequest::ReadResourceRequest(ReadResourceRequest::new(
                    ReadResourceRequestParams::new(uri),
                )),
                cancel,
            )
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
