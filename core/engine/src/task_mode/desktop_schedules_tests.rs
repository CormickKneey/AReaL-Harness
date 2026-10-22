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

#[tokio::test]
async fn settled_schedule_history_does_not_stop_the_129th_trigger() {
    use model::{Message, ModelEvent, ModelStream, RequestPurpose, ToolCall};
    use std::sync::atomic::AtomicUsize;
    struct Complete(AtomicUsize);
    #[async_trait::async_trait]
    impl Model for Complete {
        fn name(&self) -> &str {
            "recurring-ledger-fixture"
        }
        async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
            self.chat_limited(m, vec![], RequestPurpose::Solve, None)
                .await
        }
        async fn chat_limited(
            &self,
            m: Vec<Message>,
            _: Vec<Value>,
            _: RequestPurpose,
            _: Option<u64>,
        ) -> anyhow::Result<ModelStream> {
            let n = self.0.fetch_add(1, Ordering::SeqCst);
            let goal: Value = m
                .iter()
                .rev()
                .find_map(|m| {
                    m.text_content()
                        .split("Current authoritative goal: ")
                        .nth(1)
                        .and_then(|s| serde_json::from_str(s).ok())
                })
                .unwrap();
            let event = if n.is_multiple_of(2) {
                ModelEvent::ToolCall(ToolCall {id:format!("report-{n}"),name:"goal_update".into(),arguments:json!({"expectedRevision":goal["revision"],"status":"complete","summary":"verified","evidence":["fixture"],"remaining":[]}).to_string()})
            } else {
                ModelEvent::TextDelta("done".into())
            };
            Ok(Box::pin(futures_util::stream::iter(vec![
                Ok(event),
                Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                    input_tokens: 10,
                    cached_input_tokens: 0,
                    output_tokens: 5,
                })),
            ])))
        }
    }
    let run_count = std::env::var("AREAL_TASK_LEDGER_RUNS")
        .ok()
        .map(|n| n.parse::<usize>().unwrap())
        .unwrap_or(130);
    assert!((130..=2000).contains(&run_count));
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(Complete(AtomicUsize::new(0))),
        Limits {
            max_threads: run_count + 8,
            ..Limits::default()
        },
    )
    .unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let value=engine.task_create("fixture".into(),serde_json::from_value(json!({"requestId":"long-schedule","mode":"scheduled","objective":"inspect","threadId":anchor.id,"schedule":{"at":now()+3600,"intervalSeconds":1},"tokenBudget":100000})).unwrap()).await.unwrap();
    let task_id = value["id"].as_str().unwrap();
    engine
        .register_schedule_host(Arc::new(Host {
            closed: AtomicBool::new(false),
        }))
        .await
        .unwrap();
    let mut first = None;
    for n in 0..run_count {
        engine
            .edit_task(task_id, |task| task.next_run_at = Some(now() - 1))
            .await
            .unwrap();
        engine.advance_task(task_id).await.unwrap();
        let task = engine.task_read(task_id).await.unwrap();
        assert!(!task.paused, "trigger {n} must remain admitted");
        let run = task.runs.last().unwrap().clone();
        let thread_id = run.thread_id.as_ref().unwrap();
        if n == 0 {
            first = Some(run.clone());
        }
        let view = engine.goal_get(thread_id).await.unwrap();
        assert_eq!(view["goal"]["tokenBudget"], 100000 - n as u64 * 30);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let view = engine.goal_get(thread_id).await.unwrap();
                if view["goal"]["status"] == "completed" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        engine
            .edit_task(task_id, |task| task.next_run_at = Some(now() + 3600))
            .await
            .unwrap();
        engine.advance_task(task_id).await.unwrap();
    }
    let task = engine.task_read(task_id).await.unwrap();
    assert_eq!(task.run_count, run_count as u64);
    assert_eq!(task.archived_run_count, run_count as u64 - 128);
    assert_eq!(task.runs.len(), 128);
    let first = first.unwrap();
    let goal_id = first.goal_id.as_ref().unwrap();
    assert!(!engine.task_goal_can_resume(goal_id).await.unwrap());
    assert!(engine.validate_prompt_limit_owner(goal_id).await.is_err());
    assert!(engine.is_desktop_schedule_goal(goal_id).await.unwrap());
    let thread_id = first.thread_id.as_ref().unwrap();
    let view = engine.goal_get(thread_id).await.unwrap();
    assert!(matches!(
        engine
            .goal_control(
                "fixture".into(),
                "resume".into(),
                GoalControl {
                    request_id: "old-resume".into(),
                    thread_id: thread_id.clone(),
                    goal_id: goal_id.clone(),
                    expected_revision: view["revision"].as_u64().unwrap()
                },
                None
            )
            .await,
        Err(Error::Conflict)
    ));
    let mut allowed = std::collections::BTreeSet::from([anchor.id]);
    for run in &task.runs {
        allowed.extend(run.thread_id.clone());
    }
    assert!(!engine.task_visible(task_id, Some(&allowed)).await.unwrap());
    let mut cursor = None;
    let mut runs = std::collections::BTreeSet::new();
    loop {
        let page = engine
            .task_runs_list(TaskRunsList {
                task_id: task_id.into(),
                cursor,
                limit: Some(100),
            })
            .await
            .unwrap();
        assert_eq!(page.run_count, run_count as u64);
        for run in page.data {
            assert!(runs.insert(run.id));
        }
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }
    assert_eq!(runs.len(), run_count);
    assert_eq!(
        engine
            .task_run_read(TaskRunRead {
                task_id: task_id.into(),
                run_id: first.id.clone()
            })
            .await
            .unwrap()
            .usage
            .tokens_used,
        30
    );
    engine.shutdown().await;
}
