use areal_mcp::{Connections, normalize_plugin_document};
use serde_json::json;
use tokio_util::sync::CancellationToken;
#[tokio::test]
async fn modern_discovery_connects() {
    let root = tempfile::tempdir().unwrap();
    let config=normalize_plugin_document(false,&json!({"modern":{"command":"python3","args":[concat!(env!("CARGO_MANIFEST_DIR"),"/tests/mrtr.py")]}}),root.path(),root.path()).unwrap();
    let env = [("PATH".into(), std::env::var_os("PATH").unwrap())].into();
    let mut c =
        Connections::connect_plugins(&config.servers, &env, root.path(), CancellationToken::new())
            .await
            .unwrap();
    assert_eq!(
        c.servers().len(),
        1,
        "modern discover-only MCP must connect"
    );
    assert_eq!(
        c.servers()[0].info().protocol_version.as_str(),
        "2026-07-28"
    );
    c.shutdown().await.unwrap();
}

#[tokio::test]
async fn continuations_preserve_request_and_unknown_never_replays() {
    use areal_mcp::{ConnectionOptions, ElicitationBroker, RequestOwner};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    for mode in ["normal", "disconnect", "revoke", "deny", "timeout"] {
        let root = tempfile::tempdir().unwrap();
        let trace = root.path().join("wire.jsonl");
        let config=normalize_plugin_document(false,&json!({"modern":{"command":"python3","args":[concat!(env!("CARGO_MANIFEST_DIR"),"/tests/mrtr.py")],"env":{"TRACE":trace},"tool_timeout_sec":if mode=="timeout"||mode=="normal"{0.5}else{5.0}}}),root.path(),root.path()).unwrap();
        let env = [("PATH".into(), std::env::var_os("PATH").unwrap())].into();
        let (broker, mut requests) = ElicitationBroker::channel();
        let mut c = Connections::connect_plugins_with_options(
            &config.servers,
            &ConnectionOptions {
                elicitation: Some(broker),
                ..Default::default()
            },
            &env,
            root.path(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let allowed = Arc::new(AtomicBool::new(true));
        let gate = allowed.clone();
        let owner = RequestOwner::new("caller".into(), move || {
            let allowed = gate.clone();
            Box::pin(async move {
                anyhow::ensure!(
                    allowed.load(Ordering::SeqCst),
                    "caller no longer authorized"
                );
                Ok(())
            })
        });
        let tool = c.tools().remove(0);
        let args = json!({"mode":mode,"original":"fixed"});
        let args_expected = args.clone();
        let task = tokio::spawn(async move {
            tool.call_raw_owned(
                args,
                Some(json!({"private":"fixed"}).as_object().unwrap().clone()),
                CancellationToken::new(),
                Some(&owner),
            )
            .await
        });
        let form =
            match tokio::time::timeout(std::time::Duration::from_secs(3), requests.recv()).await {
                Ok(Some(f)) => f,
                _ => {
                    if task.is_finished() {
                        panic!("early outcome: {:?}", task.await.unwrap());
                    }
                    panic!("form timed out");
                }
            };
        assert_eq!(form.owner.as_deref(), Some("caller"));
        assert_eq!(
            form.params["requestedSchema"]["required"],
            json!(["answer"])
        );
        if mode == "revoke" {
            c.revoke();
        }
        if mode == "deny" {
            allowed.store(false, Ordering::SeqCst);
        }
        // Human waiting exceeds the entire active-execution budget on both rounds.
        if mode == "normal" {
            tokio::time::sleep(std::time::Duration::from_millis(650)).await;
        }
        let _ = form.respond(json!({"action":"accept","content":{"answer":"one"}}));
        if mode == "normal" {
            let form = tokio::time::timeout(std::time::Duration::from_secs(3), requests.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(form.request_id, json!("second"));
            tokio::time::sleep(std::time::Duration::from_millis(650)).await;
            form.respond(json!({"action":"cancel"})).unwrap();
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        if mode == "normal" {
            assert!(result.is_ok(), "{result:?}");
        } else {
            assert!(result.is_err());
        }
        if mode == "disconnect" || mode == "timeout" {
            assert!(result.unwrap_err().to_string().contains("UNKNOWN"));
        }
        let wire: Vec<serde_json::Value> = std::fs::read_to_string(trace)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .filter(|r: &serde_json::Value| r["method"] == "tools/call")
            .collect();
        assert_eq!(
            wire.len(),
            if mode == "normal" {
                3
            } else if mode == "disconnect" || mode == "timeout" {
                2
            } else {
                1
            }
        );
        let mut ids = std::collections::HashSet::new();
        for r in &wire {
            assert!(ids.insert(r["id"].to_string()));
            assert_eq!(r["params"]["arguments"], args_expected);
            assert_eq!(r["params"]["_meta"]["private"], "fixed");
            assert_eq!(
                r["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                "2026-07-28"
            );
        }
        if wire.len() > 1 {
            assert_eq!(wire[1]["params"]["requestState"], "opaque-first");
            assert_eq!(
                wire[1]["params"]["inputResponses"]["first"]["content"]["answer"],
                "one"
            );
        }
        if wire.len() > 2 {
            assert_eq!(wire[2]["params"]["requestState"], "opaque-second");
            assert!(wire[2]["params"]["inputResponses"].get("first").is_none());
            assert_eq!(
                wire[2]["params"]["inputResponses"]["second"]["action"],
                "cancel"
            );
        }
        let _ = c.shutdown().await;
    }
}

#[tokio::test]
async fn tool_authentication_marker_is_private_and_never_replayed() {
    for mode in ["markerRequired", "markerSuccess", "markerMalformed"] {
        let root = tempfile::tempdir().unwrap();
        let trace = root.path().join("wire.jsonl");
        let config=normalize_plugin_document(false,&json!({"modern":{"command":"python3","args":[concat!(env!("CARGO_MANIFEST_DIR"),"/tests/mrtr.py")],"env":{"TRACE":trace}}}),root.path(),root.path()).unwrap();
        let env = [("PATH".into(), std::env::var_os("PATH").unwrap())].into();
        let mut c = Connections::connect_plugins(
            &config.servers,
            &env,
            root.path(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let tool = c.tools().remove(0);
        let result = tool
            .call_raw(json!({"mode":mode}), CancellationToken::new())
            .await;
        if mode == "markerRequired" {
            assert!(
                result
                    .as_ref()
                    .is_err_and(|e| e.is::<areal_mcp::AuthenticationFailed>()),
                "expected actionable authentication error"
            );
            assert!(!result.unwrap_err().to_string().contains("private-metadata"));
            assert!(
                tool.call_raw(json!({"mode":mode}), CancellationToken::new())
                    .await
                    .is_err()
            );
            let calls = std::fs::read_to_string(trace)
                .unwrap()
                .lines()
                .filter(|l| {
                    serde_json::from_str::<serde_json::Value>(l).unwrap()["method"] == "tools/call"
                })
                .count();
            assert_eq!(calls, 1);
        } else {
            let raw = serde_json::to_value(result.unwrap()).unwrap();
            assert!(raw["_meta"].get("mcp/www_authenticate").is_none());
            assert_eq!(raw["_meta"]["preserved"], true);
        }
        c.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn required_startup_auth_retains_exact_server_identity() {
    use axum::response::IntoResponse;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app=axum::Router::new().fallback(|uri:axum::http::Uri,body:String|async move {
        if uri.path()=="/protected" {
            return (axum::http::StatusCode::UNAUTHORIZED,[("www-authenticate","Bearer resource_metadata=\"https://example.invalid/private-challenge\", scope=\"private-scope\"")]).into_response();
        }
        let request:serde_json::Value=serde_json::from_str(&body).unwrap();
        let result=match request["method"].as_str().unwrap(){
            "server/discover"=>json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"ttlMs":0,"cacheScope":"private"}),
            "tools/list"=>json!({"tools":[]}),
            _=>json!({}),
        };
        axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
    });
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let configs=[("a_healthy".to_owned(),serde_json::from_value::<areal_mcp::ServerConfig>(json!({"transport":{"type":"streamableHttp","url":format!("http://{address}/healthy")}})).unwrap()),("b_required_target".to_owned(),serde_json::from_value::<areal_mcp::ServerConfig>(json!({"transport":{"type":"streamableHttp","url":format!("http://{address}/protected")}})).unwrap())].into();
    let temp = tempfile::tempdir().unwrap();
    let error = match Connections::connect(
        &configs,
        &Default::default(),
        temp.path(),
        CancellationToken::new(),
    )
    .await
    {
        Ok(_) => panic!("required startup must fail"),
        Err(e) => e,
    };
    let initialization = error
        .downcast_ref::<areal_mcp::InitializationFailure>()
        .expect("original initialization cause retained");
    assert!(
        initialization
            .challenge()
            .unwrap()
            .contains("private-challenge")
    );
    assert!(
        format!("{error:#}").contains("b_required_target"),
        "required failure must identify the failing server"
    );
    let failure = error
        .downcast_ref::<areal_mcp::ConnectionFailure>()
        .expect("typed server identity retained");
    assert_eq!(failure.server, "b_required_target");
    assert_eq!(failure.class, "authentication");
    assert_eq!(
        failure.authentication_challenge(),
        initialization.challenge()
    );
    assert!(error.is::<areal_mcp::AuthenticationFailed>());
    assert!(
        !serde_json::to_string(failure)
            .unwrap()
            .contains("private-challenge")
    );
    assert!(!format!("{error:?}").contains("private-challenge"));
    assert!(!format!("{error:#}").contains("private-scope"));
    task.abort();
}
