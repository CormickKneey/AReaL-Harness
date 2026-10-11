use areal_app_server::auth::{Authentication, Permission, Principal};
use areal_engine::{
    Engine, Limits,
    model::{ContentPart, MediaSource, Message, Model, ModelCapabilities, ModelEvent, ModelStream},
};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message as Wire, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct ImageModel(Mutex<Vec<Vec<Message>>>);

#[async_trait]
impl Model for ImageModel {
    fn name(&self) -> &str {
        "image-fixture"
    }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            input: vec![Modality::Text, Modality::Image],
            output: vec![Modality::Text, Modality::Image],
            context_window_tokens: None,
            max_output_tokens: None,
            summary_output_tokens: None,
        }
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.lock().unwrap().push(messages);
        let png = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31,
            0, 3, 3, 2, 0, 239, 191, 151, 137, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ];
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ModelEvent::Binary {
                modality: Modality::Image,
                mime_type: "image/png".into(),
                data: png,
            }),
            Ok(ModelEvent::TextDelta("image retained".into())),
        ])))
    }
}

async fn call(socket: &mut Socket, id: u64, method: &str, params: Value) -> Value {
    socket
        .send(Wire::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    loop {
        let wire = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(wire.to_text().unwrap()).unwrap();
        if value["id"] == id {
            return value;
        }
    }
}

#[tokio::test]
async fn fork_keeps_inherited_media_readable_without_copying_execution() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ImageModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let owner_token = "fork-image-owner-token-1234567890";
    let scoped_token = "fork-image-scoped-token-1234567890";
    let auth = Authentication {
        version: 1,
        principals: vec![
            Principal {
                id: "owner".into(),
                token: owner_token.into(),
                permissions: [
                    Permission::Observe,
                    Permission::Interact,
                    Permission::Manage,
                ]
                .into(),
                thread_ids: None,
            },
            Principal {
                id: "scoped".into(),
                token: scoped_token.into(),
                permissions: [Permission::Observe].into(),
                thread_ids: Some(BTreeSet::new()),
            },
        ],
    };
    let server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        stop.clone(),
        Some(auth),
    ));
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {owner_token}").parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"test","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let source = call(&mut socket, 2, "thread/start", json!({"cwd":"/workspace"})).await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    let png = vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3,
        2, 0, 239, 191, 151, 137, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    let uploaded: Value = reqwest::Client::new()
        .post(format!("http://{addr}/areal/blobs?threadId={source_id}"))
        .bearer_auth(owner_token)
        .header("Content-Type", "image/png")
        .body(png)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let source_image = uploaded["uri"].as_str().unwrap();
    call(
        &mut socket,
        3,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"show image"},{"type":"image","url":source_image}]}),
    )
    .await;
    let read = loop {
        let read = call(
            &mut socket,
            4,
            "thread/read",
            json!({"threadId":source_id,"includeTurns":true}),
        )
        .await;
        if read["result"]["thread"]["turns"][0]["status"] == "completed" {
            break read;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let turn_id = read["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let media = read["result"]["thread"]["turns"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "agentMedia")
        .unwrap();
    let blob = media["media"]["uri"]
        .as_str()
        .unwrap()
        .strip_prefix("areal://blob/")
        .unwrap();
    let fork = call(
        &mut socket,
        5,
        "areal/thread/fork",
        json!({"requestId":"image-fork","sourceThreadId":source_id,
        "anchor":{"turnId":turn_id,"boundary":"after"},"workspaceMode":"sharedCurrent"}),
    )
    .await;
    assert!(fork.get("result").is_some(), "{fork}");
    let fork_id = fork["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(fork["result"]["thread"]["turns"], json!([]));
    call(
        &mut socket,
        7,
        "turn/start",
        json!({"threadId":fork_id,"input":[{"type":"text","text":"continue"}]}),
    )
    .await;
    loop {
        let read = call(
            &mut socket,
            8,
            "thread/read",
            json!({"threadId":fork_id,"includeTurns":true}),
        )
        .await;
        if read["result"]["thread"]["turns"][0]["status"] == "completed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        model
            .0
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .iter()
            .flat_map(|message| &message.content)
            .any(
                |part| matches!(part, ContentPart::Image { source: MediaSource::Url(url), .. }
            if url.starts_with("data:image/png;base64,"))
            )
    );
    let archived = call(
        &mut socket,
        6,
        "areal/thread/archive",
        json!({"threadId":source_id}),
    )
    .await;
    assert!(archived.get("result").is_some(), "{archived}");
    let url = format!("http://{addr}/areal/blobs/{blob}?threadId={fork_id}");
    let client = reqwest::Client::new();
    let owner_read = client
        .get(&url)
        .bearer_auth(owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(owner_read.status(), reqwest::StatusCode::OK);
    assert_eq!(
        owner_read.bytes().await.unwrap().len() as u64,
        media["media"]["sizeBytes"]
    );
    let scoped_read = client
        .get(&url)
        .bearer_auth(scoped_token)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_read.status(), reqwest::StatusCode::FORBIDDEN);
    let foreign = client
        .get(format!(
            "http://{addr}/areal/blobs/{blob}?threadId=unrelated"
        ))
        .bearer_auth(owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), reqwest::StatusCode::NOT_FOUND);
    stop.cancel();
    server.await.unwrap().unwrap();
}
