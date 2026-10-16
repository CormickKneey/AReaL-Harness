use areal_mcp::{Connections, normalize_plugin_document};
use serde_json::json;
use tokio_util::sync::CancellationToken;
#[tokio::test]
async fn generation_metadata_resources_and_revocation() {
    let root = tempfile::tempdir().unwrap();
    let o=normalize_plugin_document(false,&json!({"fixture":{"command":"python3","args":[concat!(env!("CARGO_MANIFEST_DIR"),"/tests/substrate.py")],"env":{"LITERAL":"fixture literal"}}}),root.path(),root.path()).unwrap();
    let env = [("PATH".into(), std::env::var_os("PATH").unwrap())].into();
    let mut c =
        Connections::connect_plugins(&o.servers, &env, root.path(), CancellationToken::new())
            .await
            .unwrap();
    let s = c.servers().remove(0);
    let t = c.tools().remove(0);
    assert_eq!(t.original_name(), "app");
    assert_eq!(t.server_name(), "fixture");
    assert_eq!(t.generation(), s.generation());
    assert_eq!(s.info().instructions.as_deref(), Some("keep instructions"));
    let metadata = serde_json::to_value(t.metadata()).unwrap();
    assert_eq!(metadata["annotations"]["readOnlyHint"], true);
    assert_eq!(metadata["icons"][0]["src"], "https://example.com/icon.png");
    assert!(t.app_visible());
    let raw = t
        .call_raw(json!({}), CancellationToken::new())
        .await
        .unwrap();
    let raw = serde_json::to_value(raw).unwrap();
    assert_eq!(raw["_meta"]["secret"], "retained");
    assert_eq!(raw["content"][0]["text"], "fixture literal");
    assert_eq!(
        s.list_resources(None, CancellationToken::new())
            .await
            .unwrap()
            .resources
            .len(),
        1
    );
    assert_eq!(
        s.list_resource_templates(None, CancellationToken::new())
            .await
            .unwrap()
            .resource_templates
            .len(),
        1
    );
    assert_eq!(
        s.read_resource("ui://app", CancellationToken::new())
            .await
            .unwrap()
            .contents
            .len(),
        1
    );
    let mut updates = s.resource_updates();
    s.subscribe("ui://app", CancellationToken::new())
        .await
        .unwrap();
    let update = updates.recv(CancellationToken::new()).await.unwrap();
    assert_eq!(update.server, "fixture");
    assert_eq!(update.generation, s.generation());
    assert_eq!(update.uri, "ui://app");
    s.unsubscribe("ui://app", CancellationToken::new())
        .await
        .unwrap();
    c.shutdown().await.unwrap();
    assert!(s.is_revoked());
    assert!(updates.recv(CancellationToken::new()).await.is_err());
    assert!(
        t.call_raw(json!({}), CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        s.read_resource("ui://app", CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn forms_bind_server_generation_and_cancel() {
    for (method, revoke) in [
        ("elicitation/create", false),
        ("openai/elicitation/create", false),
        ("elicitation/create", true),
    ] {
        let root = tempfile::tempdir().unwrap();
        let o=normalize_plugin_document(false,&json!({"fixture":{"command":"python3","args":[concat!(env!("CARGO_MANIFEST_DIR"),"/tests/substrate.py")]}}),root.path(),root.path()).unwrap();
        let (broker, mut requests) = areal_mcp::ElicitationBroker::channel();
        let options = areal_mcp::ConnectionOptions {
            elicitation: Some(broker),
            ..Default::default()
        };
        let env = [("PATH".into(), std::env::var_os("PATH").unwrap())].into();
        let mut c = Connections::connect_plugins_with_options(
            &o.servers,
            &options,
            &env,
            root.path(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let tool = c.tools().remove(0);
        let generation = tool.generation();
        let call = tokio::spawn(async move {
            tool.call_raw(json!({"form":method}), CancellationToken::new())
                .await
        });
        let request = tokio::time::timeout(std::time::Duration::from_secs(3), requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(request.server, "fixture");
        assert_eq!(request.generation, generation);
        assert_eq!(request.method, method);
        assert_eq!(request.request_id, json!("server-form"));
        if revoke {
            c.revoke();
            assert!(request.cancellation.is_cancelled());
            assert!(request.respond(json!({"action":"accept"})).is_err());
            assert!(call.await.unwrap().is_err());
            c.shutdown().await.unwrap();
            continue;
        }
        request
            .respond(json!({"action":"accept","content":{"answer":"accepted"}}))
            .unwrap();
        let result = call.await.unwrap().unwrap();
        assert!(serde_json::to_string(&result).unwrap().contains("accepted"));
        c.shutdown().await.unwrap();
    }
}
