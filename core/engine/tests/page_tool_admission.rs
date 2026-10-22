use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream},
};
use areal_protocol::{Input, ToolDefinition, plugin_runtime::*};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
struct InventoryModel {
    inventory: Mutex<Vec<Value>>,
    invoke: AtomicBool,
}
#[async_trait]
impl Model for InventoryModel {
    fn name(&self) -> &str {
        "page-admission"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        *self.inventory.lock().unwrap() = tools.clone();
        let event = if self.invoke.load(Ordering::SeqCst)
            && messages.last().is_none_or(|m| m.role != "tool")
        {
            let tool = tools
                .iter()
                .find(|t| {
                    t["function"]["name"]
                        .as_str()
                        .is_some_and(|n| n.ends_with("_get_selection"))
                })
                .unwrap();
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: "selection".into(),
                name: tool["function"]["name"].as_str().unwrap().into(),
                arguments: "{}".into(),
            })
        } else {
            ModelEvent::text("done")
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}
struct Host(tokio::sync::mpsc::Sender<PageToolNotice>);
#[async_trait]
impl areal_engine::tools::DynamicToolHost for Host {
    fn id(&self) -> &str {
        "page-admission-host"
    }
    fn identity(&self) -> &str {
        "owner"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        anyhow::bail!("unexpected dynamic call")
    }
    async fn page_tool_notice(&self, notice: PageToolNotice) -> anyhow::Result<()> {
        self.0.try_send(notice)?;
        Ok(())
    }
}
fn write(root: &Path, name: &str, content: &str) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

#[tokio::test]
async fn excess_page_registration_preserves_inventory_and_existing_page_calls() {
    let workspace = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
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
    let model = Arc::new(InventoryModel::default());
    let engine = Engine::open(state.path(), model.clone(), Limits::default()).unwrap();
    engine
        .set_permissions(
            serde_json::from_value(json!({"mode":"YOLO"})).unwrap(),
            None,
        )
        .unwrap();
    let store = Arc::new(
        areal_plugins::Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    engine.install_plugin_store(store.clone()).unwrap();
    let package = store.read("sample@local").unwrap();
    engine
        .plugin_install(
            package.id.clone(),
            "user".into(),
            package.revision,
            package.source,
            package.source_digest,
        )
        .await
        .unwrap();
    let package = store.read(&package.id).unwrap();
    engine
        .plugin_connection(package.id, package.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let baseline = engine
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    engine
        .start(&baseline.id, vec![Input::text("inventory")])
        .await
        .unwrap();
    engine.wait(&baseline.id).await.unwrap();
    let ordinary = model.inventory.lock().unwrap().len();
    let definitions = |count| {
        (0..count)
            .map(|i| ToolDefinition {
                name: format!("fixture_{i}"),
                description: "inventory fixture".into(),
                input_schema: json!({"type":"object"}),
                output_schema: None,
            })
            .collect()
    };
    let (tx, mut notices) = tokio::sync::mpsc::channel(8);
    let host = Arc::new(Host(tx));
    let mut dynamic_capacity = None;
    for count in (0..128).rev() {
        match engine
            .create_with_tools(
                workspace.path().to_str().unwrap().into(),
                definitions(count),
                host.clone(),
            )
            .await
        {
            Ok(_) => {
                dynamic_capacity = Some(count);
                break;
            }
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("tool registry exceeds 128 tools"),
                "{error}"
            ),
        }
    }
    let dynamic_count = dynamic_capacity.unwrap() - 2;
    let thread = engine
        .create_with_tools(
            workspace.path().to_str().unwrap().into(),
            definitions(dynamic_count),
            host.clone(),
        )
        .await
        .unwrap();
    let apps = engine.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let mut inputs = Vec::new();
    for i in 0..3 {
        let app = engine
            .mcp_app_open(
                "owner".into(),
                Some(host.clone()),
                thread.id.clone(),
                server.into(),
                generation,
                "app".into(),
                None,
                format!("open-{i}"),
                None,
                None,
            )
            .await
            .unwrap();
        inputs.push(PageRegister {
            thread_id: thread.id.clone(),
            instance_id: app["instanceId"].as_str().unwrap().into(),
            generation,
            owner_id: "00000000-0000-4000-8000-000000000002".into(),
            declaration: PageDeclaration {
                version: 1,
                document_id: uuid::Uuid::new_v4().to_string(),
                tools: vec![PageToolKind::GetSelection],
            },
        });
    }
    let first = engine
        .mcp_page_tools_register(host.clone(), inputs[0].clone())
        .await
        .unwrap();
    inputs[1].declaration.tools.push(PageToolKind::ApplyPatch);
    let rejected = engine
        .mcp_page_tools_register(host.clone(), inputs[1].clone())
        .await;
    assert!(
        rejected.is_err(),
        "two new tools must not exceed the combined 128-tool inventory"
    );
    assert_eq!(
        first,
        engine
            .mcp_page_tools_register(host.clone(), inputs[0].clone())
            .await
            .unwrap()
    );
    engine
        .start(&thread.id, vec![Input::text("inventory remains usable")])
        .await
        .unwrap();
    let finished = engine.wait(&thread.id).await.unwrap();
    assert!(
        !serde_json::to_value(finished)
            .unwrap()
            .to_string()
            .contains("tool registry exceeds")
    );
    assert_eq!(
        model.inventory.lock().unwrap().len(),
        ordinary + dynamic_count + 1
    );
    inputs[2].declaration.tools = vec![PageToolKind::ApplyPatch];
    engine
        .mcp_page_tools_register(host.clone(), inputs[2].clone())
        .await
        .unwrap();
    model.invoke.store(true, Ordering::SeqCst);
    engine
        .start(&thread.id, vec![Input::text("read the retained page")])
        .await
        .unwrap();
    let notice = tokio::time::timeout(std::time::Duration::from_secs(5), notices.recv())
        .await
        .unwrap()
        .unwrap();
    let PageToolNotice::Pending(coordinates) = notice else {
        panic!("expected pending call")
    };
    let claim = engine
        .mcp_page_tools_claim(host.clone(), coordinates.clone())
        .await
        .unwrap();
    engine
        .mcp_page_tools_resolve(
            host,
            PageResolve {
                thread_id: coordinates.thread_id,
                turn_id: coordinates.turn_id,
                call_id: coordinates.call_id,
                registration_id: coordinates.registration_id,
                owner_id: coordinates.owner_id,
                schema_digest: coordinates.schema_digest,
                claim_id: Some(claim["claimId"].as_str().unwrap().into()),
                reply: PageReply::Completed {
                    result: PageResult::Selection {
                        document_id: inputs[0].declaration.document_id.clone(),
                        document_revision: 0,
                        anchor: 0,
                        head: 0,
                        selected_text: String::new(),
                        truncated: false,
                        dirty: false,
                    },
                },
            },
        )
        .await
        .unwrap();
    let finished = serde_json::to_value(engine.wait(&thread.id).await.unwrap()).unwrap();
    assert_eq!(
        model.inventory.lock().unwrap().len(),
        ordinary + dynamic_count + 2
    );
    let page_call = finished["turns"].as_array().unwrap().last().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["tool"] == first["tools"][0]["name"])
        .unwrap();
    assert_eq!(page_call["execution"]["outcome"], "succeeded");
    assert_eq!(page_call["success"], true);
    engine.shutdown().await;
}
