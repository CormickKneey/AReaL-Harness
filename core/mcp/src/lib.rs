//! MCP tool client. Transport/lifecycle belong here, model and Turn state stay in Engine.
mod config;
mod elicitation;
pub use elicitation::{ConnectionOptions, ElicitationBroker, ElicitationRequest};
mod http;
pub use http::{AuthenticationFailed, HttpFailure};

/// Sanitized initialization evidence: never includes SDK messages, URLs or payloads.
#[derive(Debug)]
pub struct InitializationFailure {
    pub kind: &'static str,
    /// Last observed HTTP failure during startup; diagnostic only, never call acceptance evidence.
    pub http: Option<HttpFailure>,
}
impl std::fmt::Display for InitializationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MCP initialization failed ({})", self.kind)?;
        if let Some(http) = &self.http {
            write!(f, "; last HTTP failure {}", http.kind)?;
            if let Some(status) = http.status {
                write!(f, ": {status}")?;
            }
        }
        Ok(())
    }
}
impl std::error::Error for InitializationFailure {}
mod auth;
pub use auth::{AuthManager, AuthStatus, AuthorizedCredential};
mod resources;
pub use resources::{McpServer, ResourceUpdate, ResourceUpdates};
mod plugin;
use anyhow::{Context, Result, bail, ensure};
use areal_protocol::{DynamicToolResponse, ToolContent, ToolDefinition};
pub use config::{ServerConfig, TransportConfig, validate};
pub use plugin::{
    ApprovalMode, AuthPolicy, PluginConfigOutcome, PluginDiagnostic, PluginPolicy,
    PluginServerConfig, ToolPolicy, normalize_plugin_document,
};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
    model::*,
    service::{NotificationContext, Peer, PeerRequestOptions, RunningService},
    transport::{
        StreamableHttpClientTransport, TokioChildProcess,
        streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsString,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
struct Handler {
    server: Arc<str>,
    resource_updates: tokio::sync::broadcast::Sender<ResourceUpdate>,
    elicitation: Option<ElicitationBroker>,
    changed: Arc<AtomicBool>,
    revoked: CancellationToken,
    generation: u64,
    auth_failed: Arc<AtomicBool>,
    auth_rejected: http::AuthRejections,
}
impl ClientHandler for Handler {
    fn get_info(&self) -> ClientInfo {
        ClientInfo::new(
            {
                let mut capabilities = ClientCapabilities::default();
                capabilities.extensions = Some(
                    [(
                        "io.modelcontextprotocol/ui".into(),
                        serde_json::json!({"mimeTypes":["text/html;profile=mcp-app"]})
                            .as_object()
                            .unwrap()
                            .clone(),
                    )]
                    .into(),
                );
                if self.elicitation.is_some() {
                    capabilities.elicitation = Some(
                        ElicitationCapability::default()
                            .with_form(FormElicitationCapability::default()),
                    );
                    capabilities.extensions.as_mut().unwrap().insert(
                        "openai/elicitation".into(),
                        serde_json::json!({"form":{}}).as_object().unwrap().clone(),
                    );
                }
                capabilities
            },
            Implementation::new("areal-harness", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }
    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        context: rmcp::service::RequestContext<RoleClient>,
    ) -> std::result::Result<ElicitResult, ErrorData> {
        let Some(broker) = &self.elicitation else {
            return Ok(ElicitResult::new(ElicitationAction::Decline));
        };
        let params = serde_json::to_value(request)
            .map_err(|_| ErrorData::invalid_params("Invalid elicitation", None))?;
        let value = broker
            .request(self, "elicitation/create", params, context)
            .await?;
        serde_json::from_value(value)
            .map_err(|_| ErrorData::invalid_params("Invalid elicitation response", None))
    }
    async fn on_custom_request(
        &self,
        request: CustomRequest,
        context: rmcp::service::RequestContext<RoleClient>,
    ) -> std::result::Result<CustomResult, ErrorData> {
        if request.method != "openai/elicitation/create" {
            return Err(ErrorData::new(
                ErrorCode::METHOD_NOT_FOUND,
                "Unsupported MCP extension",
                None,
            ));
        }
        let broker = self.elicitation.as_ref().ok_or_else(|| {
            ErrorData::new(
                ErrorCode::METHOD_NOT_FOUND,
                "MCP elicitation unavailable",
                None,
            )
        })?;
        broker
            .request(
                self,
                &request.method,
                request.params.unwrap_or(Value::Null),
                context,
            )
            .await
            .map(CustomResult)
    }
    async fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        _: NotificationContext<RoleClient>,
    ) {
        if !self.revoked.is_cancelled() && params.uri.len() <= 8192 {
            let _ = self.resource_updates.send(ResourceUpdate {
                server: self.server.to_string(),
                generation: self.generation,
                uri: params.uri,
            });
        }
    }
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        // An active Turn must keep the schema the model actually saw.
        self.changed.store(true, Ordering::Release);
    }
}

#[derive(Clone, Debug)]
pub struct McpTool {
    pub definition: ToolDefinition,
    server: Arc<str>,
    original_name: String,
    peer: Peer<RoleClient>,
    changed: Arc<AtomicBool>,
    timeout: Option<Duration>,
    revoked: CancellationToken,
    generation: u64,
    auth_failed: Arc<AtomicBool>,
    auth_rejected: http::AuthRejections,
    metadata: Tool,
    approval: Option<ApprovalMode>,
}
impl McpTool {
    pub fn is_stale(&self) -> bool {
        self.changed.load(Ordering::Acquire)
    }
    pub fn server_name(&self) -> &str {
        &self.server
    }
    pub fn original_name(&self) -> &str {
        &self.original_name
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn metadata(&self) -> &Tool {
        &self.metadata
    }
    pub fn approval_mode(&self) -> Option<&ApprovalMode> {
        self.approval.as_ref()
    }
    pub fn is_app_visible(&self) -> bool {
        self.app_visible()
    }
    pub fn app_visible(&self) -> bool {
        let value = serde_json::to_value(&self.metadata).unwrap_or(Value::Null);
        value["_meta"]["ui"]["visibility"]
            .as_array()
            .is_none_or(|v| v.iter().any(|v| v == "app"))
    }
    pub async fn call(
        &self,
        arguments: Value,
        cancel: CancellationToken,
    ) -> Result<DynamicToolResponse> {
        convert_result(serde_json::to_value(
            self.call_raw(arguments, cancel).await?,
        )?)
    }
    pub async fn call_raw(
        &self,
        arguments: Value,
        cancel: CancellationToken,
    ) -> Result<CallToolResult> {
        self.call_raw_with_meta(arguments, None, cancel).await
    }
    /// 元数据仅允许由可信宿主构造；调用方必须先剥离 App 提交的文件路径。
    pub async fn call_raw_with_meta(
        &self,
        arguments: Value,
        host_meta: Option<serde_json::Map<String, Value>>,
        cancel: CancellationToken,
    ) -> Result<CallToolResult> {
        if self.auth_failed.load(Ordering::Acquire) {
            return Err(AuthenticationFailed.into());
        }
        ensure!(
            !self.revoked.is_cancelled(),
            "MCP connection generation revoked"
        );
        ensure!(
            !self.changed.load(Ordering::Acquire),
            "MCP tool directory invalidated; reconnect at an idle boundary"
        );
        let arguments = arguments
            .as_object()
            .context("MCP arguments must be an object")?
            .clone();
        let mut params =
            CallToolRequestParams::new(self.original_name.clone()).with_arguments(arguments);
        if let Some(meta) = host_meta {
            ensure!(
                serde_json::to_vec(&meta)?.len() <= 65536,
                "MCP request metadata exceeds budget"
            );
            params.meta = Some(
                serde_json::from_value(Value::Object(meta))
                    .map_err(|_| anyhow::anyhow!("invalid MCP request metadata"))?,
            );
        }
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(params));
        // Use the SDK's single cancellable request, without automatic MRTR resubmission.
        let deadline = async {
            match self.timeout {
                Some(duration) => tokio::time::sleep(duration).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(deadline);
        let mut handle = tokio::select! {
            biased;
            _ = cancel.cancelled() => bail!("MCP call cancelled before submission"),
            _ = self.revoked.cancelled() => bail!("MCP connection generation revoked before submission"),
            _ = &mut deadline => bail!("MCP request submission timed out; outcome is UNKNOWN"),
            handle = self.peer.send_cancellable_request(request, PeerRequestOptions::no_options()) => handle.map_err(|_| anyhow::anyhow!("MCP {} request could not be submitted; outcome is UNKNOWN", self.server))?,
        };
        let request_id = handle.id.clone();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            _ = self.revoked.cancelled() => None,
            _ = &mut deadline => None,
            result = &mut handle.rx => Some(result),
        };
        let Some(result) = result else {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                handle.cancel(Some("AReaL tool timeout or cancellation".into())),
            )
            .await;
            if http::take_rejection(&self.auth_rejected, &request_id) {
                return Err(AuthenticationFailed.into());
            }
            bail!(
                "MCP {} call cancelled or timed out; outcome is UNKNOWN",
                self.server
            );
        };
        let rejected = http::take_rejection(&self.auth_rejected, &request_id);
        if rejected && !matches!(&result, Ok(Ok(_))) {
            return Err(AuthenticationFailed.into());
        }
        let result = result
            .map_err(|_| anyhow::anyhow!("MCP {} disconnected; outcome is UNKNOWN", self.server))?
            .map_err(|_| {
                anyhow::anyhow!(
                    "MCP {} returned a protocol/transport error; outcome is UNKNOWN",
                    self.server
                )
            })?;
        let ServerResult::CallToolResult(result) = result else {
            bail!("MCP returned an incomplete or unexpected result; outcome is UNKNOWN");
        };
        let value = serde_json::to_value(&result)?;
        ensure!(
            serde_json::to_vec(&value)?.len() <= 24 * 1024 * 1024,
            "MCP result exceeds 24 MiB; outcome is UNKNOWN"
        );
        Ok(result)
    }
}

pub fn project_result(result: &CallToolResult) -> Result<DynamicToolResponse> {
    convert_result(serde_json::to_value(result)?)
}

fn convert_result(value: Value) -> Result<DynamicToolResponse> {
    let mut items = Vec::new();
    for content in value["content"]
        .as_array()
        .context("MCP result is not a completed tools/call response")?
    {
        match content["type"].as_str() {
            Some("text") => items.push(ToolContent::InputText {
                text: content["text"].as_str().context("invalid MCP text")?.into(),
            }),
            Some("image" | "audio") => items.push(ToolContent::InlineMedia {
                modality: if content["type"] == "image" {
                    areal_protocol::Modality::Image
                } else {
                    areal_protocol::Modality::Audio
                },
                mime_type: content["mimeType"]
                    .as_str()
                    .context("missing MCP media MIME")?
                    .into(),
                data_base64: content["data"]
                    .as_str()
                    .context("missing MCP media data")?
                    .into(),
            }),
            Some("resource") if content["resource"]["blob"].is_string() => {
                items.push(ToolContent::InlineMedia {
                    modality: areal_protocol::Modality::File,
                    mime_type: content["resource"]["mimeType"]
                        .as_str()
                        .context("missing MCP resource MIME")?
                        .into(),
                    data_base64: content["resource"]["blob"].as_str().unwrap().into(),
                })
            }
            Some("resource") if content["resource"]["text"].is_string() => {
                items.push(ToolContent::InputText {
                    text: content.to_string(),
                })
            }
            Some("resource_link") => items.push(ToolContent::InputText {
                text: content.to_string(),
            }),
            _ => bail!("MCP returned unsupported non-text content; outcome is UNKNOWN"),
        }
    }
    let text_bytes: usize = items
        .iter()
        .map(|item| match item {
            ToolContent::InputText { text } => text.len(),
            _ => 0,
        })
        .sum();
    ensure!(
        text_bytes
            + value
                .get("structuredContent")
                .map_or(0, |v| v.to_string().len())
            <= areal_protocol::MAX_TOOL_RESULT_BYTES,
        "MCP text result exceeds 8 MiB; outcome is UNKNOWN"
    );
    Ok(DynamicToolResponse {
        success: !value["isError"].as_bool().unwrap_or(false),
        content_items: items,
        structured_content: value.get("structuredContent").cloned(),
    })
}

/// Redacted failure of an optional package server. Never includes provider text.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ConnectionFailure {
    pub server: String,
    pub class: &'static str,
}

/// Owns live connections. Required failures roll back all earlier connections.
pub struct Connections {
    services: Vec<RunningService<RoleClient, Handler>>,
    tools: Vec<McpTool>,
    servers: Vec<McpServer>,
    failures: Vec<ConnectionFailure>,
}
impl Connections {
    pub async fn connect(
        servers: &BTreeMap<String, ServerConfig>,
        env: &BTreeMap<OsString, OsString>,
        base: &Path,
        cancel: CancellationToken,
    ) -> Result<Self> {
        Self::connect_inner(
            servers,
            &BTreeMap::new(),
            &ConnectionOptions::default(),
            env,
            base,
            cancel,
        )
        .await
    }
    pub async fn connect_plugins(
        servers: &BTreeMap<String, PluginServerConfig>,
        env: &BTreeMap<OsString, OsString>,
        base: &Path,
        cancel: CancellationToken,
    ) -> Result<Self> {
        let configs = servers
            .iter()
            .filter(|(_, s)| s.policy.enabled)
            .map(|(n, s)| (n.clone(), s.config.clone()))
            .collect();
        Self::connect_inner(
            &configs,
            servers,
            &ConnectionOptions::default(),
            env,
            base,
            cancel,
        )
        .await
    }
    pub async fn connect_plugins_authorized(
        servers: &BTreeMap<String, PluginServerConfig>,
        credentials: &BTreeMap<String, AuthorizedCredential>,
        env: &BTreeMap<OsString, OsString>,
        base: &Path,
        cancel: CancellationToken,
    ) -> Result<Self> {
        let configs = servers
            .iter()
            .filter(|(_, s)| s.policy.enabled)
            .map(|(n, s)| (n.clone(), s.config.clone()))
            .collect();
        Self::connect_inner(
            &configs,
            servers,
            &ConnectionOptions {
                credentials: credentials.clone(),
                ..Default::default()
            },
            env,
            base,
            cancel,
        )
        .await
    }
    pub async fn connect_plugins_with_options(
        servers: &BTreeMap<String, PluginServerConfig>,
        options: &ConnectionOptions,
        env: &BTreeMap<OsString, OsString>,
        base: &Path,
        cancel: CancellationToken,
    ) -> Result<Self> {
        let configs = servers
            .iter()
            .filter(|(_, s)| s.policy.enabled)
            .map(|(n, s)| (n.clone(), s.config.clone()))
            .collect();
        Self::connect_inner(&configs, servers, options, env, base, cancel).await
    }
    async fn connect_inner(
        servers: &BTreeMap<String, ServerConfig>,
        plugins: &BTreeMap<String, PluginServerConfig>,
        options: &ConnectionOptions,
        env: &BTreeMap<OsString, OsString>,
        base: &Path,
        cancel: CancellationToken,
    ) -> Result<Self> {
        validate(servers)?;
        let mut connections = Self {
            services: Vec::new(),
            tools: Vec::new(),
            servers: Vec::new(),
            failures: Vec::new(),
        };
        for (name, config) in servers {
            let required = plugins.get(name).is_none_or(|p| p.policy.required);
            let deadline =
                tokio::time::Instant::now() + Duration::from_millis(config.startup_timeout_ms);
            let mut class = "startup";
            let connected = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(anyhow::anyhow!("MCP startup cancelled")),
                value = tokio::time::timeout_at(deadline, connect_one(name, config, plugins.get(name), options.credentials.get(name), options.elicitation.clone(), env, base)) => match value {
                    Ok(result) => result,
                    Err(_) => { class = "startupTimeout"; Err(anyhow::anyhow!("MCP startup timed out")) },
                },
            };
            // An initialized service is not published until discovery and the
            // shared tool budget succeed. Failed optional services own no handles
            // in the successful sibling catalog.
            let mut pending = None;
            let result = match connected {
                Ok(service) => {
                    pending = Some(service);
                    class = "discovery";
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => Err(anyhow::anyhow!("MCP startup cancelled")),
                        value = tokio::time::timeout_at(deadline, discover(name, config, pending.as_ref().unwrap())) => match value {
                            Ok(result) => result,
                            Err(_) => { class = "discoveryTimeout"; Err(anyhow::anyhow!("MCP discovery timed out")) },
                        },
                    }
                }
                Err(error) => Err(error),
            };
            let result = if cancel.is_cancelled() {
                Err(anyhow::anyhow!("MCP startup cancelled"))
            } else {
                result.and_then(|tools| {
                    if tools.len() + connections.tools.len() > 128 {
                        class = "toolBudget";
                        Err(anyhow::anyhow!("MCP tools exceed 128"))
                    } else {
                        Ok(tools)
                    }
                })
            };
            match result {
                Ok(mut tools) => {
                    if let Some(p) = plugins.get(name) {
                        for t in &mut tools {
                            t.approval = p
                                .policy
                                .tools
                                .get(&t.original_name)
                                .and_then(|p| p.approval_mode.clone())
                                .or_else(|| p.policy.default_tools_approval_mode.clone());
                        }
                        tools.retain(|t| {
                            !p.policy.disabled_tools.contains(&t.original_name)
                                && p.policy
                                    .tools
                                    .get(&t.original_name)
                                    .is_none_or(|p| p.enabled != Some(false))
                        });
                    }
                    let service = pending.take().unwrap();
                    connections.servers.push(McpServer::new(
                        name,
                        &service,
                        config.call_timeout_ms,
                    ));
                    connections.services.push(service);
                    connections.tools.extend(tools);
                }
                Err(error) => {
                    if error.is::<AuthenticationFailed>() {
                        class = "authentication";
                    }
                    let mut cleanup_failed = false;
                    if let Some(mut service) = pending.take() {
                        service.service().revoked.cancel();
                        cleanup_failed = !matches!(
                            service.close_with_timeout(Duration::from_secs(5)).await,
                            Ok(Some(_))
                        );
                    }
                    if required || cancel.is_cancelled() || cleanup_failed {
                        cleanup_failed |= connections.shutdown().await.is_err();
                        if cleanup_failed {
                            return Err(error.context("MCP cleanup unconfirmed"));
                        }
                        return Err(error);
                    }
                    connections.failures.push(ConnectionFailure {
                        server: name.clone(),
                        class,
                    });
                }
            }
        }
        if cancel.is_cancelled() {
            connections.shutdown().await?;
            bail!("MCP startup cancelled");
        }
        Ok(connections)
    }
    pub fn failures(&self) -> &[ConnectionFailure] {
        &self.failures
    }
    pub fn tools(&self) -> Vec<McpTool> {
        self.tools.clone()
    }
    pub fn servers(&self) -> Vec<McpServer> {
        self.servers.clone()
    }
    pub fn revoke(&self) {
        for server in &self.servers {
            server.revoke();
        }
    }
    pub async fn shutdown(&mut self) -> Result<()> {
        self.revoke();
        for tool in &self.tools {
            tool.changed.store(true, Ordering::Release);
        }
        let mut failed = false;
        for service in &mut self.services {
            failed |= !matches!(
                service.close_with_timeout(Duration::from_secs(5)).await,
                Ok(Some(_))
            );
        }
        self.services.clear();
        ensure!(!failed, "MCP shutdown could not be confirmed");
        Ok(())
    }
}

async fn connect_one(
    name: &str,
    config: &ServerConfig,
    plugin: Option<&PluginServerConfig>,
    credential: Option<&AuthorizedCredential>,
    elicitation: Option<ElicitationBroker>,
    env: &BTreeMap<OsString, OsString>,
    base: &Path,
) -> Result<RunningService<RoleClient, Handler>> {
    static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
    let handler = Handler {
        server: name.into(),
        resource_updates: tokio::sync::broadcast::channel(64).0,
        elicitation,
        changed: Arc::new(AtomicBool::new(false)),
        revoked: CancellationToken::new(),
        generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
        auth_failed: Arc::default(),
        auth_rejected: Arc::default(),
    };
    let auth_failed = handler.auth_failed.clone();
    let auth_rejected = handler.auth_rejected.clone();
    let startup_failure: http::StartupHttpFailure = Arc::default();
    let service = match &config.transport {
        TransportConfig::Stdio {
            command,
            args,
            cwd,
            env_vars,
        } => {
            let mut process = tokio::process::Command::new(command);
            process.args(args).env_clear().kill_on_drop(true);
            // 搜索等可信 MCP 工具沿用 Core 的代理；其他变量仍须显式列入 envVars。
            for key in ["PATH"].into_iter().chain(areal_config::PROXY_ENV_VARS) {
                if let Some(value) = env.get(std::ffi::OsStr::new(key)) {
                    process.env(key, value);
                }
            }
            for name in env_vars {
                process.env(
                    name,
                    env.get(std::ffi::OsStr::new(name))
                        .with_context(|| format!("missing MCP environment variable {name}"))?,
                );
            }
            if let Some(p) = plugin {
                process.envs(&p.env);
            }
            process.current_dir(
                cwd.as_ref()
                    .map_or_else(|| base.to_owned(), |p| base.join(p)),
            );
            let (transport, _) = TokioChildProcess::builder(process)
                .stderr(std::process::Stdio::null())
                .spawn()
                .with_context(|| format!("cannot start MCP {name}"))?;
            handler.serve(transport).await
        }
        TransportConfig::StreamableHttp {
            url,
            bearer_token_env,
        } => {
            let mut config = StreamableHttpClientTransportConfig::with_uri(url.clone())
                .reinit_on_expired_session(false)
                .max_sse_event_size(4 * 1024 * 1024);
            if let Some(name) = bearer_token_env {
                let token = env
                    .get(std::ffi::OsStr::new(name))
                    .and_then(|v| v.to_str())
                    .filter(|v| !v.is_empty() && v.bytes().all(|b| (0x21..=0x7e).contains(&b)))
                    .with_context(|| {
                        format!("missing or invalid MCP bearer token environment variable {name}")
                    })?;
                config = config.auth_header(token);
            }
            let mut default_headers = reqwest_mcp::header::HeaderMap::new();
            if let Some(p) = plugin {
                let mut headers = std::collections::HashMap::new();
                for (key, value) in &p.headers {
                    if key.eq_ignore_ascii_case("authorization") {
                        default_headers.insert(
                            reqwest_mcp::header::AUTHORIZATION,
                            value
                                .parse()
                                .map_err(|_| anyhow::anyhow!("invalid MCP authorization header"))?,
                        );
                        continue;
                    }
                    headers.insert(
                        key.parse()
                            .map_err(|_| anyhow::anyhow!("invalid MCP header"))?,
                        value
                            .parse()
                            .map_err(|_| anyhow::anyhow!("invalid MCP header"))?,
                    );
                }
                for (key, var) in &p.env_headers {
                    let value = env
                        .get(std::ffi::OsStr::new(var))
                        .and_then(|s| s.to_str())
                        .ok_or_else(|| anyhow::anyhow!("missing MCP header credential"))?;
                    if key.eq_ignore_ascii_case("authorization") {
                        default_headers.insert(
                            reqwest_mcp::header::AUTHORIZATION,
                            value
                                .parse()
                                .map_err(|_| anyhow::anyhow!("invalid MCP authorization header"))?,
                        );
                        continue;
                    }
                    headers.insert(
                        key.parse()
                            .map_err(|_| anyhow::anyhow!("invalid MCP header"))?,
                        value
                            .parse()
                            .map_err(|_| anyhow::anyhow!("invalid MCP header credential"))?,
                    );
                }
                config = config.custom_headers(headers);
            }
            let explicit_authorization = default_headers
                .contains_key(reqwest_mcp::header::AUTHORIZATION)
                || config.auth_header.is_some();
            let client = reqwest_mcp::Client::builder()
                .default_headers(default_headers)
                .redirect(reqwest_mcp::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()?;
            handler
                .serve(StreamableHttpClientTransport::with_client(
                    http::HttpClient {
                        client,
                        credential: if explicit_authorization {
                            None
                        } else {
                            credential.cloned()
                        },
                        failed: auth_failed.clone(),
                        rejected: auth_rejected,
                        startup_failure: startup_failure.clone(),
                    },
                    config,
                ))
                .await
        }
    };
    // SDK errors can include a private URL, headers or server-provided payloads.
    service.map_err(|error| {
        use rmcp::service::ClientInitializeError::*;
        let kind = match &error {
            ExpectedInitResponse(_) => "expected_init_response",
            ExpectedInitResult(_) => "expected_init_result",
            ConflictInitResponseId(..) | UncorrelatedErrorResponse { .. } => "response_id",
            ConnectionClosed(_) => "connection_closed",
            TransportError { .. } => "transport",
            JsonRpcError(_) => "json_rpc",
            NoCompatibleProtocolVersion { .. } | NoPreferredProtocolVersion => "protocol_version",
            Cancelled => "cancelled",
            LegacyFallbackFailed { .. } => "fallback",
            _ => "unknown",
        };
        let http = startup_failure.lock().ok().and_then(|slot| slot.clone());
        tracing::warn!(
            initialization_kind = kind,
            http_kind = http.as_ref().map(|h| h.kind),
            http_status = http.as_ref().and_then(|h| h.status),
            "MCP initialization failed"
        );
        if auth_failed.load(Ordering::Acquire) {
            AuthenticationFailed.into()
        } else {
            InitializationFailure { kind, http }.into()
        }
    })
}

async fn discover(
    name: &str,
    config: &ServerConfig,
    service: &RunningService<RoleClient, Handler>,
) -> Result<Vec<McpTool>> {
    if !service
        .peer_info()
        .is_some_and(|info| info.capabilities.tools.is_some())
    {
        return Ok(Vec::new());
    }
    let mut tools = Vec::new();
    let mut seen = HashSet::new();
    let mut cursors = HashSet::new();
    let mut cursor = None;
    for _ in 0..128 {
        let page = service
            .list_tools(Some(PaginatedRequestParams::default().with_cursor(cursor)))
            .await
            .map_err(|_| anyhow::anyhow!("MCP {name} tools/list failed"))?;
        ensure!(
            seen.len() + page.tools.len() <= 128,
            "MCP {name} advertises more than 128 tools"
        );
        for tool in page.tools {
            ensure!(
                seen.insert(tool.name.to_string()),
                "MCP {name} returned duplicate tool names"
            );
            ensure!(
                !tool.name.is_empty() && tool.name.len() <= 256,
                "invalid MCP tool name"
            );
            if config
                .enabled_tools
                .as_ref()
                .is_some_and(|enabled| !enabled.iter().any(|n| n == &*tool.name))
            {
                continue;
            }
            let alias = alias(name, &tool.name);
            let metadata = tool.clone();
            tools.push(McpTool {
                definition: ToolDefinition {
                    name: alias,
                    description: tool
                        .description
                        .map(|d| d.into_owned())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| format!("MCP {name}: {}", tool.name)),
                    input_schema: Value::Object((*tool.input_schema).clone()),
                    output_schema: tool.output_schema.map(|s| Value::Object((*s).clone())),
                },
                server: name.into(),
                original_name: tool.name.into_owned(),
                peer: service.peer().clone(),
                changed: service.service().changed.clone(),
                timeout: config.call_timeout_ms.map(Duration::from_millis),
                revoked: service.service().revoked.clone(),
                generation: service.service().generation,
                auth_failed: service.service().auth_failed.clone(),
                auth_rejected: service.service().auth_rejected.clone(),
                metadata,
                approval: None,
            });
        }
        match page.next_cursor {
            Some(next) => {
                ensure!(
                    cursors.insert(next.clone()),
                    "MCP {name} repeated pagination cursor"
                );
                cursor = Some(next);
            }
            None => {
                if let Some(enabled) = &config.enabled_tools {
                    ensure!(
                        enabled.iter().all(|n| seen.contains(n)),
                        "MCP {name} enabledTools contains an undiscovered name"
                    );
                }
                return Ok(tools);
            }
        }
    }
    bail!("MCP {name} discovery exceeded 128 pages")
}

fn alias(server: &str, tool: &str) -> String {
    let simple = format!("mcp__{server}__{tool}");
    if simple.len() <= 64
        && tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return simple;
    }
    let digest = format!("{:x}", Sha256::digest(format!("{server}\0{tool}")));
    format!("mcp__{server}__{}", &digest[..24])
}

impl Drop for Connections {
    fn drop(&mut self) {
        self.revoke();
    }
}
