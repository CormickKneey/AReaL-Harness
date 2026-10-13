use areal_mcp::{AuthManager, AuthStatus, normalize_plugin_document};
use axum::{extract::State, response::IntoResponse};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
#[derive(Clone)]
struct Fixture {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    token_failure: Arc<AtomicUsize>,
    refresh_delay: Arc<AtomicUsize>,
}
async fn fixture(
    State(s): State<Fixture>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    s.requests
        .lock()
        .unwrap()
        .push(format!("{} {body}", uri.path()));
    let base = &s.base;
    let result = match uri.path() {
        "/resource" => {
            json!({"resource":format!("{base}/mcp"),"authorization_servers":[base],"scopes_supported":["read"]})
        }
        "/.well-known/oauth-authorization-server" => {
            json!({"issuer":base,"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"registration_endpoint":format!("{base}/register"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"client_id_metadata_document_supported":true})
        }
        "/register" => {
            let v: Value = serde_json::from_str(&body).unwrap();
            json!({"client_id":"registered","redirect_uris":v["redirect_uris"],"token_endpoint_auth_method":"none"})
        }
        "/token" => {
            if body.contains("grant_type=refresh_token") {
                tokio::time::sleep(std::time::Duration::from_millis(
                    s.refresh_delay.load(Ordering::SeqCst) as u64,
                ))
                .await;
            }
            if body.contains("grant_type=refresh_token") {
                match s.token_failure.load(Ordering::SeqCst) {1=>return (axum::http::StatusCode::BAD_REQUEST,axum::Json(json!({"error":"invalid_grant","error_description":"private-provider-error"}))).into_response(),2=>return (axum::http::StatusCode::INTERNAL_SERVER_ERROR,"private-provider-error").into_response(),_=>{}}
            }
            json!({"access_token":"test-private-token","token_type":"Bearer","refresh_token":"test-private-refresh","expires_in":if body.contains("refresh_token"){3600}else{1},"scope":"read"})
        }
        "/mcp" | "/mcp-explicit" => {
            assert_eq!(
                headers.get("authorization").unwrap(),
                if uri.path() == "/mcp-explicit" {
                    "Bearer explicit-token"
                } else {
                    "Bearer test-private-token"
                }
            );
            let v: Value = serde_json::from_str(&body).unwrap();
            let r = match v["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1"}})
                }
                "notifications/initialized" | "notifications/cancelled" => {
                    return axum::http::StatusCode::ACCEPTED.into_response();
                }
                "tools/list" => json!({"tools":[{"name":"test","inputSchema":{"type":"object"}}]}),
                "tools/call" => {
                    return (
                        axum::http::StatusCode::UNAUTHORIZED,
                        [("www-authenticate", "Bearer error=invalid_token")],
                    )
                        .into_response();
                }
                _ => return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response(),
            };
            json!({"jsonrpc":"2.0","id":v["id"],"result":r})
        }
        _ => return axum::http::StatusCode::NOT_FOUND.into_response(),
    };
    axum::Json(result).into_response()
}
#[tokio::test]
async fn callback_provided_dcr_cimd_wrong_state_cancel_and_private_store() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let s = Fixture {
        base: base.clone(),
        requests: Arc::default(),
        token_failure: Arc::default(),
        refresh_delay: Arc::default(),
    };
    let app = axum::Router::new().fallback(fixture).with_state(s.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let manager = AuthManager::new(temp.path().join("credentials"), "fixture").unwrap();
    for (name, oauth) in [
        ("provided", json!({"clientId":"provided"})),
        ("dcr", json!({})),
        (
            "cimd",
            json!({"client_metadata_url":"https://client.example/metadata.json"}),
        ),
        ("wrong", json!({"clientId":"provided"})),
        ("wrongissuer", json!({"clientId":"provided"})),
        ("cancel", json!({"clientId":"provided"})),
    ] {
        let o = normalize_plugin_document(
            false,
            &json!({"server":{"required":true,"url":format!("{base}/mcp"),"oauth":oauth}}),
            temp.path(),
            temp.path(),
        )
        .unwrap();
        let status = manager
            .start(
                name,
                &format!("{base}/mcp"),
                o.servers["server"].auth_policy().unwrap(),
                Some(&format!("Bearer resource_metadata=\"{base}/resource\"")),
            )
            .await
            .unwrap();
        let AuthStatus::Pending { authorization_url } = status else {
            panic!("pending required")
        };
        let u = url::Url::parse(&authorization_url).unwrap();
        let q: std::collections::BTreeMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        if name == "cancel" {
            manager.cancel(name).await;
            assert!(matches!(
                manager.status(name).await,
                Some(AuthStatus::Cancelled)
            ));
            continue;
        }
        let mut callback = url::Url::parse(&q["redirect_uri"]).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("code", "fixture-code")
            .append_pair(
                "state",
                if name == "wrong" {
                    "wrong"
                } else {
                    &q["state"]
                },
            )
            .append_pair(
                "iss",
                if name == "wrongissuer" {
                    "https://wrong-issuer.example"
                } else {
                    &base
                },
            );
        reqwest_mcp::get(callback).await.unwrap();
        for _ in 0..100 {
            if !matches!(manager.status(name).await, Some(AuthStatus::Pending { .. })) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        if name == "wrong" || name == "wrongissuer" {
            assert!(matches!(
                manager.status(name).await,
                Some(AuthStatus::Failed)
            ));
            assert!(manager.ready_credential(name).await.is_err());
        } else {
            assert!(matches!(
                manager.status(name).await,
                Some(AuthStatus::Ready)
            ));
            assert!(manager.ready_credential(name).await.is_ok());
            if name == "provided" {
                let credential = manager.ready_credential(name).await.unwrap();
                let configs = o.servers.clone();
                let mut connections = areal_mcp::Connections::connect_plugins_authorized(
                    &configs,
                    &[("server".into(), credential)].into(),
                    &Default::default(),
                    temp.path(),
                    tokio_util::sync::CancellationToken::new(),
                )
                .await
                .unwrap();
                let restored =
                    AuthManager::new(temp.path().join("credentials"), "fixture").unwrap();
                assert!(matches!(
                    restored
                        .start(
                            name,
                            &format!("{base}/mcp"),
                            o.servers["server"].auth_policy().unwrap(),
                            Some(&format!("Bearer resource_metadata=\"{base}/resource\""))
                        )
                        .await
                        .unwrap(),
                    AuthStatus::Ready
                ));
                assert!(restored.ready_credential(name).await.is_ok());
                let changed = normalize_plugin_document(
                    false,
                    &json!({"server":{"required":true,"url":format!("{base}/changed-resource")}}),
                    temp.path(),
                    temp.path(),
                )
                .unwrap();
                let result = areal_mcp::Connections::connect_plugins_authorized(
                    &changed.servers,
                    &[(
                        "server".into(),
                        restored.ready_credential(name).await.unwrap(),
                    )]
                    .into(),
                    &Default::default(),
                    temp.path(),
                    tokio_util::sync::CancellationToken::new(),
                )
                .await;
                let binding_error = match result {
                    Err(error) => error,
                    Ok(_) => panic!("credential must remain bound to authorized endpoint"),
                };
                assert!(binding_error.is::<areal_mcp::AuthenticationFailed>());
                assert!(
                    !s.requests
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|r| r.starts_with("/changed-resource "))
                );
                for explicit in [
                    json!({"bearer_token_env_var":"EXPLICIT"}),
                    json!({"http_headers":{"Authorization":"Bearer explicit-token"}}),
                    json!({"env_http_headers":{"Authorization":"EXPLICIT_HEADER"}}),
                ] {
                    let mut server_config = explicit.as_object().unwrap().clone();
                    server_config.insert("url".into(), json!(format!("{base}/mcp-explicit")));
                    let explicit_configs = normalize_plugin_document(
                        false,
                        &json!({"server":server_config}),
                        temp.path(),
                        temp.path(),
                    )
                    .unwrap();
                    let env = [
                        ("EXPLICIT".into(), "explicit-token".into()),
                        ("EXPLICIT_HEADER".into(), "Bearer explicit-token".into()),
                    ]
                    .into();
                    let mut explicit_connection =
                        areal_mcp::Connections::connect_plugins_authorized(
                            &explicit_configs.servers,
                            &[(
                                "server".into(),
                                restored.ready_credential(name).await.unwrap(),
                            )]
                            .into(),
                            &env,
                            temp.path(),
                            tokio_util::sync::CancellationToken::new(),
                        )
                        .await
                        .unwrap();
                    let rejected = explicit_connection.tools()[0]
                        .call_raw(json!({}), tokio_util::sync::CancellationToken::new())
                        .await
                        .unwrap_err();
                    assert!(rejected.is::<areal_mcp::AuthenticationFailed>());
                    assert!(matches!(
                        restored.status(name).await,
                        Some(AuthStatus::Ready)
                    ));
                    let _ = explicit_connection.shutdown().await;
                }
                let error = connections.tools()[0]
                    .call_raw(json!({}), tokio_util::sync::CancellationToken::new())
                    .await
                    .unwrap_err();
                assert!(error.is::<areal_mcp::AuthenticationFailed>());
                assert!(!error.to_string().contains("UNKNOWN"));
                let _ = connections.shutdown().await;
                assert!(matches!(
                    manager.status(name).await,
                    Some(AuthStatus::Failed)
                ));
            }
        }
    }
    assert_eq!(
        s.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("grant_type=refresh_token"))
            .count(),
        1
    );
    assert_eq!(
        s.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("\"method\":\"tools/call\""))
            .count(),
        4
    );
    assert_eq!(
        s.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("/register "))
            .count(),
        1
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for e in std::fs::read_dir(temp.path().join("credentials")).unwrap() {
            let e = e.unwrap();
            assert_eq!(e.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
    task.abort();
}

#[tokio::test]
async fn refresh_rejection_and_provider_failure_do_not_submit_mcp_or_leak_errors() {
    for failure in [1, 2] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let s = Fixture {
            base: base.clone(),
            requests: Arc::default(),
            token_failure: Arc::default(),
            refresh_delay: Arc::default(),
        };
        let app = axum::Router::new().fallback(fixture).with_state(s.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let temp = tempfile::tempdir().unwrap();
        let manager = AuthManager::new(temp.path().join("credentials"), "failure").unwrap();
        let o = normalize_plugin_document(
            false,
            &json!({"server":{"required":true,"url":format!("{base}/mcp"),"oauth":{"clientId":"provided"}}}),
            temp.path(),
            temp.path(),
        )
        .unwrap();
        let status = manager
            .start(
                "server",
                &format!("{base}/mcp"),
                o.servers["server"].auth_policy().unwrap(),
                Some(&format!("Bearer resource_metadata=\"{base}/resource\"")),
            )
            .await
            .unwrap();
        let AuthStatus::Pending { authorization_url } = status else {
            panic!("pending")
        };
        let u = url::Url::parse(&authorization_url).unwrap();
        let q: std::collections::BTreeMap<_, _> = u.query_pairs().into_owned().collect();
        let mut callback = url::Url::parse(&q["redirect_uri"]).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("code", "fixture")
            .append_pair("state", &q["state"])
            .append_pair("iss", &base);
        reqwest_mcp::get(callback).await.unwrap();
        for _ in 0..100 {
            if matches!(manager.status("server").await, Some(AuthStatus::Ready)) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let credential = manager.ready_credential("server").await.unwrap();
        s.token_failure.store(failure, Ordering::SeqCst);
        let result = areal_mcp::Connections::connect_plugins_authorized(
            &o.servers,
            &[("server".into(), credential)].into(),
            &Default::default(),
            temp.path(),
            tokio_util::sync::CancellationToken::new(),
        )
        .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("refresh must fail"),
        };
        assert!(error.is::<areal_mcp::AuthenticationFailed>());
        assert!(!format!("{error:?}").contains("private"));
        assert!(!error.to_string().contains("UNKNOWN"));
        let records = s.requests.lock().unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|r| r.contains("grant_type=refresh_token"))
                .count(),
            1
        );
        assert_eq!(records.iter().filter(|r| r.starts_with("/mcp ")).count(), 0);
        drop(records);
        assert!(matches!(
            manager.status("server").await,
            Some(AuthStatus::Failed)
        ));
        task.abort();
    }
}

async fn start_fixture() -> (Fixture, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = Fixture {
        base,
        requests: Arc::default(),
        token_failure: Arc::default(),
        refresh_delay: Arc::default(),
    };
    let app = axum::Router::new()
        .fallback(fixture)
        .with_state(state.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (state, task)
}
async fn authorize(
    manager: &AuthManager,
    state: &Fixture,
    root: &std::path::Path,
    name: &str,
) -> (areal_mcp::AuthPolicy, areal_mcp::AuthorizedCredential) {
    let o = normalize_plugin_document(
        false,
        &json!({"server":{"required":true,"url":format!("{}/mcp",state.base),"oauth":{"clientId":"provided"}}}),
        root,
        root,
    )
    .unwrap();
    let policy = o.servers["server"].auth_policy().unwrap().clone();
    let status = manager
        .start(
            name,
            &format!("{}/mcp", state.base),
            &policy,
            Some(&format!(
                "Bearer resource_metadata=\"{}/resource\"",
                state.base
            )),
        )
        .await
        .unwrap();
    finish_callback(
        manager,
        state,
        name,
        status,
        "sentinel-private-authorization-code",
    )
    .await;
    (policy, manager.ready_credential(name).await.unwrap())
}
async fn finish_callback(
    manager: &AuthManager,
    state: &Fixture,
    name: &str,
    status: AuthStatus,
    code: &str,
) {
    let AuthStatus::Pending { authorization_url } = status else {
        panic!("fresh pending required")
    };
    let url = url::Url::parse(&authorization_url).unwrap();
    let q: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let mut callback = url::Url::parse(&q["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", &q["state"])
        .append_pair("iss", &state.base);
    assert!(
        reqwest_mcp::get(callback)
            .await
            .unwrap()
            .status()
            .is_success()
    );
    for _ in 0..100 {
        if matches!(manager.status(name).await, Some(AuthStatus::Ready)) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("callback not ready");
}
#[tokio::test]
async fn explicit_retry_after_rejection_enters_new_authorization() {
    for refresh_rejected in [false, true] {
        let (state, task) = start_fixture().await;
        let temp = tempfile::tempdir().unwrap();
        let manager = AuthManager::new(temp.path().join("auth"), "retry").unwrap();
        let (policy, credential) = authorize(&manager, &state, temp.path(), "server").await;
        if refresh_rejected {
            state.token_failure.store(1, Ordering::SeqCst);
        }
        let o = normalize_plugin_document(
            false,
            &json!({"server":{"required":true,"url":format!("{}/mcp",state.base)}}),
            temp.path(),
            temp.path(),
        )
        .unwrap();
        let result = areal_mcp::Connections::connect_plugins_authorized(
            &o.servers,
            &[("server".into(), credential)].into(),
            &Default::default(),
            temp.path(),
            tokio_util::sync::CancellationToken::new(),
        )
        .await;
        if !refresh_rejected {
            let mut c = result.unwrap();
            assert!(
                c.tools()[0]
                    .call_raw(json!({}), tokio_util::sync::CancellationToken::new())
                    .await
                    .unwrap_err()
                    .is::<areal_mcp::AuthenticationFailed>()
            );
            let _ = c.shutdown().await;
        } else {
            assert!(result.is_err());
        }
        let retry = manager
            .start(
                "server",
                &format!("{}/mcp", state.base),
                &policy,
                Some(&format!(
                    "Bearer resource_metadata=\"{}/resource\"",
                    state.base
                )),
            )
            .await;
        assert!(
            matches!(retry, Ok(AuthStatus::Pending { .. })),
            "explicit retry reused rejected credentials: {retry:?}"
        );
        assert_eq!(
            state
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.contains("\"method\":\"tools/call\""))
                .count(),
            if refresh_rejected { 0 } else { 1 }
        );
        manager.cancel("server").await;
        task.abort();
    }
}
#[derive(Clone)]
struct LogCapture(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for LogCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = Self;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}
#[tokio::test(flavor = "current_thread")]
async fn oauth_sdk_never_logs_codes_or_provider_secret_errors() {
    let capture = LogCapture(Arc::default());
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(capture.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let (state, task) = start_fixture().await;
    let temp = tempfile::tempdir().unwrap();
    let manager = AuthManager::new(temp.path().join("auth"), "log").unwrap();
    let (_, credential) = authorize(&manager, &state, temp.path(), "server").await;
    state.token_failure.store(1, Ordering::SeqCst);
    let o = normalize_plugin_document(
        false,
        &json!({"server":{"required":true,"url":format!("{}/mcp",state.base)}}),
        temp.path(),
        temp.path(),
    )
    .unwrap();
    let _ = areal_mcp::Connections::connect_plugins_authorized(
        &o.servers,
        &[("server".into(), credential)].into(),
        &Default::default(),
        temp.path(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await;
    task.abort();
    let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    for secret in [
        "sentinel-private-authorization-code",
        "private-provider-error",
        "test-private-token",
        "test-private-refresh",
    ] {
        assert!(
            !logs.contains(secret),
            "OAuth subscriber captured a sentinel secret"
        );
    }
}
#[tokio::test]
async fn same_store_managers_refresh_once_after_authoritative_reload() {
    let (state, task) = start_fixture().await;
    state.refresh_delay.store(150, Ordering::SeqCst);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("auth");
    let first = AuthManager::new(root.clone(), "shared").unwrap();
    let (policy, _) = authorize(&first, &state, temp.path(), "server").await;
    let second = AuthManager::new(root.clone(), "shared").unwrap();
    let third = AuthManager::new(root, "shared").unwrap();
    let endpoint = format!("{}/mcp", state.base);
    let challenge = format!("Bearer resource_metadata=\"{}/resource\"", state.base);
    let (a, b) = tokio::join!(
        second.start("server", &endpoint, &policy, Some(&challenge)),
        third.start("server", &endpoint, &policy, Some(&challenge))
    );
    assert!(matches!(a, Ok(AuthStatus::Ready)));
    assert!(matches!(b, Ok(AuthStatus::Ready)));
    assert_eq!(
        state
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("grant_type=refresh_token"))
            .count(),
        1,
        "same credential refreshed concurrently without reload"
    );
    task.abort();
}

#[tokio::test]
async fn superseded_callbacks_cannot_publish_or_overwrite_newer_credentials() {
    let (state, task) = start_fixture().await;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("auth");
    let first = AuthManager::new(root.clone(), "supersede").unwrap();
    let second = AuthManager::new(root.clone(), "supersede").unwrap();
    let endpoint = format!("{}/mcp", state.base);
    let o = normalize_plugin_document(
        false,
        &json!({"server":{"required":true,"url":endpoint,"auth":"oauth","oauth":{"clientId":"provided"}}}),
        temp.path(),
        temp.path(),
    )
    .unwrap();
    let policy = o.servers["server"].auth_policy().unwrap();
    let challenge = format!("Bearer resource_metadata=\"{}/resource\"", state.base);
    let old = first
        .start("server", &endpoint, policy, Some(&challenge))
        .await
        .unwrap();
    let new = second
        .start("server", &endpoint, policy, Some(&challenge))
        .await
        .unwrap();
    finish_callback(&second, &state, "server", new, "new-code").await;
    let AuthStatus::Pending { authorization_url } = old else {
        panic!("expected old pending");
    };
    let url = url::Url::parse(&authorization_url).unwrap();
    let q: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let mut callback = url::Url::parse(&q["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", "stale-code")
        .append_pair("state", &q["state"])
        .append_pair("iss", &state.base);
    let result = reqwest_mcp::get(callback).await;
    assert!(result.is_err() || !result.unwrap().status().is_success());
    assert!(matches!(
        second.status("server").await,
        Some(AuthStatus::Ready)
    ));
    assert!(
        !state
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("code=stale-code"))
    );
    let local = AuthManager::new(temp.path().join("parallel"), "supersede").unwrap();
    let (a, b) = tokio::join!(
        local.start("server", &endpoint, policy, Some(&challenge)),
        local.start("server", &endpoint, policy, Some(&challenge))
    );
    assert!(matches!(a, Ok(AuthStatus::Cancelled)));
    finish_callback(&local, &state, "server", b.unwrap(), "latest-code").await;
    assert!(local.ready_credential("server").await.is_ok());
    task.abort();
}

#[tokio::test]
#[ignore = "subprocess fixture entry, invoked by cross_process_refresh_serializes"]
async fn refresh_process_entry() {
    let root = std::env::var("MCP_TEST_AUTH_ROOT").unwrap();
    let endpoint = std::env::var("MCP_TEST_ENDPOINT").unwrap();
    let challenge = std::env::var("MCP_TEST_CHALLENGE").unwrap();
    let manager = AuthManager::new(root.into(), "process").unwrap();
    let config = normalize_plugin_document(
        false,
        &json!({"server":{"required":true,"url":endpoint,"oauth":{"clientId":"provided"}}}),
        std::path::Path::new("/tmp"),
        std::path::Path::new("/tmp"),
    )
    .unwrap();
    assert!(matches!(
        manager
            .start(
                "server",
                &endpoint,
                config.servers["server"].auth_policy().unwrap(),
                Some(&challenge)
            )
            .await,
        Ok(AuthStatus::Ready)
    ));
}
#[tokio::test]
async fn cross_process_refresh_serializes() {
    let (state, task) = start_fixture().await;
    state.refresh_delay.store(150, Ordering::SeqCst);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("auth");
    let manager = AuthManager::new(root.clone(), "process").unwrap();
    authorize(&manager, &state, temp.path(), "server").await;
    let spawn = || {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "refresh_process_entry", "--ignored"])
            .env("MCP_TEST_AUTH_ROOT", &root)
            .env("MCP_TEST_ENDPOINT", format!("{}/mcp", state.base))
            .env(
                "MCP_TEST_CHALLENGE",
                format!("Bearer resource_metadata=\"{}/resource\"", state.base),
            );
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap()
    };
    let (a, b) = tokio::join!(spawn().wait_with_output(), spawn().wait_with_output());
    let a = a.unwrap();
    let b = b.unwrap();
    assert!(
        a.status.success(),
        "child status {:?}, stdout {:?}, stderr {:?}",
        a.status,
        String::from_utf8_lossy(&a.stdout),
        String::from_utf8_lossy(&a.stderr)
    );
    assert!(
        b.status.success(),
        "child status {:?}, stdout {:?}, stderr {:?}",
        b.status,
        String::from_utf8_lossy(&b.stdout),
        String::from_utf8_lossy(&b.stderr)
    );
    assert_eq!(
        state
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("grant_type=refresh_token"))
            .count(),
        1
    );
    task.abort();
}
