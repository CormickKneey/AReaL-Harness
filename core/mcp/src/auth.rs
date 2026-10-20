//! OAuth 会话与凭据留在可信 Core；公开状态没有访问令牌或刷新令牌。
use crate::AuthPolicy;
use anyhow::{Result, ensure};
use oauth2::TokenResponse;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationSession, CredentialStore, StoredCredentials,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;
#[path = "auth_transport.rs"]
mod transport;

/// Values resolved by the trusted host from private credential references.
/// This type deliberately has no serialization implementation.
#[derive(Clone, Default)]
pub struct HostAuthConfiguration {
    pub account_id: String,
    pub client_secret: Option<String>,
    pub private_key_pem: Option<String>,
    pub private_key_id: Option<String>,
    pub client_metadata_url: Option<String>,
    pub api_key: Option<String>,
    pub callback_url: Option<String>,
}
impl std::fmt::Debug for HostAuthConfiguration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HostAuthConfiguration([REDACTED])")
    }
}

#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AuthStatus {
    Pending {
        #[serde(rename = "authorizationUrl")]
        authorization_url: String,
    },
    Ready,
    Failed,
    Cancelled,
}
#[derive(Clone)]
pub struct AuthorizedCredential {
    endpoint: String,
    manager: Option<Arc<AuthorizationManager>>,
    store: Option<FileStore>,
    fixed_header: Option<(
        reqwest_mcp::header::HeaderName,
        reqwest_mcp::header::HeaderValue,
    )>,
    rejected_token: Arc<std::sync::Mutex<Option<String>>>,
    pub(crate) failed: Arc<std::sync::atomic::AtomicBool>,
    pub(crate) cancelled: CancellationToken,
}
impl std::fmt::Debug for AuthorizedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AuthorizedCredential([REDACTED])")
    }
}
impl AuthorizedCredential {
    pub(crate) async fn token(&self, endpoint: &str) -> std::result::Result<String, AuthError> {
        if url::Url::parse(endpoint).ok().as_ref() != url::Url::parse(&self.endpoint).ok().as_ref()
        {
            return Err(AuthError::AuthorizationRequired);
        }
        if self.cancelled.is_cancelled() {
            return Err(AuthError::AuthorizationRequired);
        }
        let result = async {
            let store = self
                .store
                .as_ref()
                .ok_or(AuthError::AuthorizationRequired)?;
            let manager = self
                .manager
                .as_ref()
                .ok_or(AuthError::AuthorizationRequired)?;
            let _guard = store.guard().await?;
            safe_token(manager, store).await
        }
        .with_subscriber(tracing::subscriber::NoSubscriber::default())
        .await;
        if result.is_err() {
            self.failed
                .store(true, std::sync::atomic::Ordering::Release)
        }
        result
    }
}
impl AuthorizedCredential {
    pub(crate) fn fixed_header(
        &self,
        endpoint: &str,
    ) -> std::result::Result<
        Option<(
            reqwest_mcp::header::HeaderName,
            reqwest_mcp::header::HeaderValue,
        )>,
        AuthError,
    > {
        if self.fixed_header.is_none() {
            return Ok(None);
        }
        if url::Url::parse(endpoint).ok() != url::Url::parse(&self.endpoint).ok()
            || self.cancelled.is_cancelled()
            || self.failed.load(Ordering::Acquire)
        {
            return Err(AuthError::AuthorizationRequired);
        }
        Ok(self.fixed_header.clone())
    }
    pub(crate) async fn reject(&self, token: Option<&str>) {
        self.failed.store(true, Ordering::Release);
        if let Ok(mut rejected) = self.rejected_token.lock() {
            *rejected = token.map(str::to_owned);
        }
        let Some(store) = &self.store else {
            return;
        };
        let Ok(_guard) = store.guard().await else {
            return;
        };
        if let Ok(Some(saved)) = store.load().await
            && saved
                .token_response
                .as_ref()
                .map(|t| t.access_token().secret().as_str())
                == token
        {
            let _ = store.invalidate().await;
        }
    }
}
struct Entry {
    id: u64,
    public_status: Option<AuthStatus>,
    cancel: CancellationToken,
    credential: Option<AuthorizedCredential>,
}
static NEXT_FLOW: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct AuthManager {
    root: PathBuf,
    prefix: String,
    entries: Arc<Mutex<BTreeMap<String, Entry>>>,
}
impl AuthManager {
    pub fn new(root: PathBuf, key_prefix: &str) -> Result<Self> {
        ensure!(
            !key_prefix.is_empty(),
            "OAuth credential key prefix required"
        );
        if root.exists() {
            ensure!(
                !std::fs::symlink_metadata(&root)?.file_type().is_symlink(),
                "OAuth credential directory cannot be a symlink"
            );
        }
        std::fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            root: std::fs::canonicalize(root)?,
            prefix: key_prefix.into(),
            entries: Arc::default(),
        })
    }
    pub async fn status(&self, name: &str) -> Option<AuthStatus> {
        self.entries.lock().await.get(name).and_then(|e| {
            if e.credential
                .as_ref()
                .is_some_and(|c| c.failed.load(std::sync::atomic::Ordering::Acquire))
            {
                Some(AuthStatus::Failed)
            } else {
                e.public_status.clone()
            }
        })
    }
    pub async fn cancel(&self, name: &str) {
        if let Some(e) = self.entries.lock().await.get_mut(name) {
            e.cancel.cancel();
            e.credential = None;
            e.public_status = Some(AuthStatus::Cancelled);
        }
    }
    pub async fn ready_credential(&self, name: &str) -> Result<AuthorizedCredential> {
        self.entries
            .lock()
            .await
            .get(name)
            .and_then(|e| e.credential.clone())
            .filter(|c| {
                !c.cancelled.is_cancelled() && !c.failed.load(std::sync::atomic::Ordering::Acquire)
            })
            .ok_or_else(|| anyhow::anyhow!("MCP authentication is not ready"))
    }
    pub async fn cached_credential(
        &self,
        name: &str,
        endpoint: &str,
        policy: &AuthPolicy,
        host: &HostAuthConfiguration,
    ) -> Result<Option<AuthorizedCredential>> {
        let id = NEXT_FLOW.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        {
            let mut entries = self.entries.lock().await;
            if let Some(entry) = entries.get(name) {
                return Ok(entry.credential.clone().filter(|credential| {
                    !credential.cancelled.is_cancelled()
                        && !credential.failed.load(Ordering::Acquire)
                }));
            }
            if !policy.is_supported() || policy.mode() == "api_key" {
                return Ok(None);
            }
            transport::validate_host(policy, host)?;
            entries.insert(
                name.into(),
                Entry {
                    id,
                    public_status: None,
                    cancel: cancel.clone(),
                    credential: None,
                },
            );
        }
        let prepared = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(None),
            result = tokio::time::timeout(
                Duration::from_secs(60),
                self.prepare(name, endpoint, policy, (None, None), host, PreparationIntent::CachedOnly)
                    .with_subscriber(tracing::subscriber::NoSubscriber::default()),
            ) => result
                .map_err(|_| anyhow::anyhow!("MCP credential recovery timed out"))
                .and_then(|result| result),
        };
        let mut entries = self.entries.lock().await;
        if cancel.is_cancelled()
            || !entries
                .get(name)
                .is_some_and(|entry| entry.id == id && entry.public_status.is_none())
        {
            return Ok(None);
        }
        match prepared {
            Ok(Prepared::Ready(manager, store)) => {
                let credential = AuthorizedCredential {
                    endpoint: endpoint.into(),
                    manager: Some(Arc::new(manager)),
                    store: Some(store),
                    fixed_header: None,
                    rejected_token: Arc::default(),
                    failed: Arc::default(),
                    cancelled: cancel,
                };
                let entry = entries.get_mut(name).unwrap();
                entry.public_status = Some(AuthStatus::Ready);
                entry.credential = Some(credential.clone());
                Ok(Some(credential))
            }
            Ok(Prepared::Unavailable) => {
                entries.remove(name);
                Ok(None)
            }
            Ok(_) => {
                entries.remove(name);
                Err(anyhow::anyhow!("invalid cached authentication state"))
            }
            Err(_) => {
                entries.remove(name);
                Err(anyhow::anyhow!("MCP credential recovery failed"))
            }
        }
    }
    pub async fn start(
        &self,
        name: &str,
        endpoint: &str,
        policy: &AuthPolicy,
        challenge: Option<&str>,
    ) -> Result<AuthStatus> {
        self.start_with_options(
            name,
            endpoint,
            policy,
            challenge,
            &HostAuthConfiguration::default(),
        )
        .await
    }
    pub async fn start_with_options(
        &self,
        name: &str,
        endpoint: &str,
        policy: &AuthPolicy,
        challenge: Option<&str>,
        host: &HostAuthConfiguration,
    ) -> Result<AuthStatus> {
        // Validate host-only credentials before cancelling an existing flow.
        transport::validate_host(policy, host)?;
        let id = NEXT_FLOW.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        let rejected = {
            let mut entries = self.entries.lock().await;
            let rejected = entries
                .get(name)
                .and_then(|e| e.credential.as_ref())
                .and_then(|c| c.rejected_token.lock().ok().and_then(|t| t.clone()));
            if let Some(old) = entries.get(name) {
                old.cancel.cancel();
            }
            entries.insert(
                name.into(),
                Entry {
                    id,
                    public_status: Some(AuthStatus::Pending {
                        authorization_url: String::new(),
                    }),
                    cancel: cancel.clone(),
                    credential: None,
                },
            );
            rejected
        };
        let prepared = tokio::select! {biased;_ = cancel.cancelled()=>return Ok(AuthStatus::Cancelled),r=tokio::time::timeout(Duration::from_secs(60),self.prepare(name,endpoint,policy,(challenge,rejected),host,PreparationIntent::Interactive).with_subscriber(tracing::subscriber::NoSubscriber::default()))=>r.map_err(|_|anyhow::anyhow!("MCP authentication setup timed out")).and_then(|r|r)};
        let prepared = match prepared {
            Ok(p) => p,
            Err(_) => {
                let mut entries = self.entries.lock().await;
                if !cancel.is_cancelled() && entries.get(name).is_some_and(|e| e.id == id) {
                    entries.get_mut(name).unwrap().public_status = Some(AuthStatus::Failed);
                }
                return Err(anyhow::anyhow!("MCP authentication setup failed"));
            }
        };
        let endpoint = endpoint.to_owned();
        match prepared {
            Prepared::Unavailable => Err(anyhow::anyhow!("MCP authentication is not ready")),
            Prepared::Fixed(header) => {
                let credential = AuthorizedCredential {
                    endpoint,
                    manager: None,
                    store: None,
                    fixed_header: Some(header),
                    rejected_token: Arc::default(),
                    failed: Arc::default(),
                    cancelled: cancel.clone(),
                };
                let mut entries = self.entries.lock().await;
                if cancel.is_cancelled() || entries.get(name).is_none_or(|e| e.id != id) {
                    return Ok(AuthStatus::Cancelled);
                }
                let e = entries.get_mut(name).unwrap();
                e.public_status = Some(AuthStatus::Ready);
                e.credential = Some(credential);
                Ok(AuthStatus::Ready)
            }
            Prepared::Ready(manager, store) => {
                let credential = AuthorizedCredential {
                    endpoint: endpoint.clone(),
                    manager: Some(Arc::new(manager)),
                    store: Some(store),
                    fixed_header: None,
                    rejected_token: Arc::default(),
                    failed: Arc::default(),
                    cancelled: cancel.clone(),
                };
                let mut entries = self.entries.lock().await;
                if cancel.is_cancelled() || entries.get(name).is_none_or(|e| e.id != id) {
                    return Ok(AuthStatus::Cancelled);
                }
                let e = entries.get_mut(name).unwrap();
                e.public_status = Some(AuthStatus::Ready);
                e.credential = Some(credential);
                Ok(AuthStatus::Ready)
            }
            Prepared::Pending(session, listener, store) => {
                let status = AuthStatus::Pending {
                    authorization_url: session.get_authorization_url().to_owned(),
                };
                {
                    let mut entries = self.entries.lock().await;
                    if cancel.is_cancelled() || entries.get(name).is_none_or(|e| e.id != id) {
                        return Ok(AuthStatus::Cancelled);
                    }
                    entries.get_mut(name).unwrap().public_status = Some(status.clone());
                }
                let entries = self.entries.clone();
                let name = name.to_owned();
                tokio::spawn(async move {
                    let result = tokio::select! {biased;_ = cancel.cancelled()=>return,r=tokio::time::timeout(Duration::from_secs(600),callback(&session,listener,&store).with_subscriber(tracing::subscriber::NoSubscriber::default()))=>r.ok().and_then(|r|r.ok())};
                    let mut entries = entries.lock().await;
                    if cancel.is_cancelled() || entries.get(&name).is_none_or(|e| e.id != id) {
                        return;
                    }
                    let Some(entry) = entries.get_mut(&name) else {
                        return;
                    };
                    if result.is_some() {
                        entry.credential = Some(AuthorizedCredential {
                            endpoint,
                            manager: Some(Arc::new(session.auth_manager)),
                            store: Some(store),
                            fixed_header: None,
                            rejected_token: Arc::default(),
                            failed: Arc::default(),
                            cancelled: cancel,
                        });
                        entry.public_status = Some(AuthStatus::Ready);
                    } else {
                        entry.public_status = Some(AuthStatus::Failed);
                    }
                });
                Ok(status)
            }
        }
    }
    async fn prepare(
        &self,
        name: &str,
        endpoint: &str,
        policy: &AuthPolicy,
        rejection: (Option<&str>, Option<String>),
        host: &HostAuthConfiguration,
        intent: PreparationIntent,
    ) -> Result<Prepared> {
        let (challenge, rejected) = rejection;
        ensure!(
            !policy.unsupported,
            "portable authentication mechanism requires host support"
        );
        let parsed =
            url::Url::parse(endpoint).map_err(|_| anyhow::anyhow!("invalid MCP endpoint"))?;
        ensure!(
            matches!(parsed.scheme(), "http" | "https")
                && parsed.username().is_empty()
                && parsed.password().is_none(),
            "invalid MCP endpoint"
        );
        if policy.mode() == "api_key" {
            if matches!(intent, PreparationIntent::CachedOnly) {
                return Ok(Prepared::Unavailable);
            }
            return Ok(Prepared::Fixed(transport::api_key_header(policy, host)?));
        }
        let (mut manager, metadata, mut scopes, resource_identity, refresh_scope_boundary) =
            transport::prepare_manager(
                endpoint,
                policy,
                challenge,
                host,
                matches!(intent, PreparationIntent::CachedOnly),
            )
            .await?;
        // Bind every persisted token to the trusted account, all declared configuration,
        // issuer, client identity and host credential values (hash only, never plaintext).
        let binding = serde_json::to_vec(&serde_json::json!([
            self.prefix,
            name,
            endpoint,
            policy.portable_declaration,
            policy.client_id,
            policy.client_secret,
            policy.client_metadata_url,
            policy.scopes,
            policy.callback_url,
            policy.callback_port,
            host.account_id,
            host.client_secret,
            host.private_key_pem,
            host.private_key_id,
            host.client_metadata_url,
            host.callback_url,
            metadata,
            resource_identity
        ]))
        .map_err(|_| anyhow::anyhow!("invalid auth binding"))?;
        let key = format!("{:x}", Sha256::digest(&binding));
        let store = FileStore {
            path: self.root.join(format!("{key}.json")),
            epoch: Arc::default(),
        };
        manager.set_credential_store(store.clone());
        manager.set_metadata(metadata.clone());
        let _guard = store.guard().await?;
        store.adopt()?;
        if let Some(rejected) = rejected
            && store
                .load()
                .await?
                .and_then(|s| s.token_response)
                .is_some_and(|t| t.access_token().secret() == &rejected)
        {
            store.invalidate().await?;
        }
        let saved = store.load().await?;
        // Rejected tokens cannot be reused, but their provider-confirmed grants remain
        // evidence for this exact binding. A challenge upgrades that known scope set.
        let granted_scopes = saved
            .as_ref()
            .map(|saved| saved.granted_scopes.clone())
            .unwrap_or_default();
        if matches!(intent, PreparationIntent::CachedOnly) {
            scopes = policy.scopes.clone();
            refresh_scope_boundary.set(Some(granted_scopes.clone()))?;
        }
        if challenge.is_some() {
            scopes.extend(granted_scopes.iter().cloned());
            scopes.sort();
            scopes.dedup();
            if policy.portable_declaration.is_some() {
                refresh_scope_boundary.set(Some(scopes.clone()))?;
            }
        }
        if saved.as_ref().is_some_and(|saved| {
            saved.token_response.is_some()
                && !scopes
                    .iter()
                    .all(|scope| saved.granted_scopes.contains(scope))
        }) {
            store.invalidate().await?;
        }
        let registered = store
            .load()
            .await?
            .filter(|saved| saved.issuer.as_deref() == metadata.issuer.as_deref())
            .map(|saved| saved.client_id);
        if manager
            .initialize_from_store()
            .await
            .map_err(|_| anyhow::anyhow!("OAuth credential load failed"))?
        {
            if let Some(id) = &policy.client_id {
                let mut config = rmcp::transport::auth::OAuthClientConfig::new(
                    id,
                    host.callback_url
                        .as_ref()
                        .or(policy.callback_url.as_ref())
                        .cloned()
                        .unwrap_or_else(|| "http://127.0.0.1/callback".into()),
                )
                .with_scopes(scopes.clone());
                if let Some(secret) = host
                    .client_secret
                    .as_ref()
                    .or(policy.client_secret.as_ref())
                {
                    config = config.with_client_secret(secret);
                }
                manager
                    .configure_client(config)
                    .map_err(|_| anyhow::anyhow!("OAuth client configuration failed"))?;
            }
            match safe_token(&manager, &store).await {
                Ok(_) => return Ok(Prepared::Ready(manager, store.clone())),
                Err(AuthError::AuthorizationRequired | AuthError::TokenRefreshRejected(_)) => {}
                Err(_) => return Err(anyhow::anyhow!("OAuth refresh failed")),
            }
        }
        if matches!(intent, PreparationIntent::CachedOnly) {
            return Ok(Prepared::Unavailable);
        }
        store.invalidate().await?;
        let mut redirect = url::Url::parse(
            host.callback_url
                .as_deref()
                .or(policy.callback_url.as_deref())
                .unwrap_or("http://127.0.0.1/callback"),
        )
        .map_err(|_| anyhow::anyhow!("invalid callback URL"))?;
        ensure!(
            redirect.scheme() == "http"
                && redirect.host_str() == Some("127.0.0.1")
                && redirect.username().is_empty()
                && redirect.password().is_none()
                && redirect.query().is_none()
                && redirect.fragment().is_none(),
            "OAuth callback must use local IPv4 loopback HTTP"
        );
        ensure!(
            policy.callback_port.is_none()
                || redirect.port().is_none()
                || policy.callback_port == redirect.port(),
            "conflicting callback port"
        );
        let listener = tokio::net::TcpListener::bind((
            std::net::Ipv4Addr::LOCALHOST,
            policy.callback_port.or(redirect.port()).unwrap_or(0),
        ))
        .await?;
        redirect
            .set_port(Some(listener.local_addr()?.port()))
            .map_err(|_| anyhow::anyhow!("invalid callback port"))?;
        let redirect = redirect.to_string();
        let scope_refs: Vec<&str> = scopes.iter().map(String::as_str).collect();
        let mut config = if let Some(id) = &policy.client_id {
            rmcp::transport::auth::OAuthClientConfig::new(id, &redirect).with_scopes(scopes.clone())
        } else if let Some(url) = host
            .client_metadata_url
            .as_ref()
            .or(policy.client_metadata_url.as_ref())
            && policy
                .portable_declaration
                .as_ref()
                .and_then(|v| v["client"]["mode"].as_str())
                != Some("dcr")
            && metadata
                .additional_fields
                .get("client_id_metadata_document_supported")
                .and_then(|v| v.as_bool())
                == Some(true)
        {
            rmcp::transport::auth::OAuthClientConfig::new(url, &redirect)
                .with_scopes(scopes.clone())
        } else if let Some(id) = registered {
            rmcp::transport::auth::OAuthClientConfig::new(id, &redirect).with_scopes(scopes.clone())
        } else {
            manager
                .register_client("AReaL Harness", &redirect, &scope_refs)
                .await
                .map_err(|_| anyhow::anyhow!("OAuth registration failed"))?
        };
        if let Some(secret) = host
            .client_secret
            .as_ref()
            .or(policy.client_secret.as_ref())
        {
            config = config.with_client_secret(secret);
        }
        let registered_id = config.client_id.clone();
        manager
            .configure_client(config)
            .map_err(|_| anyhow::anyhow!("OAuth client configuration failed"))?;
        // Use the SDK's PKCE/state/issuer machinery with the exact selected scope set;
        // Session::new would re-expand an explicitly empty defaults declaration.
        let authorization_url = manager
            .get_authorization_url(&scope_refs)
            .await
            .map_err(|_| anyhow::anyhow!("OAuth authorization failed"))?;
        store
            .save(
                StoredCredentials::new(registered_id, None, granted_scopes, None)
                    .with_issuer(metadata.issuer.clone()),
            )
            .await?;
        let session =
            AuthorizationSession::for_scope_upgrade(manager, authorization_url, &redirect);
        Ok(Prepared::Pending(session, listener, store.clone()))
    }
}
enum PreparationIntent {
    CachedOnly,
    Interactive,
}

enum Prepared {
    Unavailable,
    Fixed(
        (
            reqwest_mcp::header::HeaderName,
            reqwest_mcp::header::HeaderValue,
        ),
    ),
    Ready(AuthorizationManager, FileStore),
    Pending(AuthorizationSession, tokio::net::TcpListener, FileStore),
}
async fn callback(
    session: &AuthorizationSession,
    listener: tokio::net::TcpListener,
    store: &FileStore,
) -> Result<()> {
    let (mut stream, _) = listener.accept().await?;
    let mut bytes = Vec::new();
    loop {
        let mut b = [0; 1024];
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut b)).await??;
        ensure!(n > 0, "incomplete OAuth callback");
        bytes.extend_from_slice(&b[..n]);
        ensure!(bytes.len() <= 16384, "OAuth callback too large");
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let request =
        std::str::from_utf8(&bytes).map_err(|_| anyhow::anyhow!("invalid OAuth callback"))?;
    let mut parts = request.lines().next().unwrap_or("").split_whitespace();
    ensure!(parts.next() == Some("GET"), "invalid callback method");
    let target = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("missing callback path"))?;
    ensure!(
        target.starts_with('/') && !target.starts_with("//"),
        "invalid callback path"
    );
    let url = url::Url::parse(&session.redirect_uri)?.join(target)?;
    ensure!(
        url.path() == url::Url::parse(&session.redirect_uri)?.path(),
        "invalid callback path"
    );
    let mut seen = std::collections::BTreeSet::new();
    ensure!(
        url.query_pairs().all(|(k, _)| seen.insert(k.into_owned())),
        "duplicate OAuth callback parameters"
    );
    let _guard = store.guard().await?;
    store.check_epoch()?;
    let result = session.handle_callback_url(url.as_str()).await;
    let body = if result.is_ok() {
        "Authorization complete. You may close this window."
    } else {
        "Authorization failed. Return to AReaL Harness."
    };
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        if result.is_ok() {
            "200 OK"
        } else {
            "400 Bad Request"
        },
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    result
        .map(|_| ())
        .map_err(|_| anyhow::anyhow!("OAuth callback rejected"))
}
#[derive(Clone)]
struct FileStore {
    path: PathBuf,
    epoch: Arc<std::sync::Mutex<String>>,
}
fn store_error() -> AuthError {
    AuthError::CredentialStoreError("private credential storage unavailable".into())
}
#[async_trait::async_trait]
impl CredentialStore for FileStore {
    async fn load(&self) -> std::result::Result<Option<StoredCredentials>, AuthError> {
        self.check_epoch()?;
        match std::fs::symlink_metadata(&self.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(m) => {
                if !m.is_file() || m.file_type().is_symlink() || m.len() > 1024 * 1024 {
                    return Err(store_error());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if m.permissions().mode() & 0o077 != 0 {
                        return Err(store_error());
                    }
                }
            }
            Err(_) => return Err(store_error()),
        }
        let bytes = std::fs::read(&self.path).map_err(|_| store_error())?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| store_error())
    }
    async fn save(&self, credentials: StoredCredentials) -> std::result::Result<(), AuthError> {
        self.check_epoch()?;
        use std::io::Write;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let tmp = self.path.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut f = options.open(&tmp).map_err(|_| store_error())?;
            f.write_all(&serde_json::to_vec(&credentials).map_err(|_| store_error())?)
                .map_err(|_| store_error())?;
            f.sync_all().map_err(|_| store_error())?;
            std::fs::rename(&tmp, &self.path).map_err(|_| store_error())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }
    async fn clear(&self) -> std::result::Result<(), AuthError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(store_error()),
        }
    }
}

// The OS lock is shared across independent managers/processes. It is acquired by
// polling a nonblocking flock, never a blocking mutex on a Tokio worker. All SDK
// store operations are inside this boundary, including callback writes.
impl FileStore {
    async fn guard(&self) -> std::result::Result<std::fs::File, AuthError> {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(self.path.with_extension("lock"))
            .map_err(|_| store_error())?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(file),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return Err(store_error()),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(store_error());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    fn disk_epoch(&self) -> std::result::Result<String, AuthError> {
        let path = self.path.with_extension("epoch");
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
            Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= 128 => {}
            _ => return Err(store_error()),
        }
        std::fs::read_to_string(path).map_err(|_| store_error())
    }
    fn adopt(&self) -> std::result::Result<(), AuthError> {
        *self.epoch.lock().map_err(|_| store_error())? = self.disk_epoch()?;
        Ok(())
    }
    fn check_epoch(&self) -> std::result::Result<(), AuthError> {
        if *self.epoch.lock().map_err(|_| store_error())? != self.disk_epoch()? {
            return Err(AuthError::AuthorizationRequired);
        }
        Ok(())
    }
    async fn invalidate(&self) -> std::result::Result<(), AuthError> {
        self.check_epoch()?;
        let registration = self.load().await?.map(|saved| {
            StoredCredentials::new(saved.client_id, None, saved.granted_scopes, None)
                .with_issuer(saved.issuer)
        });
        // Clear first: a crash can require login, but can never revive a rejected token.
        self.clear().await?;
        let epoch = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| store_error())?
                .as_nanos()
        );
        let path = self.path.with_extension("epoch");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        use std::io::Write;
        let mut file = options.open(path).map_err(|_| store_error())?;
        file.write_all(epoch.as_bytes())
            .map_err(|_| store_error())?;
        file.sync_all().map_err(|_| store_error())?;
        *self.epoch.lock().map_err(|_| store_error())? = epoch;
        if let Some(registration) = registration {
            self.save(registration).await?;
        }
        Ok(())
    }
}
async fn safe_token(
    manager: &AuthorizationManager,
    store: &FileStore,
) -> std::result::Result<String, AuthError> {
    let saved = store
        .load()
        .await?
        .ok_or(AuthError::AuthorizationRequired)?;
    let token = saved
        .token_response
        .as_ref()
        .ok_or(AuthError::AuthorizationRequired)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| store_error())?
        .as_secs();
    let expired =
        token
            .expires_in()
            .zip(saved.token_received_at)
            .is_some_and(|(expiry, received)| {
                expiry
                    .as_secs()
                    .saturating_sub(now.saturating_sub(received))
                    < 30
            });
    if !expired {
        return Ok(token.access_token().secret().clone());
    }
    // Direct SDK refresh avoids get_access_token's provider-error logging and
    // preserves its PKCE/OAuth implementation. The authoritative reload above
    // prevents two owners from rotating the same refresh token.
    match manager.refresh_token().await {
        Ok(token) => Ok(token.access_token().secret().clone()),
        Err(AuthError::TokenRefreshRejected(_) | AuthError::AuthorizationRequired) => {
            store.invalidate().await?;
            Err(AuthError::AuthorizationRequired)
        }
        Err(_) => Err(AuthError::TokenRefreshFailed("OAuth refresh failed".into())),
    }
}
