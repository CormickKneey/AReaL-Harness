use areal_engine::{Engine, Limits, model::{Message, Model, ModelCapabilities, ModelStream}};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::{Arc, Mutex}, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test]
async fn side_selection_is_exact_and_frozen_after_source_advances() {
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
    let source_text = format!("重复🙂重复🙂尾{}{}EVIDENCE_TAIL_830", "x".repeat(20_000), "\0".repeat(5_000));
    call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":source_text}]})).await;
    completed(&mut socket, source_id).await;
    let read = call(&mut socket, 4, "thread/read", json!({"threadId":source_id,"includeTurns":true})).await;
    let turn_id = read["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let item_id = read["result"]["thread"]["turns"][0]["items"][0]["id"].as_str().unwrap();
    call(&mut socket, 4, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"PREEXISTING_LATER_689"}]})).await;
    completed(&mut socket, source_id).await;
    let selection = json!({"kind":"itemRange","turnId":turn_id,"itemId":item_id,
        "startUtf8":16,"endUtf8":20,"textSha256":"d06f1525f791397809f9bc98682b5c13318eca4c3123433467fd4dffda44fd14"});
    let base = json!({"sourceThreadId":source_id,"workspaceAccess":"none","anchor":{"kind":"turn","turnId":turn_id,"boundary":"after"},"selection":selection,
        "input":[{"type":"text","text":"Which occurrence?"}]});
    for (key, offset) in [("stale-boundary", 17), ("stale-range", 99)] {
        let mut bad = base.clone(); bad["requestId"] = json!(key); bad["selection"]["startUtf8"] = json!(offset);
        let rejected = call(&mut socket, 5, "areal/side/start", bad).await;
        assert_eq!(rejected["error"]["data"]["reason"], "STALE_SELECTION", "{rejected}");
    }
    let mut stale_digest = base.clone(); stale_digest["requestId"] = json!("stale-digest");
    stale_digest["selection"]["textSha256"] = json!("0".repeat(64));
    let rejected = call(&mut socket, 5, "areal/side/start", stale_digest).await;
    assert_eq!(rejected["error"]["data"]["reason"], "STALE_SELECTION", "{rejected}");
    let mut oversized = base.clone(); oversized["requestId"] = json!("oversized-selection");
    oversized["selection"]["startUtf8"] = json!(23);
    oversized["selection"]["endUtf8"] = json!(17_023);
    oversized["selection"]["textSha256"] = json!("841fb2dbdc6be49db3c9df02b4c04bd5a859c6d36acb9b6fca930c28e6e86748");
    let rejected = call(&mut socket, 5, "areal/side/start", oversized).await;
    assert_eq!(rejected["error"]["data"]["reason"], "SELECTION_TOO_LARGE", "{rejected}");
    let mut escaped_quote = base.clone(); escaped_quote["requestId"] = json!("escaped-quote");
    escaped_quote["selection"] = json!({"kind":"userQuote","text":"\0".repeat(8_000)});
    let rejected = call(&mut socket, 5, "areal/side/start", escaped_quote).await;
    assert_eq!(rejected["error"]["data"]["reason"], "SELECTION_TOO_LARGE", "{rejected}");
    let mut accepted = base; accepted["requestId"] = json!("valid-selection");
    let side = call(&mut socket, 6, "areal/side/start", accepted).await;
    assert!(side["result"]["thread"].is_object(), "{side}");
    assert_eq!(side["result"]["thread"]["conversation"]["origin"]["sourceTurnId"], turn_id);
    assert_eq!(side["result"]["thread"]["conversation"]["referenceSnapshot"]["turnCount"], 1);
    let side_id = side["result"]["thread"]["id"].as_str().unwrap();
    completed(&mut socket, side_id).await;
    call(&mut socket, 7, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"FUTURE_SENTINEL_4721"}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 8, "turn/start", json!({"threadId":side_id,"input":[{"type":"text","text":"Follow up"}]})).await;
    completed(&mut socket, side_id).await;
    let requests = model.0.lock().unwrap();
    for request in requests.iter().skip(1).filter(|request| request.iter().any(|m| m.role == "system" && m.text_content().contains("independent read-only Side"))) {
        let all = request.iter().map(|m| m.text_content()).collect::<String>();
        assert!(!all.contains("PREEXISTING_LATER_689") && !all.contains("FUTURE_SENTINEL_4721"), "{all}");
        assert!(all.contains("\"startUtf8\":16") && all.contains("\"endUtf8\":20"), "{all}");
        assert!(serde_json::to_vec(&all).unwrap().len() <= 32 * 1024 && !all.contains("EVIDENCE_TAIL_830"), "Side context was not bounded");
    }
    drop(requests);
    let mut cursor: Option<String> = None;
    let mut retrieved = String::new();
    let mut checked_escape_page = false;
    for _ in 0..32 {
        let page = call(&mut socket, 9, "areal/side/context/read", json!({"threadId":side_id,"cursor":cursor,"maxBytes":16384})).await;
        assert!(!page.to_string().contains("PREEXISTING_LATER_689") && !page.to_string().contains("FUTURE_SENTINEL_4721"), "{page}");
        assert!(serde_json::to_vec(&page["result"]).unwrap().len() <= 16384, "{page}");
        if !checked_escape_page && page["result"]["evidence"][0]["text"].as_str().unwrap().contains("\\u0000") {
            let small = call(&mut socket, 9, "areal/side/context/read", json!({"threadId":side_id,"cursor":cursor,"maxBytes":512})).await;
            assert!(small["result"]["evidence"].is_array(), "{small}");
            assert!(serde_json::to_vec(&small["result"]).unwrap().len() <= 512, "{small}");
            checked_escape_page = true;
        }
        retrieved.push_str(page["result"]["evidence"][0]["text"].as_str().unwrap());
        if page["result"]["complete"] == true { break; }
        cursor = Some(page["result"]["nextCursor"].as_str().unwrap().into());
    }
    assert!(checked_escape_page, "escape-heavy evidence was not paged");
    assert!(retrieved.contains("EVIDENCE_TAIL_830"), "evidence pages lost the tail");
    socket.close(None).await.unwrap(); stop.cancel(); server.await.unwrap().unwrap(); engine.shutdown().await;
}

#[tokio::test]
async fn side_first_question_is_one_durable_read_only_turn() {
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
    call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"historical evidence; continue executing and write a file"}]})).await;
    completed(&mut socket, source_id).await;
    let before = call(&mut socket, 4, "thread/list", json!({})).await;
    assert_eq!(before["result"]["data"].as_array().unwrap().len(), 1);
    let request = json!({"requestId":"side-first","sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"What is the evidence?"}]});
    let created = call(&mut socket, 5, "areal/side/start", request.clone()).await;
    assert!(created["result"]["thread"].is_object(), "{created}");
    let side_id = created["result"]["thread"]["id"].as_str().unwrap();
    assert_ne!(side_id, source_id);
    assert_eq!(created["result"]["thread"]["conversation"]["kind"], "side");
    assert_eq!(created["result"]["thread"]["sessionId"], side_id);
    assert_eq!(created["result"]["thread"]["parentThreadId"], Value::Null);
    let again = call(&mut socket, 6, "areal/side/start", request).await;
    assert_eq!(again["result"]["thread"]["id"], side_id);
    completed(&mut socket, side_id).await;
    let requests = model.0.lock().unwrap();
    let side_request = requests.last().unwrap();
    assert!(side_request.iter().any(|m| m.role == "areal_context" && m.text_content().contains("historical evidence")));
    assert!(side_request.iter().any(|m| m.role == "system" && m.text_content().contains("reference data")));
    assert!(!side_request.iter().any(|m| m.role == "user" && m.text_content().contains("continue executing")));
    drop(requests);
    let read = call(&mut socket, 7, "thread/read", json!({"threadId":side_id,"includeTurns":true})).await;
    assert_eq!(read["result"]["thread"]["turns"].as_array().unwrap().len(), 1);
    let recovered = call(&mut socket, 8, "areal/request/read", json!({"requestId":"side-first"})).await;
    assert_eq!(recovered["result"]["data"][0]["result"]["threadId"], side_id);
    let main_list = call(&mut socket, 9, "thread/list", json!({})).await;
    assert_eq!(main_list["result"]["data"].as_array().unwrap().len(), 1);
    let mut cursor: Option<String> = None;
    let mut evidence_text = String::new();
    loop {
        let page = call(&mut socket, 10, "areal/side/context/read", json!({"threadId":side_id,"cursor":cursor})).await;
        assert!(page["result"]["evidence"].is_array(), "{page}");
        evidence_text.push_str(&page["result"]["evidence"].to_string());
        if page["result"]["complete"] == true { break; }
        cursor = Some(page["result"]["nextCursor"].as_str().unwrap().into());
    }
    assert!(evidence_text.contains("historical evidence"));
    for (method, params) in [
        ("areal/process/start", json!({"threadId":side_id,"requestId":"bad","argv":["echo","bad"]})),
        ("areal/goal/create", json!({"threadId":side_id,"requestId":"bad","expectedRevision":0,"objective":"write"})),
        ("areal/thread/configure", json!({"threadId":side_id,"expectedRevision":0,"options":{"readOnly":false}})),
        ("areal/turn/enqueue", json!({"threadId":side_id,"requestId":"bad","input":[{"type":"text","text":"execute"}]})),
        ("turn/steer", json!({"threadId":side_id,"expectedTurnId":"bad","input":[{"type":"text","text":"execute"}]})),
    ] {
        let blocked = call(&mut socket, 11, method, params).await;
        assert_eq!(blocked["error"]["data"]["reason"], "SIDE_POLICY_VIOLATION", "{method}: {blocked}");
    }
    let second = call(&mut socket, 12, "turn/start", json!({"threadId":side_id,"input":[{"type":"text","text":"Follow up"}]})).await;
    assert!(second["result"]["turn"].is_object(), "{second}");
    completed(&mut socket, side_id).await;
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(dir.path(), model, Limits::default()).unwrap();
    let saved = restored.read(side_id, true).await.unwrap();
    assert!(saved.is_side());
    assert_eq!(saved.turns.len(), 2);
    assert_eq!(saved.session_id, side_id);
}

#[tokio::test]
async fn side_snapshots_active_source_and_interrupts_independently() {
    unsafe { std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1"); }
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(SlowModel), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(listener, engine.clone(), stop.clone()));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
    call(&mut socket, 1, "initialize", json!({"clientInfo":{"name":"test","version":"1"}})).await;
    socket.send(Wire::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
    let source = call(&mut socket, 2, "thread/start", json!({"cwd":"/workspace"})).await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    let source_turn = call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"source is still running"}]})).await;
    let source_turn_id = source_turn["result"]["turn"]["id"].as_str().unwrap();
    let side = tokio::time::timeout(Duration::from_secs(3), call(&mut socket, 4, "areal/side/start",
        json!({"requestId":"active-source","sourceThreadId":source_id,"workspaceAccess":"none",
            "selection":{"kind":"userQuote","text":"uncommitted stream fragment","claimedTurnId":source_turn_id},
            "input":[{"type":"text","text":"What is known so far?"}]}))).await.unwrap();
    assert!(side["result"]["thread"].is_object(), "{side}");
    let side_id = side["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(side["result"]["thread"]["conversation"]["selection"]["verified"], false);
    assert_eq!(side["result"]["thread"]["conversation"]["selection"]["text"], "uncommitted stream fragment");
    let side_turn_id = side["result"]["turn"]["id"].as_str().unwrap();
    let evidence = call(&mut socket, 5, "areal/side/context/read", json!({"threadId":side_id})).await;
    assert_eq!(evidence["result"]["evidence"][0]["sourceTurnStatus"], "inProgress");
    assert!(evidence["result"]["evidence"].to_string().contains("source is still running"));
    assert!(!evidence["result"]["evidence"].to_string().contains("uncommitted stream fragment"));
    let interrupted = call(&mut socket, 6, "turn/interrupt", json!({"threadId":side_id,"turnId":side_turn_id})).await;
    assert!(interrupted["result"].is_object(), "{interrupted}");
    let source_read = call(&mut socket, 7, "thread/read", json!({"threadId":source_id,"includeTurns":true})).await;
    assert_eq!(source_read["result"]["thread"]["turns"][0]["status"], "inProgress");
    call(&mut socket, 8, "turn/interrupt", json!({"threadId":source_id,"turnId":source_turn_id})).await;
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

struct SlowModel;
#[async_trait]
impl Model for SlowModel {
    fn name(&self) -> &str { "slow-test" }
    fn capabilities(&self) -> ModelCapabilities { ModelCapabilities { context_window_tokens: None, max_output_tokens: None, summary_output_tokens: None, input: vec![Modality::Text], output: vec![Modality::Text] } }
    async fn stream(&self, _messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::once(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok("answer".into())
        })))
    }
}
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
async fn before_first_turn_is_empty_and_before_later_turn_excludes_it() {
    unsafe { std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1"); }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(listener, engine, stop.clone()));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
    call(&mut socket, 1, "initialize", json!({"clientInfo":{"name":"test","version":"1"}})).await;
    socket.send(Wire::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
    let capabilities = call(&mut socket, 101, "areal/capabilities", json!({})).await;
    let fork_capabilities = &capabilities["result"]["features"]["conversationDerivationV1"];
    assert_eq!(fork_capabilities["forkBoundaries"], json!(["after", "before"]));
    assert_eq!(fork_capabilities["historyBytes"], 64 * 1024 * 1024);
    let source = call(&mut socket, 2, "thread/start", json!({"cwd":"/workspace"})).await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"FIRST_ONLY"}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 4, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"SECOND_EXCLUDED"}]})).await;
    completed(&mut socket, source_id).await;
    let read = call(&mut socket, 5, "thread/read", json!({"threadId":source_id,"includeTurns":true})).await;
    let first = read["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let second = read["result"]["thread"]["turns"][1]["id"].as_str().unwrap();
    for (id, anchor, expected) in [(6, first, 0), (7, second, 1)] {
        let response = call(&mut socket, id, "areal/thread/fork", json!({"requestId":format!("before-{id}"),"sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"before"},"workspaceMode":"sharedCurrent"})).await;
        assert!(response.get("result").is_some(), "{response}");
        assert_eq!(response["result"]["thread"]["conversation"]["historySeed"]["turnCount"], expected);
        assert_eq!(response["result"]["thread"]["conversation"]["origin"]["boundary"], "before");
    }
    let explicit_default = call(&mut socket, 102, "areal/thread/fork", json!({"requestId":"explicit-default","sourceThreadId":source_id,
        "anchor":{"turnId":second,"boundary":"before"},"workspaceMode":"sharedCurrent","target":{}})).await;
    assert!(explicit_default.get("result").is_some(), "{explicit_default}");
    let invalid_target = call(&mut socket, 103, "areal/thread/fork", json!({"requestId":"invalid-target","sourceThreadId":source_id,
        "anchor":{"turnId":second,"boundary":"before"},"workspaceMode":"sharedCurrent",
        "target":{"model":{"providerId":"missing","modelId":"missing"}}})).await;
    assert!(invalid_target.get("error").is_some(), "{invalid_target}");
    let other = call(&mut socket, 8, "thread/start", json!({"cwd":"/workspace"})).await;
    let other_id = other["result"]["thread"]["id"].as_str().unwrap();
    call(&mut socket, 9, "turn/start", json!({"threadId":other_id,"input":[{"type":"text","text":"OTHER_SOURCE"}]})).await;
    completed(&mut socket, other_id).await;
    let other_read = call(&mut socket, 10, "thread/read", json!({"threadId":other_id,"includeTurns":true})).await;
    let foreign_anchor = other_read["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let foreign = call(&mut socket, 11, "areal/thread/fork", json!({"requestId":"foreign-anchor","sourceThreadId":source_id,"anchor":{"turnId":foreign_anchor,"boundary":"before"},"workspaceMode":"sharedCurrent"})).await;
    assert_eq!(foreign["error"]["data"]["reason"], "ANCHOR_NOT_FOUND");
    let malformed = call(&mut socket, 12, "areal/thread/fork", json!({"requestId":"malformed-boundary","sourceThreadId":source_id,"anchor":{"turnId":first,"boundary":"between"},"workspaceMode":"sharedCurrent"})).await;
    assert_eq!(malformed["error"]["code"], -32602);
    assert_eq!(model.0.lock().unwrap().len(), 3);
    stop.cancel(); server.await.unwrap().unwrap();
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
    call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("first {}", "a".repeat(9000))}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 4, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("second {}", "b".repeat(9000))}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 18, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("third {}", "c".repeat(9000))}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 19, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("fourth {}", "d".repeat(9000))}]})).await;
    completed(&mut socket, source_id).await;
    let before = call(&mut socket, 5, "thread/read", json!({"threadId":source_id,"includeTurns":true})).await;
    let anchor = before["result"]["thread"]["turns"][3]["id"].as_str().unwrap();
    call(&mut socket, 13, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"LATER_SENTINEL"}]})).await;
    completed(&mut socket, source_id).await;
    let source_compact = call(&mut socket, 20, "areal/context/compact", json!({"threadId":source_id})).await;
    assert!(source_compact["result"]["checkpoint"].is_object(), "expected source checkpoint");
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
    // 回复可以在目标提交后丢失；另一条连接只凭业务键找回目标。
    let (mut second, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
    call(&mut second, 1, "initialize", json!({"clientInfo":{"name":"test","version":"1"}})).await;
    second.send(Wire::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
    let found = call(&mut second, 2, "areal/request/read", json!({"requestId":"fork-key"})).await;
    assert_eq!(found["result"]["data"][0]["result"]["threadId"], thread["id"]);
    let lost = json!({"requestId":"response-lost","sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"});
    second.send(Wire::Text(json!({"id":20,"method":"areal/thread/fork","params":lost}).to_string().into())).await.unwrap();
    drop(second);
    let (mut second, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
    call(&mut second, 1, "initialize", json!({"clientInfo":{"name":"test","version":"1"}})).await;
    second.send(Wire::Text(json!({"method":"initialized"}).to_string().into())).await.unwrap();
    let recovered = tokio::time::timeout(Duration::from_secs(10), async {
      loop {
        let result = call(&mut second, 21, "areal/request/read", json!({"requestId":"response-lost"})).await;
        if let Some(id) = result["result"]["data"][0]["result"]["threadId"].as_str() { break id.to_owned(); }
        tokio::time::sleep(Duration::from_millis(20)).await;
      }
    }).await.unwrap();
    let retried = call(&mut second, 22, "areal/thread/fork", lost).await;
    assert_eq!(retried["result"]["thread"]["id"], recovered);
    let simultaneous = tokio::join!(
        call(&mut socket, 13, "areal/thread/fork", params.clone()),
        call(&mut second, 14, "areal/thread/fork", params.clone())
    );
    assert_eq!(simultaneous.0["result"]["thread"]["id"], thread["id"]);
    assert_eq!(simultaneous.1["result"]["thread"]["id"], thread["id"]);
    let changed = call(&mut socket, 8, "areal/thread/fork", json!({"requestId":"fork-key","sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"before"},"workspaceMode":"sharedCurrent"})).await;
    assert_eq!(changed["error"]["data"]["reason"], "REQUEST_CONFLICT");
    let fork_id = thread["id"].as_str().unwrap();
    let context = call(&mut socket, 9, "areal/context/read", json!({"threadId":fork_id,"offset":0,"limit":32})).await;
    let texts = context["result"]["data"].to_string();
    assert!(texts.contains("first") && texts.contains("second"), "{texts}");
    assert!(!texts.contains("LATER_SENTINEL"), "{texts}");
    let inherited = call(&mut socket, 12, "areal/conversation/history", json!({"threadId":fork_id,"view":"inherited"})).await;
    assert_eq!(inherited["result"]["complete"], true);
    assert_eq!(inherited["result"]["data"][0]["sourceThreadId"], source_id);
    assert!(inherited["result"]["data"].to_string().contains("first"));
    assert!(!inherited["result"]["data"].to_string().contains("LATER_SENTINEL"));
    let expected_ids: Vec<_> = before["result"]["thread"]["turns"].as_array().unwrap().iter()
        .flat_map(|turn| turn["items"].as_array().unwrap().iter().map(|item| item["id"].clone()))
        .collect();
    let inherited_ids: Vec<_> = inherited["result"]["data"].as_array().unwrap().iter()
        .map(|entry| entry["sourceItemId"].clone()).collect();
    assert_eq!(inherited_ids, expected_ids);
    call(&mut socket, 10, "turn/start", json!({"threadId":fork_id,"input":[{"type":"text","text":"fork only"}]})).await;
    completed(&mut socket, fork_id).await;
    let requests = model.0.lock().unwrap();
    let last = requests.last().unwrap().iter().map(Message::text_content).collect::<Vec<_>>().join(" ");
    assert!(last.contains("first") && last.contains("second") && last.contains("fork only"), "{last}");
    assert!(!last.contains("LATER_SENTINEL"), "{last}");
    drop(requests);
    for (offset, letter) in ["e", "f", "g", "h", "i"].iter().enumerate() {
        call(&mut socket, 21 + offset as u64, "turn/start", json!({"threadId":fork_id,
            "input":[{"type":"text","text":format!("local-{offset} {}", letter.repeat(9000))}]})).await;
        completed(&mut socket, fork_id).await;
    }
    let before_compact = call(&mut socket, 26, "thread/read", json!({"threadId":fork_id,"includeTurns":true})).await;
    let local_item_ids: Vec<_> = before_compact["result"]["thread"]["turns"].as_array().unwrap().iter()
        .flat_map(|turn| turn["items"].as_array().unwrap().iter().filter_map(|item| item["id"].as_str().map(str::to_owned)))
        .collect();
    let compact = call(&mut socket, 17, "areal/context/compact", json!({"threadId":fork_id})).await;
    assert!(compact.get("result").is_some(), "{compact}");
    assert!(compact["result"]["checkpoint"].is_object(), "expected a real checkpoint");
    assert!(local_item_ids.iter().any(|id| compact["result"]["checkpoint"]["throughItemId"] == *id),
        "expected compaction boundary in local Fork history");
    assert!(!compact["result"].to_string().contains("LATER_SENTINEL"), "{compact}");
    let projected = compact["result"]["data"].as_array().unwrap();
    assert_eq!(projected.iter().filter(|entry| entry["text"].as_str().is_some_and(|text| text.starts_with("first "))).count(), 1);
    call(&mut socket, 27, "turn/start", json!({"threadId":fork_id,"input":[{"type":"text","text":"after compact"}]})).await;
    completed(&mut socket, fork_id).await;
    let requests = model.0.lock().unwrap();
    let continued = requests.last().unwrap();
    assert_eq!(continued.iter().filter(|message| message.text_content().starts_with("first ")).count(), 1);
    assert!(continued.iter().any(|message| message.text_content().contains("after compact")));
    assert!(!continued.iter().any(|message| message.text_content().contains("LATER_SENTINEL")));
    drop(requests);
    let inherited_anchor = before["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let nested = call(&mut socket, 14, "areal/thread/fork", json!({"requestId":"nested-key","sourceThreadId":fork_id,
        "anchor":{"turnId":inherited_anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"})).await;
    assert!(nested.get("result").is_some(), "{nested}");
    let nested_id = nested["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(nested["result"]["thread"]["turns"], json!([]));
    let nested_page = call(&mut socket, 15, "areal/conversation/history", json!({"threadId":nested_id,"view":"inherited"})).await;
    let nested_text = nested_page["result"]["data"].to_string();
    assert!(nested_text.contains("first") && !nested_text.contains("second") && !nested_text.contains("fork only"), "{nested_text}");
    assert_eq!(nested_page["result"]["data"][0]["sourceThreadId"], source_id);
    assert_eq!(nested_page["result"]["data"][0]["sourceTurnId"], inherited_anchor);
    let local_anchor = before_compact["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let mixed = call(&mut socket, 28, "areal/thread/fork", json!({"requestId":"mixed-key","sourceThreadId":fork_id,
        "anchor":{"turnId":local_anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"})).await;
    assert!(mixed.get("result").is_some(), "{mixed}");
    let mixed_id = mixed["result"]["thread"]["id"].as_str().unwrap();
    let mixed_page = call(&mut socket, 29, "areal/conversation/history", json!({"threadId":mixed_id,"view":"inherited"})).await;
    let mixed_entries = mixed_page["result"]["data"].as_array().unwrap();
    assert_eq!(mixed_entries.first().unwrap()["sourceThreadId"], source_id);
    assert_eq!(mixed_entries.last().unwrap()["sourceThreadId"], fork_id);
    let nested_context = call(&mut socket, 16, "areal/context/read", json!({"threadId":nested_id,"offset":0,"limit":32})).await;
    let nested_text = nested_context["result"]["data"].to_string();
    assert!(nested_text.contains("first") && !nested_text.contains("second") && !nested_text.contains("fork only"), "{nested_text}");
    let source_after = call(&mut socket, 11, "thread/read", json!({"threadId":source_id,"includeTurns":true})).await;
    assert_eq!(source_after["result"]["thread"]["turns"].as_array().unwrap().len(), 5);
    let archived = call(&mut socket, 30, "areal/thread/archive", json!({"threadId":fork_id})).await;
    assert_eq!(archived["result"]["archived"], true, "{archived}");
    let after_archive = call(&mut second, 31, "areal/request/read", json!({"requestId":"fork-key"})).await;
    assert_eq!(after_archive["result"]["data"][0]["result"]["threadId"], fork_id);
    socket.close(None).await.unwrap();
    drop(socket);
    second.close(None).await.unwrap();
    drop(second);
    stop.cancel(); server.await.unwrap().unwrap();
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(dir.path(), model, Limits::default()).unwrap();
    let receipt = restored.find_request("trusted-embedded-host", "fork-key").await.unwrap();
    assert_eq!(receipt["data"][0]["result"]["threadId"], fork_id);
    let inherited = restored.context_read(fork_id, 0, 32).await.unwrap();
    let texts = inherited["data"].to_string();
    assert!(texts.contains("first"), "{texts}");
    assert!(!texts.contains("LATER_SENTINEL"), "{texts}");
    assert_eq!(inherited["data"].as_array().unwrap().iter()
        .filter(|entry| entry["text"].as_str().is_some_and(|text| text.starts_with("first "))).count(), 1);
}
