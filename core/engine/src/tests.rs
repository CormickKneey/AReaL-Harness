use super::*;

#[tokio::test]
async fn model_history_preserves_completion_batches_and_defers_tool_images() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    let media = engine
        .store
        .save_blob("image/png".into(), vec![1, 2])
        .await
        .unwrap();
    let call = |id: &str, image: bool| {
        let mut content = vec![json!({"type":"inputText","text":"confirmed"})];
        if image {
            content.push(json!({"type":"arealMedia","modality":"image","media":media}));
        }
        serde_json::from_value::<Item>(json!({
            "type":"dynamicToolCall", "id":id, "tool":"fixture", "callId":id,
            "arguments":{}, "status":"completed", "success":true,
            "contentItems":content,
            "execution":{"backend":"runtime", "runtimeEpoch":"runtime", "scopeId":"scope",
                "operationId":id, "outcome":"succeeded"}
        }))
        .unwrap()
    };
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: "turn".into(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: vec![
            Item::AgentMessage {
                phase: None,
                id: "completion-1".into(),
                text: "Inspect both".into(),
            },
            call("a", true),
            call("b", false),
            // An empty text item still marks a new model decision.
            Item::AgentMessage {
                phase: None,
                id: "completion-2".into(),
                text: String::new(),
            },
            call("c", false),
        ],
    });
    let messages = history(&thread, &engine.store).unwrap();
    assert_eq!(
        messages.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["assistant", "tool", "tool", "user", "assistant", "tool"]
    );
    assert_eq!(messages[0].text_content(), "Inspect both");
    assert_eq!(messages[0].tool_calls.len(), 2);
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("a"));
    assert_eq!(messages[2].tool_call_id.as_deref(), Some("b"));
    assert!(matches!(messages[3].content[1], ContentPart::Image { .. }));
    assert_eq!(messages[4].tool_calls[0]["id"], "c");
    engine.shutdown().await;
}

#[tokio::test]
async fn model_history_keeps_short_references_and_preserves_runtime_audit() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    let mut items = Vec::new();
    for (name, original, visible, resolved) in [
        (
            "read_process",
            json!({"processId":"p1111111111111111","after":"c1111111111111111"}),
            // A pre-tool hook may redirect a request to another authorized alias.
            json!({"processId":"p2222222222222222","after":"c2222222222222222"}),
            json!({"processId":"runtime:process:long-id","after":"runtime:process:long-id/42"}),
        ),
        (
            "fs_apply_patches",
            json!({"path":"code.py","fileVersion":"v1111111111111111","patches":[{"oldText":"old","newText":"new"}]}),
            json!({"path":"code.py","fileVersion":"v1111111111111111","patches":[{"oldText":"old","newText":"new"}]}),
            json!({"path":"workspace://repo/code.py","expectedSha256":"a".repeat(64),"patches":[{"oldText":"old","newText":"new"}]}),
        ),
    ] {
        items.push(
            serde_json::from_value::<Item>(json!({
                "type":"dynamicToolCall", "id":name, "tool":name, "callId":name,
                "arguments":original, "status":"completed", "success":true,
                "contentItems":[{"type":"inputText","text":"confirmed"}],
                "execution":{"backend":"runtime", "runtimeEpoch":"runtime", "scopeId":"scope",
                    "operationId":"operation", "outcome":"succeeded",
                    "modelArguments":visible, "effectiveArguments":resolved}
            }))
            .unwrap(),
        );
    }
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: "turn".into(),
        items,
        status: TurnStatus::Completed,
        error: None,
        usage: None,
    });
    let saved = serde_json::to_value(&thread).unwrap();
    assert_eq!(
        saved["turns"][0]["items"][0]["execution"]["effectiveArguments"]["processId"],
        "runtime:process:long-id"
    );
    let restored: Thread = serde_json::from_value(saved).unwrap();
    let messages = history(&restored, &engine.store).unwrap();
    let calls: Vec<_> = messages.iter().flat_map(|m| &m.tool_calls).collect();
    let process: Value =
        serde_json::from_str(calls[0]["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(
        process,
        json!({"processId":"p2222222222222222","after":"c2222222222222222"})
    );
    let patch: Value =
        serde_json::from_str(calls[1]["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(patch["fileVersion"], "v1111111111111111");
    assert!(patch.get("expectedSha256").is_none());
    engine.shutdown().await;
}

#[tokio::test]
async fn browser_history_keeps_plan_private_and_preserves_rejected_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    let original = json!({"operation":"observe","parameters":{"pageId":"old"}});
    let canonical = json!({"operation":"observe","parameters":{"pageId":"hook-current"}});
    let audit = json!({"arguments":canonical,"plan":{"preparedActionId":"private-plan","fingerprint":"private-digest"}});
    let rejected = json!({"arguments":canonical,"plan":{"preparedActionId":"model-forged"}});
    let mut items = Vec::new();
    let mut expected = Vec::new();
    for (id, tool, backend, input, model, effective, want) in [
        (
            "new",
            "browser_v1",
            "client",
            original.clone(),
            Some(canonical.clone()),
            Some(audit.clone()),
            canonical.clone(),
        ),
        (
            "legacy",
            "browser_v1",
            "client",
            original.clone(),
            None,
            Some(audit.clone()),
            canonical.clone(),
        ),
        (
            "rejected",
            "browser_v1",
            "client",
            rejected.clone(),
            None,
            None,
            rejected.clone(),
        ),
        (
            "other",
            "fixture",
            "client",
            original.clone(),
            None,
            Some(audit.clone()),
            audit.clone(),
        ),
        (
            "runtime",
            "browser_v1",
            "runtime",
            original.clone(),
            None,
            Some(audit.clone()),
            audit.clone(),
        ),
    ] {
        items.push(serde_json::from_value::<Item>(json!({
            "type":"dynamicToolCall","id":id,"tool":tool,"callId":id,"arguments":input,
            "status":"completed","success":id!="rejected","contentItems":[{"type":"inputText","text":"receipt"}],
            "execution":{"backend":backend,"runtimeEpoch":"runtime","scopeId":"scope","operationId":id,
                "outcome":if id=="rejected" {"failed"} else {"succeeded"},
                "modelArguments":model,"effectiveArguments":effective}
        })).unwrap());
        expected.push(want);
    }
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: "turn".into(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items,
    });
    let saved = serde_json::to_value(&thread).unwrap();
    let restored: Thread = serde_json::from_value(saved.clone()).unwrap();
    let messages = history(&restored, &engine.store).unwrap();
    let calls: Vec<_> = messages
        .iter()
        .flat_map(|message| &message.tool_calls)
        .collect();
    for (call, wanted) in calls.iter().zip(expected) {
        let actual: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(actual, wanted);
    }
    assert_eq!(
        serde_json::to_value(&restored).unwrap(),
        saved,
        "投影不改写审计原文"
    );
    assert_eq!(
        saved["turns"][0]["items"][1]["execution"]["effectiveArguments"],
        audit
    );
    engine.shutdown().await;
}

#[test]
fn long_task_input_is_accepted_and_utf8_limit_covers_all_parts() {
    let caps = model::ModelCapabilities::text();
    assert!(validate_input(&[Input::text("x".repeat(134479))], &caps).is_ok());
    assert!(validate_input(&[Input::text("x".repeat(1024 * 1024))], &caps).is_ok());
    assert!(matches!(
        validate_input(
            &[Input::text("x".repeat(1024 * 1024)), Input::text("字")],
            &caps
        ),
        Err(Error::Exhausted(_))
    ));
}

struct PendingModel;
#[async_trait::async_trait]
impl Model for PendingModel {
    fn name(&self) -> &str {
        "pending"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
}

#[tokio::test]
async fn dropping_a_create_waiter_does_not_abandon_the_reserved_session() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let pause = engine.store.pause_writes().await;
    let owned = engine.clone();
    let request = tokio::spawn(async move { owned.create("/fixture".into()).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while engine.threads.read().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    request.abort();
    let _ = request.await;
    drop(pause);
    engine.shutdown().await;
    let before = engine.list(None, 100, None).await.unwrap().0;
    drop(engine);
    let restored = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let after = restored.list(None, 100, None).await.unwrap().0;
    assert_eq!(before.len(), 1);
    assert_eq!(
        after.len(),
        1,
        "cancelled caller left an in-memory-only session"
    );
    assert_eq!(before[0].id, after[0].id);
    restored.shutdown().await;
}

#[tokio::test]
async fn dropping_a_steer_waiter_keeps_durable_input_and_memory_consistent() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let thread = engine.create("/fixture".into()).await.unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("initial")])
        .await
        .unwrap();
    let pause = engine.store.pause_writes().await;
    let owned = engine.clone();
    let thread_id = thread.id.clone();
    let turn_id = turn.id.clone();
    let cell = engine.cell(&thread.id).await.unwrap();
    let request = tokio::spawn(async move {
        owned
            .steer(&thread_id, &turn_id, vec![Input::text("accepted steer")])
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while cell.state.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    request.abort();
    let _ = request.await;
    drop(pause);
    engine.shutdown().await;
    let before = engine.read(&thread.id, true).await.unwrap();
    drop(engine);
    let restored = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let after = restored.read(&thread.id, true).await.unwrap();
    for saved in [before, after] {
        assert!(saved.turns[0].items.iter().any(|item| matches!(item, Item::UserMessage { content, .. } if content[0].as_text() == "accepted steer")));
        assert_ne!(saved.turns[0].status, TurnStatus::InProgress);
    }
    restored.shutdown().await;
}

#[tokio::test]
async fn compacted_history_preserves_steer_inside_an_automatic_goal_turn() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: Some(areal_protocol::goals::GoalTurn {
            goal_id: id(),
            sequence: 2,
            origin: "continuation".into(),
            predecessor_turn_id: None,
        }),
        configuration: None,
        instruction_snapshot: None,
        id: id(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: vec![
            Item::UserMessage {
                id: "automatic".into(),
                content: vec![Input::text("Automatic continuation adds no authorization")],
            },
            Item::UserMessage {
                id: "repair".into(),
                content: vec![
                    Input::text("修订：只修组合键；取消旧音乐任务。"),
                    Input::text("保留已验收光学中心。"),
                ],
            },
            Item::AgentMessage {
                id: "boundary".into(),
                phase: None,
                text: "verified".into(),
            },
        ],
    });
    thread.context_checkpoint = Some(areal_protocol::ContextCheckpoint {
        retained_inputs: None,
        evidence: Vec::new(),
        through_item_id: "boundary".into(),
        summary: "Old music task is pending".into(),
        usage: Default::default(),
        total_duration_ms: 0,
        compactions: 2,
    });
    let projected = history(&thread, &engine.store).unwrap();
    let users: Vec<_> = projected.iter().filter(|m| m.role == "user").collect();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].content.len(), 2);
    assert!(users[0].text_content().contains("取消旧音乐任务"));
    engine.persist(&thread).await.unwrap();
    let raw = std::fs::read(dir.path().join(format!("{}.json", thread.id))).unwrap();
    let restored: store::Record = serde_json::from_slice(&raw).unwrap();
    assert_eq!(
        serde_json::to_vec(&restored.thread).unwrap(),
        serde_json::to_vec(&thread).unwrap()
    );
    assert_eq!(
        history(&restored.thread, &engine.store)
            .unwrap()
            .iter()
            .map(Message::text_content)
            .collect::<Vec<_>>(),
        projected
            .iter()
            .map(Message::text_content)
            .collect::<Vec<_>>()
    );
    engine.shutdown().await;
}

#[tokio::test]
#[ignore = "local disk benchmark; not a timing assertion"]
async fn persistence_encoding_benchmark() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: id(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: (0..4000)
            .map(|n| Item::AgentMessage {
                id: n.to_string(),
                phase: None,
                text: "Observed tool JSON: {\"file\":\"src/main.rs\",\"result\":\"verified\"}\n"
                    .repeat(32),
            })
            .collect(),
    });
    let mut old_ms = Vec::new();
    let mut new_ms = Vec::new();
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let _size = serde_json::to_vec(&thread).unwrap().len();
        let clone = thread.clone();
        let mut file = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        serde_json::to_writer(
            &mut file,
            &store::Record {
                version: store::STATE_VERSION,
                thread: clone.clone(),
            },
        )
        .unwrap();
        file.flush().unwrap();
        file.as_file().sync_all().unwrap();
        old_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = std::time::Instant::now();
        let bytes = store::encode(&thread).unwrap();
        let mut optimized = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        optimized.write_all(&bytes).unwrap();
        optimized.flush().unwrap();
        optimized.as_file().sync_all().unwrap();
        new_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(
            std::fs::read(file.path()).unwrap(),
            std::fs::read(optimized.path()).unwrap()
        );
    }
    println!(
        "{}",
        json!({"bytes":store::encode(&thread).unwrap().len(),"oldMs":old_ms,"newMs":new_ms,"scope":"encoding, clone and file write/fsync; excludes queue and directory rename/sync"})
    );
    engine.shutdown().await;
}
