use areal_engine::{
    Engine, Error, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::desktop::TurnInterruptAdmissionGuard;
use async_trait::async_trait;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

struct FirstCompletes(AtomicUsize);
#[async_trait]
impl Model for FirstCompletes {
    fn name(&self) -> &str {
        "exact-interrupt"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(Box::pin(futures_util::stream::iter([Ok("done".into())])))
        } else {
            Ok(Box::pin(futures_util::stream::pending()))
        }
    }
}
fn guard() -> Option<TurnInterruptAdmissionGuard> {
    Some(TurnInterruptAdmissionGuard {
        ordinary_session: true,
    })
}
async fn start(engine: &Arc<Engine>, thread: &str, request: &str) -> String {
    engine
        .start_durable(
            "owner".into(),
            serde_json::from_value(json!({
                "requestId":request,"threadId":thread,"input":[{"type":"text","text":"hello"}]
            }))
            .unwrap(),
            false,
        )
        .await
        .unwrap()["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
#[tokio::test]
async fn guarded_terminal_turn_does_not_pause_future_queue() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        root.path(),
        Arc::new(FirstCompletes(AtomicUsize::new(0))),
        Limits::default(),
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let turn = start(&engine, &thread.id, "first").await;
    let completed = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.turns.last().unwrap().status,
        areal_protocol::TurnStatus::Completed
    );
    let before = engine.queue(&thread.id).await.unwrap();
    assert!(!before.paused);
    let result = engine.interrupt_guarded(&thread.id, &turn, guard()).await;
    let after = engine.queue(&thread.id).await.unwrap();
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(before).unwrap(),
        "terminal stop mutated future queue"
    );
    assert!(matches!(result, Err(Error::Conflict)), "{result:?}");
    engine.shutdown().await;
}

#[tokio::test]
async fn stale_a_does_not_cancel_b_and_exact_ordinary_stop_settles_b() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        root.path(),
        Arc::new(FirstCompletes(AtomicUsize::new(0))),
        Limits::default(),
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let a = start(&engine, &thread.id, "a").await;
    tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    let b = start(&engine, &thread.id, "b").await;
    let before = serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap();
    assert!(matches!(
        engine.interrupt_guarded(&thread.id, &a, guard()).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        engine
            .interrupt_guarded(
                &thread.id,
                &b,
                Some(TurnInterruptAdmissionGuard {
                    ordinary_session: false
                })
            )
            .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(
        serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap(),
        before
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), engine.wait(&thread.id))
            .await
            .is_err()
    );
    engine
        .interrupt_guarded(&thread.id, &b, guard())
        .await
        .unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        settled.turns.last().unwrap().status,
        areal_protocol::TurnStatus::Interrupted
    );
    assert_eq!(settled.turns.last().unwrap().id, b);
    let queue = engine.queue(&thread.id).await.unwrap();
    assert!(queue.paused);
    assert_eq!(queue.pause_reason.as_deref(), Some("stopped"));
    engine.shutdown().await;
}

#[tokio::test]
async fn guarded_stop_rejects_active_coordinator_and_child_without_pausing_goal() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        root.path(),
        Arc::new(FirstCompletes(AtomicUsize::new(1))),
        Limits::default(),
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.goal_create("owner".into(), serde_json::from_value(json!({"requestId":"goal","threadId":thread.id,"expectedRevision":0,"objective":"held goal","maxTurns":2})).unwrap()).await.unwrap();
    let parent = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = engine.read(&thread.id, true).await.unwrap();
            if !state.turns.is_empty() {
                break state;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let turn = parent.turns.last().unwrap().id.clone();
    let (child, child_turn) = engine
        .spawn_child(
            &thread.id,
            vec![serde_json::from_value(json!({"type":"text","text":"child"})).unwrap()],
        )
        .await
        .unwrap();
    let before = &parent.goals;
    let queue = serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap();
    for (thread_id, turn_id) in [(&thread.id, &turn), (&child.id, &child_turn.id)] {
        assert!(matches!(
            engine.interrupt_guarded(thread_id, turn_id, guard()).await,
            Err(Error::Conflict)
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), engine.wait(thread_id))
                .await
                .is_err()
        );
    }
    let after = engine.read(&thread.id, true).await.unwrap().goals;
    assert_eq!(after.revision, before.revision);
    let goal = after.goal.unwrap();
    assert_eq!(goal.status, areal_protocol::goals::GoalStatus::Active);
    assert!(!goal.settling);
    assert_eq!(goal.reason, None);
    assert_eq!(goal.active_turn_id.as_deref(), Some(turn.as_str()));
    assert_eq!(
        serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap(),
        queue
    );
    engine.shutdown().await;
}

#[test]
fn interrupt_wire_contract_preserves_legacy_and_rejects_unknown_fields() {
    use areal_protocol::desktop::TurnInterrupt;
    let legacy = json!({"threadId":"thread","turnId":"original"});
    let parsed: TurnInterrupt = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
    let guarded =
        json!({"threadId":"thread","turnId":"original","admissionGuard":{"ordinarySession":true}});
    let parsed: TurnInterrupt = serde_json::from_value(guarded.clone()).unwrap();
    assert_eq!(parsed.turn_id, "original");
    assert_eq!(serde_json::to_value(parsed).unwrap(), guarded);
    for invalid in [
        json!({"threadId":"thread","turnId":"original","requestId":"new"}),
        json!({"threadId":"thread","turnId":"original","admissionGuard":{"ordinarySession":true,"configRevision":1}}),
        json!({"threadId":"thread","turnId":"original","admissionGuard":{}}),
    ] {
        assert!(serde_json::from_value::<TurnInterrupt>(invalid).is_err());
    }
}
