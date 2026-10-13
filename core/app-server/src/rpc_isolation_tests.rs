//! 用真实 WebSocket 和确定性屏障验证接收循环，不依赖磁盘速度猜延迟。
use super::*;
use futures_util::{SinkExt, StreamExt};
use std::sync::{LazyLock, RwLock};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message as Wire;

type Barrier = (String, Arc<Notify>, Arc<Notify>);
static BARRIER: LazyLock<RwLock<Option<Barrier>>> = LazyLock::new(|| RwLock::new(None));
pub(super) async fn pause(params: &mut Value) {
    let Some(token) = params
        .as_object_mut()
        .and_then(|p| p.remove("_testBarrier"))
    else {
        return;
    };
    let selected = BARRIER.read().unwrap().clone();
    if let Some((key, entered, release)) = selected
        && token == key
    {
        entered.notify_one();
        release.notified().await;
    }
}

#[tokio::test]
async fn slow_derivation_does_not_starve_same_connection_control() {
    let root = tempfile::tempdir().unwrap();
    let model =
        areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "fixture".into(), None)
            .unwrap();
    let engine = Engine::open(
        root.path(),
        Arc::new(model),
        areal_engine::Limits::default(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(listener, engine.clone(), stop.clone()));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
        .await
        .unwrap();
    socket.send(Wire::Text(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"barrier-fixture","version":"1"}}}).to_string().into())).await.unwrap();
    while let Some(Ok(frame)) = socket.next().await {
        if frame.is_text()
            && serde_json::from_str::<Value>(frame.to_text().unwrap()).unwrap()["id"] == 1
        {
            break;
        }
    }
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let source = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    for (index, method) in [
        "areal/thread/fork",
        "areal/side/start",
        "areal/conversation/history",
        "areal/side/context/read",
    ]
    .into_iter()
    .enumerate()
    {
        let token = format!("slow-{index}");
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        *BARRIER.write().unwrap() = Some((token.clone(), entered.clone(), release.clone()));
        let params = match method {
            "areal/thread/fork" => {
                json!({"_testBarrier":token,"requestId":"barrier-fork","sourceThreadId":source.id,"anchor":{"turnId":"missing-anchor","boundary":"before"},"workspaceMode":"sharedCurrent"})
            }
            "areal/side/start" => {
                json!({"_testBarrier":token,"requestId":"barrier-side","sourceThreadId":source.id,"workspaceAccess":"none","input":[{"type":"text","text":"fixture"}]})
            }
            _ => json!({"_testBarrier":token,"threadId":source.id,"view":"inherited"}),
        };
        socket
            .send(Wire::Text(
                json!({"id":10,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        socket.send(Wire::Text(json!({"id":20,"method":"turn/interrupt","params":{"threadId":source.id,"turnId":"not-running"}}).to_string().into())).await.unwrap();
        let control = tokio::time::timeout(std::time::Duration::from_millis(300), async {
            while let Some(Ok(frame)) = socket.next().await {
                if frame.is_text()
                    && serde_json::from_str::<Value>(frame.to_text().unwrap()).unwrap()["id"] == 20
                {
                    return true;
                }
            }
            false
        })
        .await;
        release.notify_one();
        // 先释放本测试的屏障，再断言；失败不遗留卡住的任务。
        assert!(
            control.unwrap_or(false),
            "{method} blocked same-connection interrupt behind slow dispatch"
        );
        while let Some(Ok(frame)) = socket.next().await {
            if frame.is_text()
                && serde_json::from_str::<Value>(frame.to_text().unwrap()).unwrap()["id"] == 10
            {
                break;
            }
        }
    }
    // 占满 12 个非控制名额；第 13 个必须拒绝，保留的控制名额仍可读取 MCP。
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    *BARRIER.write().unwrap() = Some(("saturation".into(), entered.clone(), release.clone()));
    for id in 100..112 {
        socket.send(Wire::Text(json!({"id":id,"method":"areal/conversation/history","params":{"_testBarrier":"saturation","threadId":source.id,"view":"inherited"}}).to_string().into())).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
    }
    socket.send(Wire::Text(json!({"id":200,"method":"areal/conversation/history","params":{"threadId":source.id,"view":"inherited"}}).to_string().into())).await.unwrap();
    socket
        .send(Wire::Text(
            json!({"id":201,"method":"areal/mcp/list","params":{}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let replies = tokio::time::timeout(std::time::Duration::from_millis(300), async {
        let mut replies = std::collections::BTreeMap::new();
        while replies.len() < 2 {
            let frame = socket.next().await.unwrap().unwrap();
            if frame.is_text() {
                let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                if let Some(id @ (200 | 201)) = value["id"].as_u64() {
                    replies.insert(id, value);
                }
            }
        }
        replies
    })
    .await;
    release.notify_waiters();
    let replies = replies.expect("reserved MCP control was starved by derivation saturation");
    assert!(replies[&200]["error"].is_object());
    assert!(replies[&201]["result"].is_object());
    *BARRIER.write().unwrap() = None;
    socket.close(None).await.unwrap();
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

struct CompletedModel;
#[async_trait::async_trait]
impl areal_engine::model::Model for CompletedModel {
    fn name(&self) -> &str {
        "fixture"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> anyhow::Result<areal_engine::model::ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            "fixture answer".into()
        )])))
    }
}
#[tokio::test]
async fn real_fork_commit_lock_does_not_stop_socket_control() {
    check_real_lock("fork").await;
}
#[tokio::test]
async fn real_thread_state_lock_does_not_stop_socket_control() {
    check_real_lock("state").await;
}
async fn check_real_lock(stage: &str) {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        root.path(),
        Arc::new(CompletedModel),
        areal_engine::Limits {
            max_threads: 2,
            ..Default::default()
        },
    )
    .unwrap();
    let source = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let anchor = engine
        .start(&source.id, vec![Input::text("owned fixture")])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), engine.wait(&source.id))
        .await
        .unwrap()
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(listener, engine.clone(), stop.clone()));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
        .await
        .unwrap();
    socket.send(Wire::Text(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"real-lock-fixture","version":"1"}}}).to_string().into())).await.unwrap();
    socket.next().await.unwrap().unwrap();
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    for stage in [stage] {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let holder = if stage == "fork" {
            engine.test_pause_fork_commit(entered.clone(), release.clone());
            socket.send(Wire::Text(json!({"id":10,"method":"areal/thread/fork","params":{"requestId":"real-lock","sourceThreadId":source.id,"anchor":{"turnId":anchor.id,"boundary":"before"},"workspaceMode":"sharedCurrent"}}).to_string().into())).await.unwrap();
            None
        } else {
            let owner = engine.clone();
            let id = source.id.clone();
            let entered = entered.clone();
            let release = release.clone();
            Some(tokio::spawn(async move {
                owner.test_hold_thread_state(&id, entered, release).await
            }))
        };
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        let pending_create = if stage == "fork" {
            // Fork 未发布时，普通创建不能越过同一容量准入；现有会话读取仍须成功。
            assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 1);
            let owner = engine.clone();
            let cwd = root.path().to_string_lossy().into_owned();
            Some(tokio::spawn(async move { owner.create(cwd).await }))
        } else {
            None
        };
        // history/interrupt 都带 threadId；后接无 threadId 的 MCP 控制必须被接收。
        socket.send(Wire::Text(json!({"id":20,"method":"areal/conversation/history","params":{"threadId":source.id,"view":"inherited"}}).to_string().into())).await.unwrap();
        socket.send(Wire::Text(json!({"id":21,"method":"turn/interrupt","params":{"threadId":source.id,"turnId":"not-running"}}).to_string().into())).await.unwrap();
        socket
            .send(Wire::Text(
                json!({"id":22,"method":"areal/mcp/list","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let observed = tokio::time::timeout(Duration::from_millis(300), async {
            let mut ids = std::collections::BTreeSet::new();
            while let Some(Ok(frame)) = socket.next().await {
                if frame.is_text() {
                    let value: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
                    if let Some(id) = value["id"].as_u64() {
                        ids.insert(id);
                    }
                    if ids.contains(&22) && (stage != "fork" || ids.contains(&21)) {
                        return true;
                    }
                }
            }
            false
        })
        .await;
        release.notify_one();
        if let Some(holder) = holder {
            holder.await.unwrap();
        }
        if let Some(pending) = pending_create {
            let result = tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(result, Err(Error::Exhausted(_))),
                "pending Fork must reserve the final thread slot"
            );
        }
        assert!(
            observed.unwrap_or(false),
            "{stage} Core lock blocked independent same-socket control"
        );
        if stage == "fork" {
            while let Some(Ok(frame)) = socket.next().await {
                if frame.is_text()
                    && serde_json::from_str::<Value>(frame.to_text().unwrap()).unwrap()["id"] == 10
                {
                    break;
                }
            }
        }
    }
    socket.close(None).await.unwrap();
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}
