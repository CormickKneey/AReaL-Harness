use areal_engine::{Engine, Limits, model::{Message, Model, ModelCapabilities, ModelStream}};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::{Arc, Mutex}, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct TextModel(Mutex<Vec<Vec<Message>>>);
#[async_trait]
impl Model for TextModel {
    fn name(&self) -> &str { "test" }
    fn capabilities(&self) -> ModelCapabilities { ModelCapabilities { context_window_tokens: None, max_output_tokens: None, summary_output_tokens: None, input: vec![Modality::Text], output: vec![Modality::Text] } }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.lock().unwrap().push(messages);
        Ok(Box::pin(futures_util::stream::iter([Ok("answer".into())])))
    }
}
async fn call(socket: &mut Socket, id: u64, method: &str, params: Value) -> Value {
    socket.send(Wire::Text(json!({"id":id,"method":method,"params":params}).to_string().into())).await.unwrap();
    loop {
        let wire = tokio::time::timeout(Duration::from_secs(10), socket.next()).await.unwrap().unwrap().unwrap();
        let value: Value = serde_json::from_str(wire.to_text().unwrap()).unwrap();
        if value["id"] == id { return value; }
    }
}
async fn completed(socket: &mut Socket, thread_id: &str) {
    loop {
        let read = call(socket, 100, "thread/read", json!({"threadId":thread_id,"includeTurns":true})).await;
        if read["result"]["thread"]["turns"].as_array().is_some_and(|v| v.last().is_some_and(|t| t["status"] == "completed")) { return; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
#[tokio::test]
async fn fork_is_durable_idle_and_replays_plain_text_prefix() {
    unsafe { std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1"); }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(listener, engine.clone(), stop.clone()));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
    call(&mut socket, 1, "initialize", json!({"clientInfo":{"name":"test","version":"1"}})).await;
    socket.send(Wire::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
    let source = call(&mut socket, 2, "thread/start", json!({"cwd":"/workspace"})).await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"first"}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 4, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"second"}]})).await;
    completed(&mut socket, source_id).await;
    let before = call(&mut socket, 5, "thread/read", json!({"threadId":source_id,"includeTurns":true})).await;
    let anchor = before["result"]["thread"]["turns"][1]["id"].as_str().unwrap();
    let params = json!({"requestId":"fork-key","sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"});
    let count = model.0.lock().unwrap().len();
    let fork = call(&mut socket, 6, "areal/thread/fork", params.clone()).await;
    assert!(fork.get("result").is_some(), "{fork}");
    let thread = &fork["result"]["thread"];
    assert_ne!(thread["id"], source_id);
    assert_eq!(thread["sessionId"], thread["id"]);
    assert_eq!(thread["parentThreadId"], Value::Null);
    assert_eq!(thread["turns"], json!([]));
    assert_eq!(thread["conversation"]["kind"], "fork");
    assert_eq!(model.0.lock().unwrap().len(), count);
    let again = call(&mut socket, 7, "areal/thread/fork", params.clone()).await;
    assert_eq!(again["result"]["thread"]["id"], thread["id"]);
    let changed = call(&mut socket, 8, "areal/thread/fork", json!({"requestId":"fork-key","sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"before"},"workspaceMode":"sharedCurrent"})).await;
    assert_eq!(changed["error"]["data"]["reason"], "REQUEST_CONFLICT");
    let fork_id = thread["id"].as_str().unwrap();
    let context = call(&mut socket, 9, "areal/context/read", json!({"threadId":fork_id,"offset":0,"limit":32})).await;
    let texts = context["result"]["data"].to_string();
    assert!(texts.contains("first") && texts.contains("second"), "{texts}");
    let inherited = call(&mut socket, 12, "areal/conversation/history", json!({"threadId":fork_id,"view":"inherited"})).await;
    assert_eq!(inherited["result"]["complete"], true);
    assert_eq!(inherited["result"]["data"][0]["sourceThreadId"], source_id);
    assert!(inherited["result"]["data"].to_string().contains("first"));
    call(&mut socket, 10, "turn/start", json!({"threadId":fork_id,"input":[{"type":"text","text":"fork only"}]})).await;
    completed(&mut socket, fork_id).await;
    let requests = model.0.lock().unwrap();
    let last = requests.last().unwrap().iter().map(Message::text_content).collect::<Vec<_>>().join(" ");
    assert!(last.contains("first") && last.contains("second") && last.contains("fork only"), "{last}");
    let source_after = call(&mut socket, 11, "thread/read", json!({"threadId":source_id,"includeTurns":true})).await;
    assert_eq!(source_after["result"]["thread"]["turns"], before["result"]["thread"]["turns"]);
    drop(requests);
    drop(socket);
    stop.cancel(); server.await.unwrap().unwrap();
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(dir.path(), model, Limits::default()).unwrap();
    let inherited = restored.context_read(fork_id, 0, 32).await.unwrap();
    let texts = inherited["data"].to_string();
    assert!(texts.contains("first") && texts.contains("second") && texts.contains("fork only"), "{texts}");
}
