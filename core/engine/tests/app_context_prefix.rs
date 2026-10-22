//! App 数据跨 Turn 变化不得改写已经提交给模型的指令或消息前缀。
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose},
    tools::DynamicToolHost,
};
use areal_plugins::Store;
use areal_protocol::{DynamicToolResponse, Input, TurnStatus, desktop::ThreadStart};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Capture(Mutex<Vec<Vec<Message>>>);
#[async_trait]
impl Model for Capture {
    fn name(&self) -> &str {
        "app-prefix-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("done"),
        )])))
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        if purpose == RequestPurpose::Solve
            && messages
                .iter()
                .any(|m| m.role == "user" && m.text_content().starts_with("ack-app-"))
        {
            self.0.lock().unwrap().push(messages);
        }
        self.stream(vec![]).await
    }
}
struct NoTools;
#[async_trait]
impl DynamicToolHost for NoTools {
    fn id(&self) -> &str {
        "no-tools"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        unreachable!()
    }
}
fn write(root: &Path, path: &str, content: &str) {
    let p = root.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

#[tokio::test]
async fn real_app_updates_append_data_and_preserve_cross_turn_model_prefixes() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        workspace.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    write(
        workspace.path(),
        "pkg/.mcp.json",
        r#"{"mcpServers":{"fixture":{"command":"python3","args":["server.py"]}}}"#,
    );
    let model = Arc::new(Capture::default());
    let engine = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    engine.install_plugin_store(store.clone()).unwrap();
    let detail = store.read("sample@local").unwrap();
    engine
        .plugin_install(
            detail.id.clone(),
            "user".into(),
            detail.revision,
            detail.source,
            detail.source_digest,
        )
        .await
        .unwrap();
    let detail = store.read(&detail.id).unwrap();
    engine
        .plugin_connection(detail.id, detail.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = engine.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = engine
        .create_configured(
            "owner".into(),
            ThreadStart {
                request_id: "start".into(),
                cwd: Some(workspace.path().to_string_lossy().into_owned()),
                options: None,
                admission_guard: None,
                agent_profile: None,
                model: None,
                parameters: Default::default(),
                dynamic_tools: vec![],
            },
            Arc::new(NoTools),
        )
        .await
        .unwrap();
    let app = engine
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server,
            generation,
            "app".into(),
            None,
            "open".into(),
            None,
            None,
        )
        .await
        .unwrap();
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    for (index, selected) in [
        "prefix-selection-A",
        "prefix-selection-A",
        "prefix-selection-B",
        "prefix-selection-A",
    ]
    .into_iter()
    .enumerate()
    {
        engine.mcp_app_request("owner".into(),thread.id.clone(),instance.clone(),generation,
            json!({"jsonrpc":"2.0","id":index,"method":"ui/update-model-context","params":{"content":[{"type":"text","text":selected,"_meta":{"secret":true}}]}}),None).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text(format!("ack-app-{index}"))])
            .await
            .unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            completed.turns.last().unwrap().status,
            TurnStatus::Completed
        );
    }
    {
        let requests = model.0.lock().unwrap();
        assert_eq!(requests.len(), 4);
        let frames = |messages: &Vec<Message>| {
            messages
                .iter()
                .filter(|m| {
                    m.role == "areal_context"
                        && m.text_content()
                            .contains("Active App reference data snapshot")
                })
                .count()
        };
        assert_eq!(
            requests.iter().map(frames).collect::<Vec<_>>(),
            vec![1, 1, 2, 3]
        );
        for pair in requests.windows(2) {
            assert_eq!(
                &pair[1][..pair[0].len()],
                pair[0].as_slice(),
                "a changed App must append data after the entire previous request"
            );
        }
        for messages in &*requests {
            assert!(
                !messages
                    .iter()
                    .filter(|m| m.role == "system")
                    .any(|m| m.text_content().contains("prefix-selection-"))
            );
            assert!(
                !messages
                    .iter()
                    .any(|m| m.text_content().contains("\"secret\"")),
                "App _meta is not model context"
            );
        }
    }
    engine.shutdown().await;
}
