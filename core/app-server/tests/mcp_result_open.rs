use areal_app_server::auth::{Authentication, Permission, Principal};
use areal_engine::{Engine, Limits};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn saved_result_route_is_strict_and_requires_unscoped_manage() {
    let state = tempfile::tempdir().unwrap();
    let model =
        areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
            .unwrap();
    let engine = Engine::open(state.path(), Arc::new(model), Limits::default()).unwrap();
    let tokens = [
        "result-owner-1234567890123456789012",
        "result-reader-123456789012345678901",
        "result-scoped-123456789012345678901",
    ];
    let auth = Authentication {
        version: 1,
        principals: vec![
            Principal {
                id: "owner".into(),
                token: tokens[0].into(),
                permissions: [Permission::Observe, Permission::Manage].into(),
                thread_ids: None,
            },
            Principal {
                id: "reader".into(),
                token: tokens[1].into(),
                permissions: [Permission::Observe].into(),
                thread_ids: None,
            },
            Principal {
                id: "scoped".into(),
                token: tokens[2].into(),
                permissions: [Permission::Observe, Permission::Manage].into(),
                thread_ids: Some(["t".into()].into()),
            },
        ],
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        stop.clone(),
        Some(auth),
    ));
    for (who, token) in tokens.into_iter().enumerate() {
        let mut request = format!("ws://{addr}").into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let inputs = [
            (
                "initialize",
                json!({"clientInfo":{"name":"result-test","version":"1"}}),
            ),
            ("areal/capabilities", json!({})),
            (
                "areal/mcp/app/openFromResult",
                json!({"threadId":"t","turnId":"turn","itemId":"item","requestId":"result-v1.00000000-0000-4000-8000-000000000001.00000000-0000-4000-8000-000000000002","resourceUri":"ui://forged"}),
            ),
            (
                "areal/mcp/app/openFromResult",
                json!({"threadId":"t","callId":"ambiguous","requestId":"legacy"}),
            ),
        ];
        for (id, (method, params)) in inputs.into_iter().enumerate() {
            socket
                .send(Message::Text(
                    json!({"id":id,"method":method,"params":params})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let response = loop {
                let message = tokio::time::timeout(Duration::from_secs(10), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                if value["id"] == id {
                    break value;
                }
            };
            if id == 0 {
                assert!(response["result"].is_object());
                socket
                    .send(Message::Text(
                        json!({"method":"initialized"}).to_string().into(),
                    ))
                    .await
                    .unwrap();
            } else if id == 1 {
                assert!(
                    response["result"]["methods"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("areal/mcp/app/openFromResult"))
                );
            } else if who == 0 {
                assert_eq!(response["error"]["code"], -32602, "{response}");
            } else {
                assert!(
                    response["error"].is_object(),
                    "restricted principal must not open result: {response}"
                );
                assert_ne!(response["error"]["code"], -32601);
            }
        }
    }
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn page_tool_routes_are_public_and_require_manage_and_tools() {
    let state = tempfile::tempdir().unwrap();
    let model =
        areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
            .unwrap();
    let engine = Engine::open(state.path(), Arc::new(model), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let auth = Authentication {
        version: 1,
        principals: vec![Principal {
            id: "page-owner".into(),
            token: "page-owner-token-12345678901234567890".into(),
            permissions: [Permission::Observe, Permission::Manage].into(),
            thread_ids: None,
        }],
    };
    let server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        stop.clone(),
        Some(auth),
    ));
    let mut request = format!("ws://{address}").into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        "Bearer page-owner-token-12345678901234567890"
            .parse()
            .unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let mut methods = vec![
        (
            "initialize",
            json!({"clientInfo":{"name":"page-tools-test","version":"1"}}),
        ),
        ("areal/capabilities", json!({})),
    ];
    for method in [
        "areal/mcp/app/tools/register",
        "areal/mcp/app/tools/revoke",
        "areal/mcp/app/tools/claim",
        "areal/mcp/app/tools/resolve",
    ] {
        methods.push((method, json!({})));
    }
    for (id, (method, params)) in methods.into_iter().enumerate() {
        socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let response = loop {
            let message = tokio::time::timeout(Duration::from_secs(10), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if value["id"] == id {
                break value;
            }
        };
        if id == 0 {
            assert!(response["result"].is_object());
            socket
                .send(Message::Text(
                    json!({"method":"initialized"}).to_string().into(),
                ))
                .await
                .unwrap();
        } else if id == 1 {
            for route in ["register", "revoke", "claim", "resolve"] {
                assert!(
                    response["result"]["methods"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(format!("areal/mcp/app/tools/{route}"))),
                    "page-tool route absent from public capabilities: {route}"
                );
            }
            assert!(
                !response["result"]["methods"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("areal/mcp/app/tools/reject"))
            );
        } else {
            assert_eq!(
                response["error"]["code"], -32003,
                "Manage without Tools must not operate a page executor: {response}"
            );
        }
    }
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}
