use areal_engine::{
    Engine, Error, Limits,
    model::{Message, Model, ModelStream},
};
use async_trait::async_trait;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct IdleModel;
#[async_trait]
impl Model for IdleModel {
    fn name(&self) -> &str {
        "recovery-contract"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::empty()))
    }
}

#[tokio::test]
async fn completion_receipt_failure_preserves_admission_and_never_repeats_effect() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(IdleModel), Limits::default()).unwrap();
    let effects = Arc::new(AtomicUsize::new(0));
    let context_thread = engine.create("/fixture".into()).await.unwrap();
    let rejected = engine
        .management_submission(
            "owner".into(),
            "invalid/id".into(),
            "areal/provider/upsert".into(),
            json!({}),
            {
                let effects = effects.clone();
                move |_| async move {
                    effects.fetch_add(1, Ordering::SeqCst);
                    json!({"result":true})
                }
            },
        )
        .await
        .unwrap_err();
    assert!(format!("{rejected:?}").starts_with("Rejected"));
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    let journal = data.path().join("desktop/submissions.json");
    let preserved = data.path().join("accepted.json");
    let operation = || {
        (
            "owner".into(),
            "original-id".into(),
            "areal/provider/upsert".into(),
            json!({"provider":{"id":"fixture"}}),
        )
    };
    let (owner, request, method, params) = operation();
    let error = engine
        .management_submission(owner, request, method, params, {
            let effects = effects.clone();
            let journal = journal.clone();
            let preserved = preserved.clone();
            move |_| async move {
                effects.fetch_add(1, Ordering::SeqCst);
                std::fs::rename(&journal, &preserved).unwrap();
                std::fs::create_dir(&journal).unwrap();
                json!({"result":{"saved":true}})
            }
        })
        .await
        .unwrap_err();
    assert!(
        !matches!(error, Error::Invalid(_)),
        "post-effect failure must preserve admitted outcome: {error:?}"
    );
    let Error::OperationOutcome(failure) = &error else {
        panic!("expected operation outcome: {error:?}")
    };
    assert_eq!(json!(failure)["outcome"]["kind"], "admitted");
    assert_eq!(
        json!(failure)["outcome"]["operation"]["requestId"],
        "original-id"
    );
    let (owner, request, method, params) = operation();
    let repeated = engine
        .management_submission(owner, request, method, params, {
            let effects = effects.clone();
            move |_| async move {
                effects.fetch_add(1, Ordering::SeqCst);
                json!({"result":true})
            }
        })
        .await;
    assert!(repeated.is_err());
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    std::fs::remove_dir(&journal).unwrap();
    std::fs::rename(&preserved, &journal).unwrap();
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(data.path(), Arc::new(IdleModel), Limits::default()).unwrap();
    let records = reopened.find_request("owner", "original-id").await.unwrap();
    assert_eq!(records["data"][0]["status"], "admitted");
    assert_eq!(records["data"][0]["operation"]["requestId"], "original-id");
    let legacy = reopened
        .request_status("owner", &context_thread.id, "original-id")
        .await
        .unwrap();
    assert_eq!(
        legacy["data"][0]["operation"]["requestId"], "original-id",
        "legacy thread-scoped lookup retains project management receipts"
    );
    let archived = reopened
        .archive_thread(context_thread.id.clone())
        .await
        .unwrap();
    assert_eq!(archived["archived"], true);
    let archived_receipts = reopened
        .request_status("owner", &context_thread.id, "original-id")
        .await
        .unwrap();
    assert_eq!(archived_receipts["data"], legacy["data"]);
    let (owner, request, method, params) = operation();
    assert!(
        reopened
            .management_submission(owner, request, method, params, {
                let effects = effects.clone();
                move |_| async move {
                    effects.fetch_add(1, Ordering::SeqCst);
                    json!({"result":true})
                }
            })
            .await
            .is_err()
    );
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    reopened.shutdown().await;
}

#[tokio::test]
async fn configure_receipt_is_atomic_and_precedes_revision_check_after_reopen() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(IdleModel), Limits::default()).unwrap();
    let thread = engine.create("/fixture".into()).await.unwrap();
    let request = json!({"threadId":thread.id,"requestId":"configure-id","expectedRevision":1,"options":{"appendInstructions":"configured"}});
    let original = engine
        .configure_thread(serde_json::from_value(request.clone()).unwrap())
        .await
        .unwrap();
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(data.path(), Arc::new(IdleModel), Limits::default()).unwrap();
    let repeated = reopened
        .configure_thread(serde_json::from_value(request.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(json!(repeated), json!(original));
    assert_eq!(original.revision, 2);
    let records = reopened.find_request("", "configure-id").await.unwrap();
    assert_eq!(records["data"][0]["status"], "completed");
    assert_eq!(records["data"][0]["result"], json!(original));
    let mut changed = request;
    changed["options"]["appendInstructions"] = json!("changed");
    assert!(matches!(
        reopened
            .configure_thread(serde_json::from_value(changed).unwrap())
            .await,
        Err(Error::Conflict)
    ));
    reopened.shutdown().await;
}

#[tokio::test]
async fn task_receipts_preserve_original_request_and_owner_after_reopen() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(IdleModel), Limits::default()).unwrap();
    let thread = engine.create("/fixture".into()).await.unwrap();
    let request = json!({"requestId":"task-original","mode":"foreground","threadId":thread.id,"objective":"fixture","tokenBudget":100,"maxTurns":1,"maxActiveSeconds":60});
    let task = engine
        .task_create(
            "owner".into(),
            serde_json::from_value(request.clone()).unwrap(),
        )
        .await
        .unwrap();
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(data.path(), Arc::new(IdleModel), Limits::default()).unwrap();
    let records = reopened
        .find_request("owner", "task-original")
        .await
        .unwrap();
    assert_eq!(
        records["data"][0]["operation"]["method"],
        "areal/task/create"
    );
    assert_eq!(
        records["data"][0]["operation"]["target"]["taskId"],
        task["id"]
    );
    assert_eq!(records["data"][0]["result"]["id"], task["id"]);
    assert_eq!(
        reopened
            .find_request("other", "task-original")
            .await
            .unwrap()["data"],
        json!([])
    );
    let replay = reopened
        .task_create("owner".into(), serde_json::from_value(request).unwrap())
        .await
        .unwrap();
    assert_eq!(replay["id"], task["id"]);
    assert_eq!(reopened.task_list().await.len(), 1);
    reopened.shutdown().await;
}
