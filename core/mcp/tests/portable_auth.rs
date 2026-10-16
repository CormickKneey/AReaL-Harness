//! Loopback contract fixture: tests the host-to-OAuth and authenticated MCP wire
//! boundaries, with disposable test credentials and no external provider calls.
use areal_mcp::{AuthManager, AuthStatus, HostAuthConfiguration, normalize_plugin_document};
use axum::{extract::State, response::IntoResponse};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[derive(Clone)]
struct Fixture {
    base: String,
    marker_started: Arc<tokio::sync::Notify>,
    marker_release: Arc<tokio::sync::Notify>,
    calls: Arc<Mutex<Vec<(String, axum::http::HeaderMap, String)>>>,
}
async fn serve(
    State(s): State<Fixture>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    s.calls
        .lock()
        .unwrap()
        .push((uri.path().into(), headers.clone(), body.clone()));
    let b = &s.base;
    let value = match uri.path() {
        "/.well-known/oauth-protected-resource/mcp" | "/.well-known/oauth-protected-resource" => {
            json!({"resource":format!("{b}/mcp"),"authorization_servers":[b],"scopes_supported":["read"]})
        }
        "/.well-known/oauth-authorization-server" | "/oidc" | "/oidc-offline" => {
            json!({"issuer":b,"authorization_endpoint":format!("{b}/authorize"),"token_endpoint":format!("{b}/token"),"registration_endpoint":format!("{b}/register"),"response_types_supported":["code"],"code_challenge_methods_supported":["S256"],"scopes_supported":if uri.path()=="/oidc-offline" {json!(["read","openid","email","offline_access"])}else{json!(["read","openid","email"])},"client_id_metadata_document_supported":true,"authorization_response_iss_parameter_supported":true})
        }
        "/private-resource" => {
            json!({"resource":format!("{b}/mixed"),"authorization_servers":[b],"scopes_supported":["protected.read"]})
        }
        "/private-resource-tool" => {
            json!({"resource":format!("{b}/tool-challenge"),"authorization_servers":[b],"scopes_supported":["protected.read"]})
        }
        "/private-resource-startup" => {
            json!({"resource":format!("{b}/startup-auth"),"authorization_servers":[b],"scopes_supported":["protected.read"]})
        }
        "/mixed" | "/tool-challenge" | "/startup-auth" => {
            if method != axum::http::Method::POST {
                return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response();
            }
            let v: Value = serde_json::from_str(&body).unwrap();
            let resource = if uri.path() == "/mixed" {
                "private-resource"
            } else if uri.path() == "/tool-challenge" {
                "private-resource-tool"
            } else {
                "private-resource-startup"
            };
            let challenge = format!(
                "Bearer resource_metadata=\"{b}/{resource}\", error=\"insufficient_scope\", scope=\"protected.read\", error_description=\"private-fixture-description\""
            );
            let authenticated = headers
                .get("authorization")
                .is_some_and(|h| h == "Bearer fixture-access");
            if !authenticated && uri.path() == "/startup-auth" {
                return (
                    axum::http::StatusCode::UNAUTHORIZED,
                    [("www-authenticate", challenge)],
                )
                    .into_response();
            }
            let result = match v["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"mixed-fixture","version":"1"}})
                }
                "notifications/initialized" | "notifications/cancelled" => {
                    return axum::http::StatusCode::ACCEPTED.into_response();
                }
                "tools/list" => {
                    json!({"tools":[{"name":"public","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}},{"name":"protected","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]})
                }
                "tools/call" if v["params"]["name"] == "protected" && !authenticated => {
                    if uri.path() == "/tool-challenge" {
                        json!({"isError":true,"content":[{"type":"text","text":"Sign in required"}],"_meta":{"mcp/www_authenticate":[challenge]}})
                    } else {
                        return (
                            axum::http::StatusCode::FORBIDDEN,
                            [("www-authenticate", challenge)],
                        )
                            .into_response();
                    }
                }
                "tools/call" => json!({"content":[{"type":"text","text":"read-only fixture"}]}),
                _ => return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response(),
            };
            json!({"jsonrpc":"2.0","id":v["id"],"result":result})
        }
        "/register" | "/custom-register" => {
            let req: Value = serde_json::from_str(&body).unwrap();
            json!({"client_id":"fixture-registered","redirect_uris":req["redirect_uris"],"token_endpoint_auth_method":"none"})
        }
        "/scope-token" => {
            json!({"access_token":"fixture-read-token","refresh_token":"fixture-read-refresh","token_type":"Bearer","expires_in":3600,"scope":if body.contains("client_id=fixture-empty"){""}else{"read"}})
        }
        "/rotating-token" => {
            json!({"access_token":if body.contains("grant_type=refresh_token"){"fixture-new-token"}else{"fixture-old-token"},"refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":3600})
        }
        "/token" | "/custom-token" => {
            json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":if body.contains("grant_type=refresh_token"){3600}else{1}})
        }
        "/mcp" => {
            if method != axum::http::Method::POST {
                return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response();
            }
            let v: Value = serde_json::from_str(&body).unwrap();
            let result = match v["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
                }
                "notifications/initialized" | "notifications/cancelled" => {
                    return axum::http::StatusCode::ACCEPTED.into_response();
                }
                "tools/list" => {
                    json!({"tools":[{"name":"read","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]})
                }
                "tools/call" if v["params"]["arguments"]["upgrade"] == true => {
                    return (
                        axum::http::StatusCode::FORBIDDEN,
                        [("www-authenticate", format!("Bearer resource_metadata=\"{b}/.well-known/oauth-protected-resource/mcp\", error=\"insufficient_scope\", scope=\"write\""))],
                    ).into_response();
                }
                "tools/call" if v["params"]["arguments"]["reject"] == true => {
                    if v["params"]["arguments"]["hold"] == true {
                        s.marker_started.notify_one();
                        s.marker_release.notified().await;
                    }
                    json!({"isError":true,"content":[],"_meta":{"mcp/www_authenticate":format!("Bearer resource_metadata=\"{b}/.well-known/oauth-protected-resource/mcp\", error=\"invalid_token\", scope=\"read\"")}})
                }
                "tools/call" => json!({"content":[{"type":"text","text":"read-only fixture"}]}),
                _ => return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response(),
            };
            json!({"jsonrpc":"2.0","id":v["id"],"result":result})
        }
        _ => return axum::http::StatusCode::NOT_FOUND.into_response(),
    };
    axum::Json(value).into_response()
}
async fn fixture() -> (Fixture, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let s = Fixture {
        base: format!("http://{}", listener.local_addr().unwrap()),
        calls: Arc::default(),
        marker_started: Arc::default(),
        marker_release: Arc::default(),
    };
    let app = axum::Router::new().fallback(serve).with_state(s.clone());
    (
        s,
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    )
}
fn config(s: &Fixture, temp: &std::path::Path, auth: Value) -> areal_mcp::PluginConfigOutcome {
    normalize_plugin_document(true,&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"server":{"type":"streamable-http","url":format!("{}/mcp",s.base),"extensions":{"com.openai":{"auth":auth}}}}}),temp,temp).unwrap()
}
async fn complete(manager: &AuthManager, name: &str, status: AuthStatus, issuer: &str) -> Value {
    let AuthStatus::Pending { authorization_url } = status else {
        panic!("pending expected")
    };
    let url = url::Url::parse(&authorization_url).unwrap();
    let pairs: std::collections::BTreeMap<String, String> =
        url.query_pairs().into_owned().collect();
    let mut callback = url::Url::parse(&pairs["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", "fixture-code")
        .append_pair("state", &pairs["state"])
        .append_pair("iss", issuer);
    assert!(
        reqwest_mcp::get(callback)
            .await
            .unwrap()
            .status()
            .is_success()
    );
    for _ in 0..100 {
        if matches!(manager.status(name).await, Some(AuthStatus::Ready)) {
            return serde_json::to_value(pairs).unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("authentication not ready")
}
async fn read_mcp(
    configs: &areal_mcp::PluginConfigOutcome,
    manager: &AuthManager,
    name: &str,
    temp: &std::path::Path,
) {
    let credential = manager.ready_credential(name).await.unwrap();
    let mut connections = areal_mcp::Connections::connect_plugins_authorized(
        &configs.servers,
        &std::collections::BTreeMap::from([("server".into(), credential)]),
        &std::collections::BTreeMap::new(),
        temp,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    connections.tools()[0]
        .call_raw(json!({}), tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    connections.shutdown().await.unwrap();
}
#[tokio::test]
async fn portable_client_methods_apply_to_exchange_and_refresh_with_exact_resource() {
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    for method in [
        "none",
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
    ] {
        let manager = AuthManager::new(temp.path().join(method), "fixture").unwrap();
        let cfg = config(
            &s,
            temp.path(),
            json!({"type":"oauth","client":{"mode":"provided","clientId":"fixture-client","tokenEndpointAuthMethod":method},"authorizationServerBase":s.base,"authorizationUrl":format!("{}/authorize",s.base),"tokenUrl":format!("{}/custom-token",s.base),"resource":format!("{}/documents",s.base),"defaultScopes":[],"baseScopes":["docs:read"]}),
        );
        let host = HostAuthConfiguration {
            account_id: "account-one".into(),
            client_secret: if method.starts_with("client_secret") {
                Some("fixture-client-secret".into())
            } else {
                None
            },
            private_key_pem: if method == "private_key_jwt" {
                Some(include_str!("fixtures/oauth-test-private.pem").into())
            } else {
                None
            },
            private_key_id: Some("fixture-key".into()),
            ..Default::default()
        };
        let pending = manager
            .start_with_options(
                "server",
                &format!("{}/mcp", s.base),
                cfg.servers["server"].auth_policy().unwrap(),
                None,
                &host,
            )
            .await
            .unwrap();
        let q = complete(&manager, "server", pending, &s.base).await;
        assert_eq!(q["scope"], "docs:read");
        assert_eq!(q["resource"], format!("{}/documents", s.base));
        read_mcp(&cfg, &manager, "server", temp.path()).await;
        let calls = s.calls.lock().unwrap().clone();
        let tokens: Vec<_> = calls
            .iter()
            .filter(|(p, _, _)| p == "/custom-token")
            .collect();
        assert_eq!(tokens.len(), 2, "exchange plus one refresh");
        let mut assertions = vec![];
        for (_, headers, body) in tokens {
            let form: std::collections::BTreeMap<String, String> =
                url::form_urlencoded::parse(body.as_bytes())
                    .into_owned()
                    .collect();
            assert_eq!(form["resource"], format!("{}/documents", s.base));
            match method {
                "client_secret_basic" => {
                    assert_eq!(
                        headers["authorization"],
                        "Basic Zml4dHVyZS1jbGllbnQ6Zml4dHVyZS1jbGllbnQtc2VjcmV0"
                    );
                    assert!(!form.contains_key("client_secret"));
                }
                "client_secret_post" => {
                    assert_eq!(form["client_secret"], "fixture-client-secret");
                    assert!(headers.get("authorization").is_none());
                }
                "private_key_jwt" => {
                    assert!(headers.get("authorization").is_none());
                    assert!(!form.contains_key("client_secret"));
                    let assertion = &form["client_assertion"];
                    let mut validation =
                        jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
                    validation.set_audience(&[format!("{}/custom-token", s.base)]);
                    validation.set_issuer(&["fixture-client"]);
                    let decoded = jsonwebtoken::decode::<Value>(
                        assertion,
                        &jsonwebtoken::DecodingKey::from_rsa_pem(include_bytes!(
                            "fixtures/oauth-test-public.pem"
                        ))
                        .unwrap(),
                        &validation,
                    )
                    .unwrap();
                    assert_eq!(decoded.header.kid.as_deref(), Some("fixture-key"));
                    assert_eq!(decoded.claims["sub"], "fixture-client");
                    assertions.push(decoded.claims["jti"].clone());
                }
                _ => {
                    assert!(headers.get("authorization").is_none());
                    assert!(!form.contains_key("client_secret"));
                }
            }
        }
        if method == "private_key_jwt" {
            assert_ne!(assertions[0], assertions[1]);
        }
        s.calls.lock().unwrap().clear();
    }
    task.abort();
}
#[tokio::test]
async fn api_keys_use_only_declared_headers_and_account_changes_require_new_flow() {
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = AuthManager::new(temp.path().join("auth"), "fixture").unwrap();
    for (scheme, key, expected_header, expected_value) in [
        ("bearer", "fixed-key", "authorization", "Bearer fixed-key"),
        (
            "basic",
            "alice:secret",
            "authorization",
            "Basic YWxpY2U6c2VjcmV0",
        ),
        ("custom_header", "custom-key", "x-fixture-key", "custom-key"),
    ] {
        let mut auth = json!({"type":"api_key","headerScheme":scheme});
        if scheme == "custom_header" {
            auth["headerName"] = json!("X-Fixture-Key");
        }
        let cfg = config(&s, temp.path(), auth);
        let host = HostAuthConfiguration {
            account_id: scheme.into(),
            api_key: Some(key.into()),
            ..Default::default()
        };
        assert!(matches!(
            manager
                .start_with_options(
                    "server",
                    &format!("{}/mcp", s.base),
                    cfg.servers["server"].auth_policy().unwrap(),
                    None,
                    &host
                )
                .await
                .unwrap(),
            AuthStatus::Ready
        ));
        read_mcp(&cfg, &manager, "server", temp.path()).await;
        let calls = s.calls.lock().unwrap().clone();
        assert!(calls.iter().all(|(p, _, _)| p == "/mcp"));
        for (_, headers, _) in calls {
            assert_eq!(headers[expected_header], expected_value);
            if scheme == "custom_header" {
                assert!(headers.get("authorization").is_none());
            }
        }
        assert!(!format!("{host:?}").contains(key));
        s.calls.lock().unwrap().clear();
    }
    for header in [
        "Host",
        "Authorization",
        "Content-Length",
        "Mcp-Session-Id",
        "Proxy-Authorization",
    ] {
        assert!(
            config(
                &s,
                temp.path(),
                json!({"type":"api_key","headerScheme":"custom_header","headerName":header})
            )
            .servers
            .is_empty()
        );
    }
    task.abort();
}
#[tokio::test]
async fn oidc_defaults_cimd_fallback_and_account_binding() {
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = AuthManager::new(temp.path().join("auth"), "fixture").unwrap();
    for (mode, host, expected) in [
        (
            "cimd",
            HostAuthConfiguration::default(),
            "fixture-registered",
        ),
        (
            "cimd",
            HostAuthConfiguration {
                client_metadata_url: Some("https://harness.example/oauth/client.json".into()),
                ..Default::default()
            },
            "https://harness.example/oauth/client.json",
        ),
        (
            "dcr",
            HostAuthConfiguration {
                client_metadata_url: Some("https://harness.example/oauth/client.json".into()),
                ..Default::default()
            },
            "fixture-registered",
        ),
    ] {
        let cfg = config(
            &s,
            temp.path(),
            json!({"type":"mixed","client":{"mode":mode},"oidcConfigurationUrl":format!("{}/oidc",s.base),"oidcScopesSupported":["openid","email"],"baseScopes":["base"],"registrationUrl":format!("{}/custom-register",s.base)}),
        );
        let pending = manager
            .start_with_options(
                "server",
                &format!("{}/mcp", s.base),
                cfg.servers["server"].auth_policy().unwrap(),
                None,
                &host,
            )
            .await
            .unwrap();
        let q = complete(&manager, "server", pending, &s.base).await;
        assert_eq!(q["client_id"], expected);
        assert_eq!(q["scope"], "base email openid read");
        let mut changed = host.clone();
        changed.account_id = "different-account".into();
        assert!(matches!(
            manager
                .start_with_options(
                    "server",
                    &format!("{}/mcp", s.base),
                    cfg.servers["server"].auth_policy().unwrap(),
                    None,
                    &changed
                )
                .await
                .unwrap(),
            AuthStatus::Pending { .. }
        ));
        manager.cancel("server").await;
    }
    task.abort();
}

#[tokio::test]
async fn explicit_empty_defaults_oidc_disabled_and_scope_upgrade_do_not_reuse_old_grant() {
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = AuthManager::new(temp.path().join("auth"), "fixture").unwrap();
    for (defaults, oidc, expected) in [
        (Some(json!([])), true, None),
        (None, false, Some("read")),
        (Some(json!(["custom"])), true, Some("custom")),
    ] {
        let mut auth = json!({"type":"oauth","client":{"mode":"provided","clientId":"fixture-client"},"oidcConfigurationUrl":format!("{}/oidc",s.base),"oidcEnabled":oidc});
        if let Some(defaults) = defaults {
            auth["defaultScopes"] = defaults;
        }
        let cfg = config(&s, temp.path(), auth);
        let pending = manager
            .start(
                "server",
                &format!("{}/mcp", s.base),
                cfg.servers["server"].auth_policy().unwrap(),
                None,
            )
            .await
            .unwrap();
        let q = complete(&manager, "server", pending, &s.base).await;
        assert_eq!(q.get("scope").and_then(Value::as_str), expected);
        let upgraded = manager
            .start(
                "server",
                &format!("{}/mcp", s.base),
                cfg.servers["server"].auth_policy().unwrap(),
                Some("Bearer error=insufficient_scope, scope=write"),
            )
            .await
            .unwrap();
        let AuthStatus::Pending { authorization_url } = upgraded else {
            panic!("scope upgrade must not reuse old access token")
        };
        let u = url::Url::parse(&authorization_url).unwrap();
        let scope = u
            .query_pairs()
            .find(|(k, _)| k == "scope")
            .unwrap()
            .1
            .into_owned();
        assert!(scope.split_whitespace().any(|s| s == "write"));
        manager.cancel("server").await;
    }
    let cfg = config(
        &s,
        temp.path(),
        json!({"type":"oauth","client":{"mode":"provided","clientId":"fixture-client"},"oidcConfigurationUrl":format!("{}/oidc",s.base),"oidcScopesSupported":[]}),
    );
    let pending = manager
        .start(
            "server",
            &format!("{}/mcp", s.base),
            cfg.servers["server"].auth_policy().unwrap(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        complete(&manager, "server", pending, &s.base).await["scope"],
        "read"
    );
    task.abort();
}

// Refresh must obey the same explicitly selected scope boundary as authorization,
// even though the SDK normally appends advertised offline_access during refresh.
#[tokio::test]
async fn refresh_keeps_explicit_defaults_and_oidc_exclusions() {
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    for explicit_defaults in [true, false] {
        let manager = AuthManager::new(
            temp.path().join(if explicit_defaults {
                "defaults"
            } else {
                "oidc-off"
            }),
            "fixture",
        )
        .unwrap();
        let mut auth = json!({"type":"oauth","client":{"mode":"provided","clientId":"fixture-client"},"oidcConfigurationUrl":format!("{}/oidc-offline",s.base),"baseScopes":["read"]});
        if explicit_defaults {
            auth["defaultScopes"] = json!([]);
        } else {
            auth["oidcEnabled"] = json!(false);
        }
        let cfg = config(&s, temp.path(), auth);
        let pending = manager
            .start(
                "server",
                &format!("{}/mcp", s.base),
                cfg.servers["server"].auth_policy().unwrap(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            complete(&manager, "server", pending, &s.base).await["scope"],
            "read"
        );
        read_mcp(&cfg, &manager, "server", temp.path()).await;
        let calls = s.calls.lock().unwrap().clone();
        let (_, _, body) = calls
            .iter()
            .find(|(p, _, body)| p == "/token" && body.contains("grant_type=refresh_token"))
            .unwrap();
        let form: std::collections::BTreeMap<String, String> =
            url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
        assert_eq!(
            form.get("scope").map(String::as_str),
            Some("read"),
            "refresh widened the authorization scope"
        );
        let auth_root = temp.path().join(if explicit_defaults {
            "defaults"
        } else {
            "oidc-off"
        });
        for entry in std::fs::read_dir(auth_root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                assert_eq!(
                    saved["granted_scopes"],
                    json!(["read"]),
                    "omitted provider scope must persist the actual request boundary"
                );
            }
        }
        s.calls.lock().unwrap().clear();
    }
    task.abort();
}

#[tokio::test]
async fn mixed_http_and_tool_challenges_only_authorize_future_explicit_calls() {
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    for path in ["mixed", "tool-challenge", "startup-auth"] {
        let manager = AuthManager::new(temp.path().join(path), "fixture").unwrap();
        let endpoint = format!("{}/{path}", s.base);
        let cfg=normalize_plugin_document(true,&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"server":{"type":"streamable-http","url":endpoint,"extensions":{"com.openai":{"auth":{"type":"mixed","client":{"mode":"provided","clientId":"fixture-client"},"baseScopes":["read"]}}}}}}),temp.path(),temp.path()).unwrap();
        let mut anonymous = areal_mcp::Connections::connect_plugins_authorized(
            &cfg.servers,
            &Default::default(),
            &Default::default(),
            temp.path(),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        let challenge = if path == "startup-auth" {
            assert!(anonymous.servers().is_empty());
            let failure = &anonymous.failures()[0];
            assert!(!format!("{failure:?}").contains("private-fixture-description"));
            failure
                .authentication_challenge()
                .expect("startup challenge retained")
        } else {
            let tools = anonymous.tools();
            tools
                .iter()
                .find(|t| t.original_name() == "public")
                .unwrap()
                .call_raw(json!({}), tokio_util::sync::CancellationToken::new())
                .await
                .unwrap();
            let error = tools
                .iter()
                .find(|t| t.original_name() == "protected")
                .unwrap()
                .call_raw(json!({}), tokio_util::sync::CancellationToken::new())
                .await
                .unwrap_err();
            assert!(
                error
                    .downcast_ref::<areal_mcp::AuthenticationFailed>()
                    .is_some(),
                "{error}"
            );
            assert!(!format!("{error:?}").contains("private-fixture-description"));
            anonymous.servers()[0]
                .authentication_challenge()
                .expect("live server challenge retained")
        };
        let count_protected = || {
            s.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(request_path, _, body)| {
                    request_path == &format!("/{path}")
                        && serde_json::from_str::<Value>(body).is_ok_and(|v| {
                            v["method"] == "tools/call" && v["params"]["name"] == "protected"
                        })
                })
                .count()
        };
        assert_eq!(
            count_protected(),
            if path == "startup-auth" { 0 } else { 1 },
            "failed request was replayed"
        );
        let pending = manager
            .start(
                "server",
                &endpoint,
                cfg.servers["server"].auth_policy().unwrap(),
                Some(&challenge),
            )
            .await
            .unwrap();
        let q = complete(&manager, "server", pending, &s.base).await;
        assert!(
            q["scope"]
                .as_str()
                .unwrap()
                .split_whitespace()
                .any(|s| s == "protected.read")
        );
        assert_eq!(
            count_protected(),
            if path == "startup-auth" { 0 } else { 1 },
            "authentication replayed a prior tool call"
        );
        let credentials = std::collections::BTreeMap::from([(
            "server".into(),
            manager.ready_credential("server").await.unwrap(),
        )]);
        let mut authenticated = areal_mcp::Connections::connect_plugins_authorized(
            &cfg.servers,
            &credentials,
            &Default::default(),
            temp.path(),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        authenticated
            .tools()
            .iter()
            .find(|t| t.original_name() == "protected")
            .unwrap()
            .call_raw(json!({}), tokio_util::sync::CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            count_protected(),
            if path == "startup-auth" { 1 } else { 2 }
        );
        anonymous.shutdown().await.unwrap();
        authenticated.shutdown().await.unwrap();
        s.calls.lock().unwrap().clear();
    }
    task.abort();
}

// Authenticated same-scope rejection must invalidate only the token sent with
// that request, including when a concurrent request has refreshed the store.
#[tokio::test]
async fn tool_marker_rejects_exact_sent_token_without_replaying() {
    let (s, task) = fixture().await;
    for concurrent_refresh in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let auth_root = temp.path().join("auth");
        let manager = AuthManager::new(auth_root.clone(), "fixture").unwrap();
        let cfg = config(
            &s,
            temp.path(),
            json!({"type":"oauth","client":{"mode":"provided","clientId":"fixture-client"},"tokenUrl":format!("{}/rotating-token",s.base),"baseScopes":["read"]}),
        );
        let endpoint = format!("{}/mcp", s.base);
        let policy = cfg.servers["server"].auth_policy().unwrap();
        complete(
            &manager,
            "server",
            manager
                .start("server", &endpoint, policy, None)
                .await
                .unwrap(),
            &s.base,
        )
        .await;
        let mut connections = areal_mcp::Connections::connect_plugins_authorized(
            &cfg.servers,
            &[(
                "server".into(),
                manager.ready_credential("server").await.unwrap(),
            )]
            .into(),
            &Default::default(),
            temp.path(),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        let tool = connections.tools()[0].clone();
        let request = tokio::spawn(async move {
            tool.call_raw(
                json!({"reject":true,"hold":concurrent_refresh}),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
        });
        if concurrent_refresh {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                s.marker_started.notified(),
            )
            .await
            .unwrap();
            // Expire the disposable store while the old-token reply is pending;
            // another real MCP request performs the normal OAuth refresh.
            for entry in std::fs::read_dir(&auth_root).unwrap() {
                let path = entry.unwrap().path();
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    let mut saved: Value =
                        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                    saved["token_received_at"] = json!(0);
                    std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
                }
            }
            read_mcp(&cfg, &manager, "server", temp.path()).await;
            s.marker_release.notify_one();
        }
        let error = request.await.unwrap().unwrap_err();
        assert!(error.is::<areal_mcp::AuthenticationFailed>());
        let challenge = connections.servers()[0].authentication_challenge().unwrap();
        let status = manager
            .start("server", &endpoint, policy, Some(&challenge))
            .await
            .unwrap();
        if concurrent_refresh {
            assert!(
                matches!(status, AuthStatus::Ready),
                "a late rejection must retain the newer stored credential"
            );
            read_mcp(&cfg, &manager, "server", temp.path()).await;
        } else {
            assert!(
                matches!(status, AuthStatus::Pending { .. }),
                "same-scope invalid token must require explicit authorization"
            );
            manager.cancel("server").await;
        }
        let calls = s.calls.lock().unwrap();
        let rejected: Vec<_> = calls
            .iter()
            .filter(|(p, _, b)| {
                p == "/mcp"
                    && serde_json::from_str::<Value>(b)
                        .is_ok_and(|v| v["params"]["arguments"]["reject"] == true)
            })
            .collect();
        assert_eq!(rejected.len(), 1, "rejected POST must never replay");
        assert!(
            rejected[0]
                .1
                .get("authorization")
                .is_some_and(|h| h == "Bearer fixture-old-token")
        );
        if concurrent_refresh {
            assert!(calls.iter().any(|(p, h, _)| {
                p == "/mcp"
                    && h.get("authorization")
                        .is_some_and(|h| h == "Bearer fixture-new-token")
            }));
        }
        drop(calls);
        connections.shutdown().await.unwrap();
        s.calls.lock().unwrap().clear();
    }
    task.abort();
}

// Planned failure: authenticated 403 clears the rejected token and also loses proven
// grants. Explicit empty defaults must not hide this through AS/OIDC fallback scopes.
// Pending/cancelled consent must retain only provider-confirmed read, never requested write.
#[tokio::test]
async fn rejected_http_scope_upgrade_preserves_proven_grants_across_cancel_only_with_same_binding()
{
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    let auth_root = temp.path().join("auth");
    let manager = AuthManager::new(auth_root.clone(), "fixture").unwrap();
    let cfg = config(
        &s,
        temp.path(),
        json!({
            "type":"oauth", "client":{"mode":"provided","clientId":"fixture-client"},
            "tokenUrl":format!("{}/scope-token",s.base),
            "oidcConfigurationUrl":format!("{}/oidc",s.base),
            "defaultScopes":[], "oidcScopesSupported":[]
        }),
    );
    let endpoint = format!("{}/mcp", s.base);
    let policy = cfg.servers["server"].auth_policy().unwrap();
    let initial = manager
        .start("server", &endpoint, policy, None)
        .await
        .unwrap();
    let initial = complete(&manager, "server", initial, &s.base).await;
    assert!(
        initial.get("scope").is_none(),
        "explicit empty defaults remain empty; provider independently confirms read"
    );
    let store_path = std::fs::read_dir(&auth_root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .unwrap();
    let saved =
        || -> Value { serde_json::from_slice(&std::fs::read(&store_path).unwrap()).unwrap() };
    assert_eq!(saved()["granted_scopes"], json!(["read"]));
    let mut connections = areal_mcp::Connections::connect_plugins_authorized(
        &cfg.servers,
        &[(
            "server".into(),
            manager.ready_credential("server").await.unwrap(),
        )]
        .into(),
        &Default::default(),
        temp.path(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    let error = connections.tools()[0]
        .call_raw(
            json!({"upgrade":true}),
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.is::<areal_mcp::AuthenticationFailed>());
    assert!(
        manager.ready_credential("server").await.is_err(),
        "rejected token cannot remain Ready"
    );
    assert!(matches!(
        manager.status("server").await,
        Some(AuthStatus::Failed)
    ));
    let challenge = connections.servers()[0].authentication_challenge().unwrap();
    assert!(challenge.contains("insufficient_scope") && challenge.contains("write"));
    let pending_scopes = |status: AuthStatus| -> String {
        let AuthStatus::Pending { authorization_url } = status else {
            panic!("explicit consent required; rejected token cannot be reused")
        };
        url::Url::parse(&authorization_url)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "scope")
            .unwrap()
            .1
            .into_owned()
    };
    for _ in 0..2 {
        let pending = manager
            .start("server", &endpoint, policy, Some(&challenge))
            .await
            .unwrap();
        assert_eq!(
            pending_scopes(pending),
            "read write",
            "scope upgrade must merge proven old grant after token invalidation"
        );
        assert_eq!(
            saved()["granted_scopes"],
            json!(["read"]),
            "pending write consent is not a proven grant"
        );
        assert!(
            saved()["token_response"].is_null(),
            "pending consent must not revive rejected token"
        );
        manager.cancel("server").await;
        assert!(manager.ready_credential("server").await.is_err());
    }
    // A different revision/identity name shares the manager and endpoint but not the binding.
    let fresh = manager
        .start(
            "server:next-config-revision",
            &endpoint,
            policy,
            Some(&challenge),
        )
        .await
        .unwrap();
    assert_eq!(
        pending_scopes(fresh),
        "write",
        "new binding must not inherit another binding's read grant"
    );
    manager.cancel("server:next-config-revision").await;
    // Neither cancelled consent nor an unchallenged retry treats requested write as granted.
    let unchallenged = manager
        .start("server", &endpoint, policy, None)
        .await
        .unwrap();
    let AuthStatus::Pending { authorization_url } = unchallenged else {
        panic!("old token remains unusable")
    };
    assert!(
        !url::Url::parse(&authorization_url)
            .unwrap()
            .query_pairs()
            .any(|(k, _)| k == "scope")
    );
    assert_eq!(saved()["granted_scopes"], json!(["read"]));
    manager.cancel("server").await;
    let retry = manager
        .start("server", &endpoint, policy, Some(&challenge))
        .await
        .unwrap();
    assert_eq!(pending_scopes(retry), "read write");
    manager.cancel("server").await;
    let calls = s.calls.lock().unwrap();
    let posts: Vec<_> = calls
        .iter()
        .filter(|(path, _, body)| {
            path == "/mcp"
                && serde_json::from_str::<Value>(body)
                    .is_ok_and(|v| v["params"]["arguments"]["upgrade"] == true)
        })
        .collect();
    assert_eq!(
        posts.len(),
        1,
        "rejected HTTP POST must not replay during auth or retry"
    );
    assert_eq!(
        posts[0].1.get("authorization").unwrap(),
        "Bearer fixture-read-token"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(path, _, _)| path == "/scope-token")
            .count(),
        1,
        "only initial authorization completed; no rejected token refresh"
    );
    drop(calls);
    connections.shutdown().await.unwrap();
    task.abort();
}

#[tokio::test]
async fn cached_oauth_restores_only_existing_binding_without_starting_consent() {
    let (s, task) = fixture().await;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("cached-auth");
    let cfg = config(
        &s,
        temp.path(),
        json!({"type":"oauth","client":{"mode":"dcr"},"authorizationServerBase":s.base,"authorizationUrl":format!("{}/authorize",s.base),"tokenUrl":format!("{}/scope-token",s.base),"registrationUrl":format!("{}/register",s.base),"defaultScopes":[],"baseScopes":["read"]}),
    );
    let policy = cfg.servers["server"].auth_policy().unwrap();
    let endpoint = format!("{}/mcp", s.base);
    let host = HostAuthConfiguration {
        account_id: "fixture-account".into(),
        ..Default::default()
    };
    let manager = AuthManager::new(root.clone(), "fixture").unwrap();
    assert!(
        manager
            .cached_credential("digest-one", &endpoint, policy, &host)
            .await
            .unwrap()
            .is_none()
    );
    assert!(manager.status("digest-one").await.is_none());
    assert!(
        !s.calls
            .lock()
            .unwrap()
            .iter()
            .any(|(path, _, _)| path == "/register"
                || path == "/authorize"
                || path == "/scope-token")
    );
    let status = manager
        .start_with_options("digest-one", &endpoint, policy, None, &host)
        .await
        .unwrap();
    complete(&manager, "digest-one", status, &s.base).await;
    drop(manager);
    let before = s.calls.lock().unwrap().len();
    let restored = AuthManager::new(root.clone(), "fixture").unwrap();
    assert!(
        restored
            .cached_credential("digest-one", &endpoint, policy, &host)
            .await
            .unwrap()
            .is_some()
    );
    assert!(matches!(
        restored.status("digest-one").await,
        Some(AuthStatus::Ready)
    ));
    read_mcp(&cfg, &restored, "digest-one", temp.path()).await;
    assert!(
        !s.calls.lock().unwrap()[before..]
            .iter()
            .any(|(path, _, _)| path == "/register"
                || path == "/authorize"
                || path == "/scope-token")
    );
    restored.cancel("digest-one").await;
    assert!(
        restored
            .cached_credential("digest-one", &endpoint, policy, &host)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        restored.status("digest-one").await,
        Some(AuthStatus::Cancelled)
    ));
    let changed_account = HostAuthConfiguration {
        account_id: "other-account".into(),
        ..Default::default()
    };
    let fresh = AuthManager::new(root, "fixture").unwrap();
    assert!(
        fresh
            .cached_credential("digest-one", &endpoint, policy, &changed_account)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        fresh
            .cached_credential("digest-two", &endpoint, policy, &host)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !s.calls.lock().unwrap()[before..]
            .iter()
            .any(|(path, _, _)| path == "/register"
                || path == "/authorize"
                || path == "/scope-token")
    );
    let empty_cfg = config(
        &s,
        temp.path(),
        json!({"type":"oauth","client":{"mode":"provided","clientId":"fixture-empty"},"oidcConfigurationUrl":format!("{}/oidc",s.base),"tokenUrl":format!("{}/scope-token",s.base)}),
    );
    let empty_policy = empty_cfg.servers["server"].auth_policy().unwrap();
    let manager = AuthManager::new(temp.path().join("empty-scoped-app"), "fixture").unwrap();
    let status = manager
        .start_with_options("empty-app", &endpoint, empty_policy, None, &host)
        .await
        .unwrap();
    complete(&manager, "empty-app", status, &s.base).await;
    drop(manager);
    let before = s.calls.lock().unwrap().len();
    let restored = AuthManager::new(temp.path().join("empty-scoped-app"), "fixture").unwrap();
    assert!(
        restored
            .cached_credential("empty-app", &endpoint, empty_policy, &host)
            .await
            .unwrap()
            .is_some(),
        "advertised optional scopes must not discard an existing empty-scope app grant"
    );
    read_mcp(&empty_cfg, &restored, "empty-app", temp.path()).await;
    assert!(
        !s.calls.lock().unwrap()[before..]
            .iter()
            .any(|(path, _, _)| path == "/register"
                || path == "/authorize"
                || path == "/scope-token")
    );
    task.abort();
}
