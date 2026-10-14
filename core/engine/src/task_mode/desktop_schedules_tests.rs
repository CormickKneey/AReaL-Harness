//! 先固定桌面准入与忙碌跳过的可观察行为。
use super::*;
struct Pending;
#[async_trait::async_trait]
impl Model for Pending {
    fn name(&self) -> &str {
        "scheduled-fixture"
    }
    async fn stream(&self, _: Vec<model::Message>) -> anyhow::Result<model::ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
    async fn chat_limited(
        &self,
        m: Vec<model::Message>,
        _: Vec<Value>,
        _: model::RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<model::ModelStream> {
        self.stream(m).await
    }
}
struct Host {
    closed: AtomicBool,
}
#[async_trait::async_trait]
impl tools::DynamicToolHost for Host {
    fn id(&self) -> &str {
        "fixture-host"
    }
    fn identity(&self) -> &str {
        "fixture"
    }
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    async fn prepare_schedule(&self, _: Value, _: CancellationToken) -> anyhow::Result<Value> {
        Ok(json!({}))
    }
    async fn call(
        &self,
        _: Value,
        _: CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        anyhow::bail!("unexpected tool")
    }
}
#[tokio::test]
async fn desktop_schedule_requires_host_skips_busy_and_pauses_only_future_runs() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let value = engine.task_create("fixture".into(), serde_json::from_value(json!({"requestId":"schedule", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()-100,"intervalSeconds":10}})).unwrap()).await.unwrap();
    let id = value["id"].as_str().unwrap();
    engine.advance_task(id).await.unwrap();
    assert!(engine.task_read(id).await.unwrap().runs.is_empty());
    let host = Arc::new(Host {
        closed: AtomicBool::new(false),
    });
    engine.register_schedule_host(host.clone()).await.unwrap();
    engine.advance_task(id).await.unwrap();
    let task = engine.task_read(id).await.unwrap();
    assert_eq!(task.runs.len(), 1);
    let run = task.runs.last().unwrap();
    assert_ne!(run.thread_id.as_ref(), Some(&anchor.id));
    assert!(run.started_at.is_some());
    engine
        .edit_task(id, |t| t.next_run_at = Some(now() - 30))
        .await
        .unwrap();
    engine.advance_task(id).await.unwrap();
    let task = engine.task_read(id).await.unwrap();
    assert_eq!(task.runs.len(), 1);
    assert!(task.skipped_runs > 0);
    engine
        .task_control(
            "fixture".into(),
            "pause".into(),
            TaskControl {
                request_id: "pause".into(),
                task_id: id.into(),
                expected_revision: task.revision,
                expected_run_id: None,
            },
        )
        .await
        .unwrap();
    engine.advance_task(id).await.unwrap();
    let task = engine.task_read(id).await.unwrap();
    let view = engine
        .goal_get(task.runs[0].thread_id.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(view["goal"]["status"], "active");
    host.closed.store(true, Ordering::Release);
    engine.advance_task(id).await.unwrap();
    engine
        .wait(task.runs[0].thread_id.as_ref().unwrap())
        .await
        .unwrap();
    engine.advance_task(id).await.unwrap();
    assert!(
        !engine.task_read(id).await.unwrap().runs[0]
            .status
            .terminal()
    );
    engine.shutdown().await;
}
