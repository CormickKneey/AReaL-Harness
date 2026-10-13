use areal_mcp::{AuthenticationFailed, Connections, normalize_plugin_document};
use axum::{extract::State, response::IntoResponse};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
struct Fixture {
    started: Arc<tokio::sync::Barrier>,
    release: Arc<tokio::sync::Notify>,
    accepted: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
}
async fn peer(
    State(s): State<Fixture>,
    method: axum::http::Method,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    if method != axum::http::Method::POST {
        return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    assert_eq!(headers.get("x-literal").unwrap(), "private literal");
    assert_eq!(headers.get("x-ref").unwrap(), "private reference");
    assert_eq!(
        headers.get("authorization").unwrap(),
        "Bearer trusted-token"
    );
    let v: Value = serde_json::from_slice(&body).unwrap();
    let result = match v["method"].as_str().unwrap() {
        "initialize" => {
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1"}})
        }
        "notifications/initialized" | "notifications/cancelled" => {
            return axum::http::StatusCode::ACCEPTED.into_response();
        }
        "tools/list" => json!({"tools":[{"name":"test","inputSchema":{"type":"object"}}]}),
        "tools/call" => {
            s.calls.fetch_add(1, Ordering::SeqCst);
            let kind = v["params"]["arguments"]["kind"].as_str().unwrap();
            if kind == "reject" {
                s.started.wait().await;
                return (
                    axum::http::StatusCode::UNAUTHORIZED,
                    [("www-authenticate", "Bearer error=invalid_token")],
                )
                    .into_response();
            }
            s.accepted.fetch_add(1, Ordering::SeqCst);
            s.started.wait().await;
            s.release.notified().await;
            if kind == "unknown" {
                return (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    "malformed-after-side-effect",
                )
                    .into_response();
            }
            json!({"content":[{"type":"text","text":"completed side effect"}]})
        }
        _ => panic!("unexpected method"),
    };
    axum::Json(json!({"jsonrpc":"2.0","id":v["id"],"result":result})).into_response()
}
#[tokio::test]
async fn concurrent_auth_failure_never_relabels_other_result_or_unknown() {
    for kind in ["success", "unknown"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let state = Fixture {
            started: Arc::new(tokio::sync::Barrier::new(2)),
            release: Arc::default(),
            accepted: Arc::default(),
            calls: Arc::default(),
        };
        let app = axum::Router::new()
            .route("/mcp", axum::routing::any(peer))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let temp = tempfile::tempdir().unwrap();
        let o=normalize_plugin_document(false,&json!({"test":{"url":endpoint,"http_headers":{"X-Literal":"private literal","Authorization":"Bearer lower-priority-token"},"env_http_headers":{"X-Ref":"REF"},"bearer_token_env_var":"TOKEN","tool_timeout_sec":1}}),temp.path(),temp.path()).unwrap();
        let env = [
            ("REF".into(), "private reference".into()),
            ("TOKEN".into(), "trusted-token".into()),
        ]
        .into();
        let mut c =
            Connections::connect_plugins(&o.servers, &env, temp.path(), CancellationToken::new())
                .await
                .unwrap();
        let first = c.tools()[0].clone();
        let second = first.clone();
        let ongoing = tokio::spawn(async move {
            first
                .call_raw(json!({"kind":kind}), CancellationToken::new())
                .await
        });
        let rejected = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            second.call_raw(json!({"kind":"reject"}), CancellationToken::new()),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(rejected.is::<AuthenticationFailed>());
        assert_eq!(state.accepted.load(Ordering::SeqCst), 1);
        state.release.notify_one();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), ongoing)
            .await
            .unwrap()
            .unwrap();
        if kind == "success" {
            assert!(
                result.is_ok(),
                "successful independently accepted call was relabeled: {result:?}"
            );
        } else {
            let error = result.unwrap_err();
            assert!(
                !error.is::<AuthenticationFailed>(),
                "unknown independently accepted call relabeled authentication failure"
            );
            assert!(error.to_string().contains("UNKNOWN"));
        }
        assert_eq!(state.calls.load(Ordering::SeqCst), 2);
        let _ = c.shutdown().await;
        server.abort();
    }
}
