use areal_mcp::{Connections, ServerConfig};
use serde_json::json;
use std::{collections::BTreeMap, ffi::OsString, path::Path};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn startup_diagnostic_is_useful_without_response_or_url_secrets() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new().fallback(|| async {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "private-provider-body",
        )
    });
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config: ServerConfig = serde_json::from_value(json!({"transport":{"type":"streamableHttp","url":format!("http://{address}/mcp?secret=private-url-value")}})).unwrap();
    let error = match Connections::connect(
        &[("fixture".into(), config)].into(),
        &BTreeMap::new(),
        Path::new("/tmp"),
        CancellationToken::new(),
    )
    .await
    {
        Ok(_) => panic!("server failure expected"),
        Err(e) => e,
    };
    let initialization = error
        .downcast_ref::<areal_mcp::InitializationFailure>()
        .expect("typed initialization diagnostic retained");
    assert_eq!(
        initialization.http.as_ref().and_then(|http| http.status),
        Some(500)
    );
    let redacted = format!("{error:?}");
    assert!(!redacted.contains("private-provider-body") && !redacted.contains("private-url-value"));
    task.abort();
}

#[tokio::test]
#[ignore = "explicit authorized real GitHub acceptance; reads gh credential only in memory"]
async fn real_github_initialize_and_read_only_get_me() {
    use tracing_subscriber::{Layer, layer::SubscriberExt};
    let subscriber = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .with_filter(
                tracing_subscriber::filter::Targets::new()
                    .with_target("areal_mcp", tracing::Level::WARN),
            ),
    );
    let _ = tracing::subscriber::set_global_default(subscriber);
    assert_eq!(
        std::env::var("AREAL_TEST_GITHUB").as_deref(),
        Ok("authorized")
    );
    let output = tokio::process::Command::new("gh")
        .args(["auth", "token"])
        .output()
        .await
        .expect("credential helper unavailable");
    assert!(output.status.success(), "credential helper failed");
    let token = String::from_utf8(output.stdout).unwrap_or_else(|_| panic!("credential encoding"));
    let env: BTreeMap<OsString, OsString> =
        [("GITHUB_ACCEPTANCE_TOKEN".into(), token.trim().into())].into();
    let config:ServerConfig=serde_json::from_value(json!({"transport":{"type":"streamableHttp","url":"https://api.githubcopilot.com/mcp/","bearerTokenEnv":"GITHUB_ACCEPTANCE_TOKEN"},"startupTimeoutMs":30000,"callTimeoutMs":30000})).unwrap();
    let mut connections = match Connections::connect(
        &[("github".into(), config)].into(),
        &env,
        Path::new("/tmp"),
        CancellationToken::new(),
    )
    .await
    {
        Ok(c) => c,
        Err(e) => panic!("safe initialization diagnostic: {e}"),
    };
    let tool = connections
        .tools()
        .into_iter()
        .find(|t| t.original_name() == "get_me")
        .expect("GitHub get_me not advertised");
    let result = tool
        .call_raw(json!({}), CancellationToken::new())
        .await
        .expect("read-only GitHub call failed");
    assert!(
        !result.is_error.unwrap_or(false),
        "GitHub returned tool failure"
    );
    assert!(!result.content.is_empty(), "GitHub result missing content");
    println!(
        "Actual GitHub MCP initialized; get_me completed once; response and credentials omitted"
    );
    let _ = connections.shutdown().await;
}

#[tokio::test]
async fn oversized_connector_namespace_is_rejected_before_http_initialization() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let requests = Arc::new(AtomicUsize::new(0));
    let received = requests.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new().fallback(move || {
        let received = received.clone();
        async move {
            received.fetch_add(1, Ordering::SeqCst);
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        }
    });
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    // Actual Engine shape before its fix: p + twelve hex digits + '_' + 24-char connector suffix.
    let name = "p123456789abc_original-github-acceptan";
    assert_eq!(name.len(), 38);
    let config: ServerConfig = serde_json::from_value(
        json!({"transport":{"type":"streamableHttp","url":format!("http://{address}/mcp")}}),
    )
    .unwrap();
    let error = match Connections::connect(
        &[(name.into(), config)].into(),
        &BTreeMap::new(),
        Path::new("/tmp"),
        CancellationToken::new(),
    )
    .await
    {
        Ok(_) => panic!("namespace must obey MCP boundary"),
        Err(e) => e.to_string(),
    };
    assert!(error.contains("1..32"));
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "invalid Core namespace must not initialize transport"
    );
    task.abort();
}
