use areal_engine::{Engine, Limits, model::{AgentStream, Message, Model, ModelCapabilities, ModelEvent, ModelStream, ToolCall}, tools::{HookDefinition, HookEvent, RuntimeConfig, ToolExtensions}};
use areal_protocol::Modality;
use areal_runtime::components::RuntimeHost;
use areal_runtime_client::Client;
use areal_runtime_supervisor::Config;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct ReadModel { workspace: PathBuf, round: AtomicUsize }

#[async_trait]
impl Model for ReadModel {
    fn name(&self) -> &str { "side-native-fixture" }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities { context_window_tokens: None, max_output_tokens: None, summary_output_tokens: None,
            input: vec![Modality::Text], output: vec![Modality::Text] }
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!("Side uses chat")
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        let mut names: Vec<_> = tools.iter().filter_map(|tool| tool["function"]["name"].as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["fs_list", "fs_read", "fs_stat", "search_files", "side_context_read"]);
        let round = self.round.fetch_add(1, Ordering::SeqCst);
        let previous = messages.iter().rev().find(|message| message.role == "tool")
            .map(Message::text_content).unwrap_or_default();
        let next = match round {
            0 => ("fs_read", json!({"path":"note.txt","offset":0,"maxBytes":4})),
            1 => {
                let result: Value = serde_json::from_str(&previous)?;
                assert_eq!(result["source"], "currentWorkspace");
                assert_eq!(result["changedSincePreviousPage"], Value::Null);
                std::fs::write(self.workspace.join("note.txt"), "updated-data").unwrap();
                ("fs_read", json!({"path":"note.txt","offset":4,"maxBytes":4}))
            }
            2 => {
                let result: Value = serde_json::from_str(&previous)?;
                assert_eq!(result["source"], "currentWorkspace");
                assert_eq!(result["changedSincePreviousPage"], true);
                ("fs_read", json!({"path":"../secret.txt"}))
            }
            3 => ("fs_read", json!({"path":"link.txt"})),
            4 => ("search_files", json!({"pattern":"updated", "path":"."})),
            5 => {
                let result: Value = serde_json::from_str(&previous)?;
                assert_eq!(result["source"], "currentWorkspace", "{result}");
                return Ok(Box::pin(futures_util::stream::iter([Ok(ModelEvent::text("Verified read-only current files"))])));
            }
            6 => ("fs_write", json!({"path":"note.txt","text":"forbidden","expectedSha256":null})),
            7 => ("run_command", json!({"command":"touch note.txt"})),
            _ => panic!("unexpected model round {round}"),
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(ModelEvent::ToolCall(ToolCall {
            id: format!("side-call-{round}"), name: next.0.into(), arguments: next.1.to_string(),
        }))])))
    }
}

async fn call(socket: &mut Socket, id: u64, method: &str, params: Value) -> Value {
    socket.send(Wire::Text(json!({"id":id,"method":method,"params":params}).to_string().into())).await.unwrap();
    loop {
        let wire = tokio::time::timeout(Duration::from_secs(15), socket.next()).await.unwrap().unwrap().unwrap();
        let value: Value = serde_json::from_str(wire.to_text().unwrap()).unwrap();
        if value["id"] == id { return value; }
    }
}

// Run explicitly after `make build`; this executes the installed native Seatbelt/Bubblewrap profile.
#[tokio::test]
#[ignore = "requires built areal-runtime-fs and native sandbox availability"]
async fn side_read_only_is_native_scoped_and_reports_current_file_changes() {
    unsafe { std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1"); }
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("repo");
    let data = dir.path().join("data");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("note.txt"), "first-data").unwrap();
    std::fs::write(dir.path().join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.txt"), workspace.join("link.txt")).unwrap();
    let helper = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("areal-runtime-fs");
    assert!(helper.is_file(), "build {helper:?} with make build first");
    let mut config = Config::read_only(workspace.clone());
    config.writable = true;
    config.allow_network = true;
    config.file_helper = Some(helper);
    let host = RuntimeHost::launch(config).await.unwrap();
    let (client_pipe, runtime_pipe) = tokio::io::duplex(128 * 1024);
    let (client_read, client_write) = tokio::io::split(client_pipe);
    let (runtime_read, runtime_write) = tokio::io::split(runtime_pipe);
    let runtime_stop = CancellationToken::new();
    let serving = tokio::spawn(areal_runtime::serve(runtime_read, runtime_write, host.clone(), runtime_stop.clone()));
    let client = Client::connect(client_read, client_write).await.unwrap();
    let runtime = RuntimeConfig {client: client.clone(), workspace: workspace.clone(), writable: true,
        command_scope: None, command_scratch: None};
    let model = Arc::new(ReadModel {workspace: workspace.clone(), round: AtomicUsize::new(0)});
    let engine = Engine::open_with_runtime(&data, model.clone(), Limits::default(), runtime).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(listener, engine.clone(), stop.clone()));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
    call(&mut socket, 1, "initialize", json!({"clientInfo":{"name":"test","version":"1"}})).await;
    socket.send(Wire::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
    let capabilities = call(&mut socket, 10, "areal/capabilities", json!({})).await;
    assert_eq!(capabilities["result"]["features"]["conversationDerivationV1"]["sideWorkspaceAccess"], json!(["none","readOnly"]), "{capabilities}");
    let source = call(&mut socket, 2, "thread/start", json!({"cwd":workspace})).await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    let side = call(&mut socket, 3, "areal/side/start", json!({"requestId":"native-side", "sourceThreadId":source_id,
        "workspaceAccess":"readOnly", "input":[{"type":"text","text":"Read current file"}]})).await;
    let side_id = side["result"]["thread"]["id"].as_str().expect(&side.to_string());
    let completed = tokio::time::timeout(Duration::from_secs(30), engine.wait(side_id)).await.unwrap().unwrap();
    assert_eq!(completed.turns[0].status, areal_protocol::TurnStatus::Completed);
    assert_eq!(model.round.load(Ordering::SeqCst), 6);
    assert_eq!(std::fs::read(workspace.join("note.txt")).unwrap(), b"updated-data");
    let calls: Vec<_> = completed.turns[0].items.iter().filter_map(|item| match item {
        areal_protocol::Item::DynamicToolCall {tool, success, content_items, ..} => Some((tool, success, content_items)), _ => None,
    }).collect();
    assert_eq!(calls.len(), 5);
    assert_eq!(calls.iter().map(|(_, success, _)| **success).collect::<Vec<_>>(),
        [Some(true), Some(true), Some(false), Some(false), Some(true)]);
    let first: Value = serde_json::from_str(calls[0].2.as_ref().unwrap()[0]["text"].as_str().unwrap()).unwrap();
    let second: Value = serde_json::from_str(calls[1].2.as_ref().unwrap()[0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(first["source"], "currentWorkspace");
    assert_eq!(second["changedSincePreviousPage"], true);
    assert_eq!(std::fs::read(dir.path().join("secret.txt")).unwrap(), b"secret");
    let process = call(&mut socket, 19, "areal/process/start", json!({"threadId":side_id,
        "requestId":"side-process-denied","argv":["/usr/bin/touch",workspace.join("forbidden.txt")]})).await;
    assert_eq!(process["error"]["data"]["reason"], "SIDE_POLICY_VIOLATION", "{process}");
    assert!(!workspace.join("forbidden.txt").exists());
    for (request_id, attempted) in [("write-denied", "fs_write"), ("command-denied", "run_command")] {
        let side = call(&mut socket, 20 + model.round.load(Ordering::SeqCst) as u64, "areal/side/start",
            json!({"requestId":request_id,"sourceThreadId":source_id,"workspaceAccess":"readOnly",
                "input":[{"type":"text","text":attempted}]})).await;
        let id = side["result"]["thread"]["id"].as_str().expect(&side.to_string());
        let denied = tokio::time::timeout(Duration::from_secs(15), engine.wait(id)).await.unwrap().unwrap();
        assert_eq!(denied.turns[0].status, areal_protocol::TurnStatus::Failed);
        assert!(denied.turns[0].error.as_ref().unwrap().message.contains("SIDE_POLICY_VIOLATION"));
        assert_eq!(std::fs::read(workspace.join("note.txt")).unwrap(), b"updated-data");
    }
    assert_eq!(model.round.load(Ordering::SeqCst), 8);
    drop(socket); stop.cancel(); server.await.unwrap().unwrap(); engine.shutdown().await;

    let hook_data = dir.path().join("hook-data");
    let hooks = ToolExtensions {hooks: vec![HookDefinition {name:"mandatory-audit".into(), event:HookEvent::PreToolUse,
        matcher:"*".into(), argv:vec!["/usr/bin/true".into()], timeout_ms:1000}], ..Default::default()};
    let with_hook = Engine::open_with_extensions(&hook_data, Arc::new(ReadModel {workspace:workspace.clone(), round:AtomicUsize::new(0)}),
        Limits::default(), Some(RuntimeConfig {client:client.clone(),workspace,writable:true,command_scope:None,command_scratch:None}), hooks).unwrap();
    assert!(!with_hook.side_workspace_read_available());
    with_hook.shutdown().await;
    client.shutdown().await.unwrap(); runtime_stop.cancel(); serving.await.unwrap().unwrap(); host.shutdown().await.unwrap();
}
