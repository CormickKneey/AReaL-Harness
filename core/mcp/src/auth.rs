//! OAuth 会话与凭据留在可信 Core；公开状态没有访问令牌或刷新令牌。
use crate::AuthPolicy;
use anyhow::{Result, ensure};
use oauth2::TokenResponse;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore,
    StoredCredentials,
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

#[derive(Clone, Debug, Serialize)]
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
    manager: Arc<AuthorizationManager>,
    store: FileStore,
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
            let _guard = self.store.guard().await?;
            safe_token(&self.manager, &self.store).await
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
    pub(crate) async fn reject(&self, token: Option<&str>) {
        self.failed.store(true, Ordering::Release);
        if let Ok(mut rejected) = self.rejected_token.lock() {
            *rejected = token.map(str::to_owned);
        }
        let Ok(_guard) = self.store.guard().await else {
            return;
        };
        if let Ok(Some(saved)) = self.store.load().await {
            if saved
                .token_response
                .as_ref()
                .map(|t| t.access_token().secret().as_str())
                == token
            {
                let _ = self.store.invalidate().await;
            }
        }
    }
}
struct Entry {
    id: u64,
    status: AuthStatus,
    cancel: CancellationToken,
    credential: Option<AuthorizedCredential>,
}
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
        self.entries.lock().await.get(name).map(|e| {
            if e.credential
                .as_ref()
                .is_some_and(|c| c.failed.load(std::sync::atomic::Ordering::Acquire))
            {
                AuthStatus::Failed
            } else {
                e.status.clone()
            }
        })
    }
    pub async fn cancel(&self, name: &str) {
        if let Some(e) = self.entries.lock().await.get_mut(name) {
            e.cancel.cancel();
            e.credential = None;
            e.status = AuthStatus::Cancelled;
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
    pub async fn start(
        &self,
        name: &str,
        endpoint: &str,
        policy: &AuthPolicy,
        challenge: Option<&str>,
    ) -> Result<AuthStatus> {
        static NEXT_FLOW: AtomicU64 = AtomicU64::new(1);
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
                    status: AuthStatus::Pending {
                        authorization_url: String::new(),
                    },
                    cancel: cancel.clone(),
                    credential: None,
                },
            );
            rejected
        };
        let prepared = tokio::select! {biased;_ = cancel.cancelled()=>return Ok(AuthStatus::Cancelled),r=tokio::time::timeout(Duration::from_secs(60),self.prepare(name,endpoint,policy,challenge,rejected).with_subscriber(tracing::subscriber::NoSubscriber::default()))=>r.map_err(|_|anyhow::anyhow!("MCP authentication setup timed out")).and_then(|r|r)};
        let prepared = match prepared {
            Ok(p) => p,
            Err(_) => {
                let mut entries = self.entries.lock().await;
                if !cancel.is_cancelled() && entries.get(name).is_some_and(|e| e.id == id) {
                    entries.get_mut(name).unwrap().status = AuthStatus::Failed;
                }
                return Err(anyhow::anyhow!("MCP authentication setup failed"));
            }
        };
        let endpoint = endpoint.to_owned();
        match prepared {
            Prepared::Ready(manager, store) => {
                let credential = AuthorizedCredential {
                    endpoint: endpoint.clone(),
                    manager: Arc::new(manager),
                    store,
                    rejected_token: Arc::default(),
                    failed: Arc::default(),
                    cancelled: cancel.clone(),
                };
                let mut entries = self.entries.lock().await;
                if cancel.is_cancelled() || !entries.get(name).is_some_and(|e| e.id == id) {
                    return Ok(AuthStatus::Cancelled);
                }
                let e = entries.get_mut(name).unwrap();
                e.status = AuthStatus::Ready;
                e.credential = Some(credential);
                Ok(AuthStatus::Ready)
            }
            Prepared::Pending(session, listener, store) => {
                let status = AuthStatus::Pending {
                    authorization_url: session.get_authorization_url().to_owned(),
                };
                {
                    let mut entries = self.entries.lock().await;
                    if cancel.is_cancelled() || !entries.get(name).is_some_and(|e| e.id == id) {
                        return Ok(AuthStatus::Cancelled);
                    }
                    entries.get_mut(name).unwrap().status = status.clone();
                }
                let entries = self.entries.clone();
                let name = name.to_owned();
                tokio::spawn(async move {
                    let result = tokio::select! {biased;_ = cancel.cancelled()=>return,r=tokio::time::timeout(Duration::from_secs(600),callback(&session,listener,&store).with_subscriber(tracing::subscriber::NoSubscriber::default()))=>r.ok().and_then(|r|r.ok())};
                    let mut entries = entries.lock().await;
                    if cancel.is_cancelled() || !entries.get(&name).is_some_and(|e| e.id == id) {
                        return;
                    }
                    let Some(entry) = entries.get_mut(&name) else {
                        return;
                    };
                    if result.is_some() {
                        entry.credential = Some(AuthorizedCredential {
                            endpoint,
                            manager: Arc::new(session.auth_manager),
                            store,
                            rejected_token: Arc::default(),
                            failed: Arc::default(),
                            cancelled: cancel,
                        });
                        entry.status = AuthStatus::Ready;
                    } else {
                        entry.status = AuthStatus::Failed;
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
        challenge: Option<&str>,
        rejected: Option<String>,
    ) -> Result<Prepared> {
        ensure!(
            !policy.unsupported,
            "portable authentication mechanism requires host support"
        );
        let _declaration = &policy.portable_declaration;
        let parsed =
            url::Url::parse(endpoint).map_err(|_| anyhow::anyhow!("invalid MCP endpoint"))?;
        ensure!(
            matches!(parsed.scheme(), "http" | "https")
                && parsed.username().is_empty()
                && parsed.password().is_none(),
            "invalid MCP endpoint"
        );
        let mut manager = AuthorizationManager::new(endpoint)
            .await
            .map_err(|_| anyhow::anyhow!("OAuth manager unavailable"))?;
        let key = format!(
            "{:x}",
            Sha256::digest(format!("{}\0{name}\0{endpoint}", self.prefix))
        );
        let store = FileStore {
            path: self.root.join(format!("{key}.json")),
            epoch: Arc::default(),
        };
        manager.set_credential_store(store.clone());
        let metadata = manager
            .resolve_metadata_from_challenge(challenge)
            .await
            .map_err(|_| anyhow::anyhow!("OAuth discovery failed"))?;
        ensure!(
            metadata.source.is_discovered(),
            "OAuth discovery required; guessed endpoints are not accepted"
        );
        manager.set_metadata(metadata.metadata);
        let _guard = store.guard().await?;
        store.adopt()?;
        if let Some(rejected) = rejected {
            if store
                .load()
                .await?
                .and_then(|s| s.token_response)
                .is_some_and(|t| t.access_token().secret() == &rejected)
            {
                store.invalidate().await?;
            }
        }
        if manager
            .initialize_from_store()
            .await
            .map_err(|_| anyhow::anyhow!("OAuth credential load failed"))?
        {
            if let Some(id) = &policy.client_id {
                let mut config = rmcp::transport::auth::OAuthClientConfig::new(
                    id,
                    policy
                        .callback_url
                        .clone()
                        .unwrap_or_else(|| "http://127.0.0.1/callback".into()),
                )
                .with_scopes(policy.scopes.clone());
                if let Some(secret) = &policy.client_secret {
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
        store.invalidate().await?;
        let mut redirect = url::Url::parse(
            policy
                .callback_url
                .as_deref()
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
        let mut request = AuthorizationRequest::new(redirect)
            .with_client_name("AReaL Harness")
            .with_scopes(policy.scopes.clone());
        if let Some(id) = &policy.client_id {
            request = request.with_preregistered_client(id);
        }
        if let Some(secret) = &policy.client_secret {
            request = request.with_client_secret(secret);
        }
        if let Some(url) = &policy.client_metadata_url {
            request = request.with_client_metadata_url(url);
        }
        if let Some(challenge) = challenge {
            request = request.with_challenge(challenge);
        }
        let session = AuthorizationSession::new(manager, request)
            .await
            .map_err(|_| anyhow::anyhow!("OAuth client registration failed"))?;
        Ok(Prepared::Pending(session, listener, store.clone()))
    }
}
enum Prepared {
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
