//! Portable manifest overrides at the OAuth owner boundary. SDK remains the
//! owner of PKCE, callback state/issuer checks, exchange, refresh and storage.
use super::HostAuthConfiguration;
use crate::AuthPolicy;
use anyhow::{Result, ensure};
use base64::Engine;
use rmcp::transport::auth::{
    AuthorizationManager, AuthorizationMetadata, OAuthHttpClient, OAuthHttpClientFuture,
    OAuthHttpRequest,
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn declaration(policy: &AuthPolicy) -> Value {
    policy.portable_declaration.clone().unwrap_or(Value::Null)
}
fn text<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
    v.get(name).and_then(Value::as_str)
}
fn method(policy: &AuthPolicy) -> &str {
    policy
        .portable_declaration
        .as_ref()
        .and_then(|v| v["client"]["tokenEndpointAuthMethod"].as_str())
        .unwrap_or("none")
}
fn valid_url(raw: &str) -> Result<url::Url> {
    let u = url::Url::parse(raw)?;
    ensure!(
        matches!(u.scheme(), "https" | "http")
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none(),
        "invalid authentication endpoint"
    );
    Ok(u)
}
pub(super) fn validate_host(policy: &AuthPolicy, host: &HostAuthConfiguration) -> Result<()> {
    if host.api_key.is_some() || host.client_secret.is_some() || host.private_key_pem.is_some() {
        ensure!(
            !host.account_id.trim().is_empty(),
            "host account binding required"
        );
    }
    if let Some(u) = host
        .client_metadata_url
        .as_ref()
        .or(policy.client_metadata_url.as_ref())
    {
        let u = valid_url(u)?;
        ensure!(
            u.scheme() == "https" && u.path() != "/" && u.query().is_none(),
            "host CIMD must be an HTTPS metadata document"
        );
    }
    if matches!(method(policy), "client_secret_basic" | "client_secret_post") {
        ensure!(
            host.client_secret.as_ref().is_some_and(|s| !s.is_empty()),
            "host client secret required"
        );
    }
    if method(policy) == "private_key_jwt" {
        signing_key(host)?;
        ensure!(
            host.private_key_id
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty()),
            "host signing key ID required"
        );
    }
    if policy.portable_declaration.is_some() {
        ensure!(
            host.client_secret.is_none()
                || matches!(method(policy), "client_secret_basic" | "client_secret_post")
                || (policy.client_id.is_some()
                    && declaration(policy)["client"]
                        .get("tokenEndpointAuthMethod")
                        .is_none()),
            "client secret incompatible with declared method"
        );
        ensure!(
            host.private_key_pem.is_none() || method(policy) == "private_key_jwt",
            "signing key incompatible with declared method"
        );
        ensure!(
            host.api_key.is_none() || policy.mode() == "api_key",
            "API key incompatible with declared method"
        );
    }
    if policy.mode() == "api_key" {
        api_key_header(policy, host)?;
    }
    Ok(())
}
pub(super) fn api_key_header(
    policy: &AuthPolicy,
    host: &HostAuthConfiguration,
) -> Result<(
    reqwest_mcp::header::HeaderName,
    reqwest_mcp::header::HeaderValue,
)> {
    let key = host
        .api_key
        .as_ref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("host API key required"))?;
    let v = declaration(policy);
    let (name, value) = match text(&v, "headerScheme") {
        Some("bearer") => ("authorization", format!("Bearer {key}")),
        // Basic input is the trusted connection's username:password, encoded once.
        Some("basic") => {
            ensure!(
                key.contains(':'),
                "Basic credential must contain username:password"
            );
            (
                "authorization",
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(key)
                ),
            )
        }
        Some("custom_header") => (
            text(&v, "headerName").ok_or_else(|| anyhow::anyhow!("API header required"))?,
            key.clone(),
        ),
        _ => anyhow::bail!("invalid API key scheme"),
    };
    let mut value = reqwest_mcp::header::HeaderValue::from_str(&value)
        .map_err(|_| anyhow::anyhow!("invalid API key credential"))?;
    value.set_sensitive(true);
    Ok((
        reqwest_mcp::header::HeaderName::from_bytes(name.as_bytes())?,
        value,
    ))
}
async fn metadata_document(raw: &str) -> Result<AuthorizationMetadata> {
    valid_url(raw)?;
    let client = reqwest_mcp::Client::builder()
        .redirect(reqwest_mcp::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut response = client.get(raw).send().await?.error_for_status()?;
    ensure!(
        !response.status().is_redirection(),
        "OAuth metadata redirect rejected"
    );
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= 1024 * 1024,
            "OAuth metadata too large"
        );
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}
pub(super) async fn prepare_manager(
    endpoint: &str,
    policy: &AuthPolicy,
    challenge: Option<&str>,
    host: &HostAuthConfiguration,
) -> Result<(
    AuthorizationManager,
    AuthorizationMetadata,
    Vec<String>,
    String,
    RefreshScopeBoundary,
)> {
    let v = declaration(policy);
    let resource_identity = Arc::new(std::sync::Mutex::new(None));
    let http = Arc::new(TokenClient {
        resource_identity: resource_identity.clone(),
        inner: Arc::new(rmcp::transport::auth::default_oauth_http_client()?),
        token_endpoint: std::sync::OnceLock::new(),
        refresh_scope_boundary: RefreshScopeBoundary::default(),
        client_id: policy.client_id.clone(),
        jwt: if method(policy) == "private_key_jwt" {
            Some(host.clone())
        } else {
            None
        },
    });
    let mut discovery =
        AuthorizationManager::new_with_oauth_http_client(endpoint, http.clone()).await?;
    let explicit = text(&v, "authorizationUrl").zip(text(&v, "tokenUrl"));
    let oidc_enabled = v.get("oidcEnabled").and_then(Value::as_bool);
    let mut metadata = if let Some(oidc) = text(&v, "oidcConfigurationUrl") {
        let m = metadata_document(oidc).await?;
        ensure!(m.issuer.is_some(), "OIDC issuer required");
        m
    } else if oidc_enabled == Some(true) && text(&v, "authorizationServerBase").is_some() {
        let base = text(&v, "authorizationServerBase").unwrap();
        metadata_document(&format!(
            "{}/.well-known/openid-configuration",
            base.trim_end_matches('/')
        ))
        .await?
    } else if let Some((authorize, token)) = explicit {
        let mut m = AuthorizationMetadata::default();
        m.authorization_endpoint = authorize.into();
        m.token_endpoint = token.into();
        m.issuer = text(&v, "authorizationServerBase").map(str::to_owned);
        m
    } else {
        if let Some(base) = text(&v, "authorizationServerBase") {
            // The declared AS base is an issuer, not an MCP resource to probe.
            let base_url = valid_url(base)?;
            let well_known = format!(
                "{}/.well-known/oauth-authorization-server{}",
                base_url.origin().ascii_serialization(),
                base_url.path().trim_end_matches('/')
            );
            metadata_document(&well_known).await?
        } else {
            let resolved = discovery.resolve_metadata_from_challenge(challenge).await?;
            ensure!(resolved.source.is_discovered(), "OAuth discovery required");
            resolved.metadata
        }
    };
    if let Some(expected) = text(&v, "authorizationServerBase") {
        ensure!(
            metadata
                .issuer
                .as_deref()
                .is_none_or(|issuer| issuer == expected),
            "OAuth issuer mismatch"
        );
        metadata.issuer = Some(expected.into());
    }
    if let Some(url) = text(&v, "authorizationUrl") {
        metadata.authorization_endpoint = url.into();
    }
    if let Some(url) = text(&v, "tokenUrl") {
        metadata.token_endpoint = url.into();
    }
    if let Some(url) = text(&v, "registrationUrl") {
        metadata.registration_endpoint = Some(url.into());
    }
    for endpoint in [
        Some(metadata.authorization_endpoint.as_str()),
        Some(metadata.token_endpoint.as_str()),
        metadata.registration_endpoint.as_deref(),
        metadata.issuer.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        valid_url(endpoint)?;
    }
    if let Some(url) = text(&v, "oidcUserinfoEndpoint") {
        metadata
            .additional_fields
            .insert("userinfo_endpoint".into(), json!(url));
    }
    if let Some(scopes) = v.get("oidcScopesSupported") {
        metadata
            .additional_fields
            .insert("oidc_scopes_supported".into(), scopes.clone());
    }
    // Select defaults before narrowing token authentication metadata. None retains
    // SDK discovery; Some([]) intentionally prevents its auto-scope expansion.
    discovery.set_metadata(metadata.clone());
    let mut scopes = if let Some(defaults) = v.get("defaultScopes").and_then(Value::as_array) {
        defaults
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else if policy.portable_declaration.is_none() && !policy.scopes.is_empty() {
        policy.scopes.clone()
    } else {
        discovery.select_scopes(None, &[])
    };
    if v.get("defaultScopes").is_none() && oidc_enabled != Some(false) {
        if v.get("oidcScopesSupported").is_some() {
            scopes.retain(|s| {
                !matches!(
                    s.as_str(),
                    "openid" | "profile" | "email" | "offline_access"
                )
            });
        }
        let oidc = v
            .get("oidcScopesSupported")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                metadata
                    .scopes_supported
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|s| {
                        matches!(
                            s.as_str(),
                            "openid" | "profile" | "email" | "offline_access"
                        )
                    })
                    .collect()
            });
        scopes.extend(oidc);
    }
    if oidc_enabled == Some(false) {
        scopes.retain(|s| {
            !matches!(
                s.as_str(),
                "openid" | "profile" | "email" | "offline_access"
            )
        });
    }
    if let Some(base) = v.get("baseScopes").and_then(Value::as_array) {
        scopes.extend(base.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(challenge) = challenge {
        let params = rmcp::transport::auth::WWWAuthenticateParams::parse(
            challenge,
            &url::Url::parse(endpoint)?,
        );
        if let Some(scope) = params.scope {
            scopes.extend(scope.split_whitespace().map(str::to_owned));
        }
    }
    scopes.sort();
    scopes.dedup();
    let declared_method = method(policy);
    if host.client_secret.is_some() || host.private_key_pem.is_some() {
        let token = valid_url(&metadata.token_endpoint)?;
        ensure!(
            token.scheme() == "https" || matches!(token.host_str(), Some("127.0.0.1" | "[::1]")),
            "private client credentials require TLS or loopback"
        );
    }
    if declared_method == "private_key_jwt" {
        let (_, algorithm) = signing_key(host)?;
        if let Some(supported) = metadata
            .additional_fields
            .get("token_endpoint_auth_signing_alg_values_supported")
            .and_then(Value::as_array)
        {
            ensure!(
                supported.iter().any(|v| v.as_str()
                    == Some(if algorithm == jsonwebtoken::Algorithm::RS256 {
                        "RS256"
                    } else {
                        "ES256"
                    })),
                "signing algorithm not supported"
            );
        }
    }
    if v["client"].get("tokenEndpointAuthMethod").is_some() {
        if let Some(supported) = metadata
            .additional_fields
            .get("token_endpoint_auth_methods_supported")
            .and_then(Value::as_array)
        {
            ensure!(
                supported.iter().any(|s| s == declared_method),
                "declared token authentication method unsupported"
            );
        }
        metadata.additional_fields.insert(
            "token_endpoint_auth_methods_supported".into(),
            json!([declared_method]),
        );
    }
    http.refresh_scope_boundary
        .set(policy.portable_declaration.as_ref().map(|_| scopes.clone()))?;
    let refresh_scope_boundary = http.refresh_scope_boundary.clone();
    http.token_endpoint
        .set(metadata.token_endpoint.clone())
        .map_err(|_| anyhow::anyhow!("OAuth endpoint already configured"))?;
    let manager = if let Some(resource) = text(&v, "resource") {
        AuthorizationManager::new_with_oauth_http_client(resource, http).await?
    } else {
        discovery
    };
    let resource_identity = text(&v, "resource")
        .map(str::to_owned)
        .or_else(|| resource_identity.lock().ok().and_then(|r| r.clone()))
        .unwrap_or_else(|| endpoint.to_owned());
    Ok((
        manager,
        metadata,
        scopes,
        resource_identity,
        refresh_scope_boundary,
    ))
}
fn signing_key(
    host: &HostAuthConfiguration,
) -> Result<(jsonwebtoken::EncodingKey, jsonwebtoken::Algorithm)> {
    let pem = host
        .private_key_pem
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("host signing key required"))?;
    if let Ok(key) = jsonwebtoken::EncodingKey::from_rsa_pem(pem.as_bytes()) {
        return Ok((key, jsonwebtoken::Algorithm::RS256));
    }
    if let Ok(key) = jsonwebtoken::EncodingKey::from_ec_pem(pem.as_bytes()) {
        return Ok((key, jsonwebtoken::Algorithm::ES256));
    }
    anyhow::bail!("unsupported OAuth signing key")
}
#[derive(Clone, Default)]
pub(super) struct RefreshScopeBoundary(Arc<std::sync::Mutex<Option<Vec<String>>>>);
impl RefreshScopeBoundary {
    pub(super) fn set(&self, scopes: Option<Vec<String>>) -> Result<()> {
        *self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("OAuth scope boundary unavailable"))? = scopes;
        Ok(())
    }
    fn get(&self) -> Result<Option<Vec<String>>> {
        Ok(self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("OAuth scope boundary unavailable"))?
            .clone())
    }
}
struct TokenClient {
    resource_identity: Arc<std::sync::Mutex<Option<String>>>,
    inner: Arc<dyn OAuthHttpClient>,
    token_endpoint: std::sync::OnceLock<String>,
    refresh_scope_boundary: RefreshScopeBoundary,
    client_id: Option<String>,
    jwt: Option<HostAuthConfiguration>,
}
impl OAuthHttpClient for TokenClient {
    fn execute(&self, mut request: OAuthHttpRequest) -> OAuthHttpClientFuture<'_> {
        Box::pin(async move {
            let token_request = request.request.method() == oauth2::http::Method::POST
                && self
                    .token_endpoint
                    .get()
                    .is_some_and(|endpoint| request.request.uri().to_string() == *endpoint);
            let mut refresh_scope = None;
            if token_request
                && let Some(boundary) = self
                    .refresh_scope_boundary
                    .get()
                    .map_err(|_| "OAuth scope boundary unavailable")?
            {
                let mut pairs: Vec<(String, String)> =
                    url::form_urlencoded::parse(request.request.body())
                        .into_owned()
                        .collect();
                if pairs
                    .iter()
                    .any(|(key, value)| key == "grant_type" && value == "refresh_token")
                {
                    // SDK 3.3 adds offline_access independently of the portable policy.
                    // Keep only already granted scopes allowed by this flow's selection.
                    let scopes: Vec<_> = pairs
                        .iter()
                        .filter(|(key, _)| key == "scope")
                        .flat_map(|(_, value)| value.split_whitespace())
                        .filter(|scope| boundary.iter().any(|allowed| allowed == scope))
                        .map(str::to_owned)
                        .collect();
                    pairs.retain(|(key, _)| key != "scope");
                    let scope = scopes.join(" ");
                    if !scope.is_empty() {
                        pairs.push(("scope".into(), scope.clone()));
                    }
                    *request.request.body_mut() =
                        url::form_urlencoded::Serializer::new(String::new())
                            .extend_pairs(pairs)
                            .finish()
                            .into_bytes();
                    request
                        .request
                        .headers_mut()
                        .remove(oauth2::http::header::CONTENT_LENGTH);
                    refresh_scope = Some(scope);
                }
            }
            if let Some(host) = &self.jwt {
                if token_request {
                    let client = self
                        .client_id
                        .as_ref()
                        .ok_or("OAuth client identity missing")?;
                    let mut pairs: Vec<(String, String)> =
                        url::form_urlencoded::parse(request.request.body())
                            .into_owned()
                            .filter(|(k, _)| {
                                !matches!(
                                    k.as_str(),
                                    "client_secret" | "client_assertion" | "client_assertion_type"
                                )
                            })
                            .collect();
                    let (key, algorithm) =
                        signing_key(host).map_err(|_| "invalid OAuth signing key")?;
                    let mut header = jsonwebtoken::Header::new(algorithm);
                    header.kid = host.private_key_id.clone();
                    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
                    static NEXT: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let claims = json!({"iss":client,"sub":client,"aud":self.token_endpoint.get(),"iat":now,"exp":now+60,"jti":format!("{}-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed))});
                    let assertion = jsonwebtoken::encode(&header, &claims, &key)
                        .map_err(|_| "OAuth signing failed")?;
                    pairs.push((
                        "client_assertion_type".into(),
                        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer".into(),
                    ));
                    pairs.push(("client_assertion".into(), assertion));
                    *request.request.body_mut() =
                        url::form_urlencoded::Serializer::new(String::new())
                            .extend_pairs(pairs)
                            .finish()
                            .into_bytes();
                    request
                        .request
                        .headers_mut()
                        .remove(oauth2::http::header::AUTHORIZATION);
                    request
                        .request
                        .headers_mut()
                        .remove(oauth2::http::header::CONTENT_LENGTH);
                }
            }
            let discovery = request.request.method() == oauth2::http::Method::GET;
            let mut response = self.inner.execute(request).await?;
            if let Some(scope) = refresh_scope
                && response.status().is_success()
            {
                if let Ok(mut value) = serde_json::from_slice::<Value>(response.body()) {
                    if value.get("access_token").and_then(Value::as_str).is_some()
                        && value.get("scope").is_none()
                    {
                        // RFC 6749 omission means the actual request's scope. Inform the
                        // SDK of that exact set, not its pre-adapter expanded fallback.
                        value["scope"] = json!(scope);
                        *response.body_mut() = serde_json::to_vec(&value)?;
                        response
                            .headers_mut()
                            .remove(oauth2::http::header::CONTENT_LENGTH);
                    }
                }
            }
            if discovery && response.status().is_success() {
                if let Ok(value) = serde_json::from_slice::<Value>(response.body()) {
                    if value.get("authorization_servers").is_some() {
                        if let Some(resource) = value.get("resource").and_then(Value::as_str) {
                            if let Ok(mut identity) = self.resource_identity.lock() {
                                *identity = Some(resource.to_owned());
                            }
                        }
                    }
                }
            }
            Ok(response)
        })
    }
}
