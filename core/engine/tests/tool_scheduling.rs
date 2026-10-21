use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::{HookDefinition, HookEvent, RuntimeConfig, ToolExtensions, ToolPolicy},
};
use areal_protocol::{Input, Item, ToolOutcome, TurnStatus};
use areal_runtime_client::Client;
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, Notify, mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

struct BatchModel {
    calls: Vec<ToolCall>,
    requests: AtomicUsize,
}

#[async_trait]
impl Model for BatchModel {
    fn name(&self) -> &str {
        "tool-scheduling-fixture"
    }

    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }

    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        if self.requests.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(Box::pin(futures_util::stream::iter(
                self.calls
                    .clone()
                    .into_iter()
                    .map(ModelEvent::ToolCall)
                    .map(Ok),
            )));
        }
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        assert_eq!(results.len(), self.calls.len());
        let advertised: Vec<_> = messages.iter().flat_map(|m| &m.tool_calls).collect();
        assert_eq!(advertised.len(), self.calls.len());
        for ((call, advertised), result) in self.calls.iter().zip(advertised).zip(results) {
            assert_eq!(advertised["id"], call.id);
            assert_eq!(result.tool_call_id.as_deref(), Some(call.id.as_str()));
            let value: Value = serde_json::from_str(&result.text_content())?;
            let arguments: Value = serde_json::from_str(&call.arguments)?;
            assert_eq!(value["path"], arguments["path"]);
            if call.name == "fs_read" {
                assert_eq!(value["text"], arguments["path"]);
                assert!(value["fileVersion"].as_str().unwrap().starts_with('v'));
            }
        }
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("all results observed"),
        )])))
    }
}

struct Pending {
    request: Value,
    release: oneshot::Sender<Value>,
}

impl Pending {
    fn path(&self) -> &str {
        self.request["params"]["command"]["path"].as_str().unwrap()
    }

    fn succeed(self) {
        let path = self.path().to_owned();
        let mut result = json!({"path":path,"sha256":"a".repeat(64),"size":3});
        if self.request["params"]["command"]["kind"] == "read" {
            result["dataBase64"] = json!(STANDARD.encode(path));
        }
        self.release.send(json!({"result":result})).unwrap();
    }

    fn unknown(self) {
        self.release
            .send(json!({"error":{"code":"UNAVAILABLE","message":"fixture unknown result"}}))
            .unwrap();
    }
}

struct Runtime {
    client: Arc<Client>,
    seen: mpsc::UnboundedReceiver<Pending>,
    scopes: Arc<AtomicUsize>,
    closed: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("tool scheduling fixture stalled")
}

impl Runtime {
    async fn next(&mut self) -> Pending {
        bounded(self.seen.recv()).await.unwrap()
    }

    async fn pair(&mut self, left: &str, right: &str) -> (Pending, Pending) {
        let first = self.next().await;
        let second = self.next().await;
        let pair = if first.path().ends_with(left) {
            (first, second)
        } else {
            (second, first)
        };
        assert!(pair.0.path().ends_with(left) && pair.1.path().ends_with(right));
        pair
    }

    async fn assert_no_dispatch(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(60), self.seen.recv())
                .await
                .is_err(),
            "a tool crossed an unsettled serial barrier"
        );
    }
}

async fn runtime(data: &Path) -> Runtime {
    let (client_pipe, peer) = tokio::io::duplex(256 * 1024);
    let (read, write) = tokio::io::split(client_pipe);
    let (peer_read, peer_write) = tokio::io::split(peer);
    let writer = Arc::new(Mutex::new(peer_write));
    let (seen, received) = mpsc::unbounded_channel();
    let scopes = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(AtomicUsize::new(0));
    let created = scopes.clone();
    let cleaned = closed.clone();
    let data = data.to_owned();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        let pending = Arc::new(AtomicUsize::new(0));
        let changed = Arc::new(Notify::new());
        let revoked = CancellationToken::new();
        let epoch = uuid::Uuid::new_v4().to_string();
        let root = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        let scope = json!({"scopeId":root,"parentScopeId":null,"state":"active","owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":30000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null});
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap();
            if method == "fs.execute" {
                // 每个并发请求都必须已经有独立的持久化意图，不能只核对最后一项。
                let journaled = std::fs::read_dir(&data).unwrap().any(|entry| {
                    let path = entry.unwrap().path();
                    if path.extension().is_none_or(|extension| extension != "json") {
                        return false;
                    }
                    let record: Value =
                        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                    record["thread"]["turns"][0]["items"]
                        .as_array()
                        .is_some_and(|items| {
                            items.iter().any(|item| {
                                item["execution"]["operationId"] == request["params"]["operationId"]
                                    && item["execution"]["outcome"] == "running"
                            })
                        })
                });
                assert!(journaled, "Runtime submission preceded its durable intent");
                let (release, ready) = oneshot::channel();
                pending.fetch_add(1, Ordering::SeqCst);
                seen.send(Pending {
                    request: request.clone(),
                    release,
                })
                .unwrap();
                let writer = writer.clone();
                let pending = pending.clone();
                let changed = changed.clone();
                let revoked = revoked.clone();
                tokio::spawn(async move {
                    let mut response = tokio::select! {
                        result = ready => result.unwrap_or_else(|_|json!({"error":{"code":"UNAVAILABLE","message":"fixture gate dropped"}})),
                        _ = revoked.cancelled() => json!({"error":{"code":"UNAVAILABLE","message":"fixture scope revoked"}}),
                    };
                    response["id"] = request["id"].clone();
                    writer
                        .lock()
                        .await
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                    pending.fetch_sub(1, Ordering::SeqCst);
                    changed.notify_one();
                });
                continue;
            }
            let result = match method {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,"connectionId":"fixture","rootScopeId":root,"capabilities":{"methods":["scope.check","fs.execute"]}})
                }
                "scope.check" => json!({"available":true}),
                "scope.create" => {
                    created.fetch_add(1, Ordering::SeqCst);
                    scope.clone()
                }
                "scope.revoke" => {
                    revoked.cancel();
                    scope.clone()
                }
                "scope.waitClosed" => {
                    while pending.load(Ordering::SeqCst) != 0 {
                        changed.notified().await;
                    }
                    cleaned.fetch_add(1, Ordering::SeqCst);
                    let mut result = scope.clone();
                    result["state"] = json!("closed");
                    result
                }
                "connection.close" => json!({"closed":true}),
                _ => panic!("unexpected Runtime method {method}"),
            };
            writer
                .lock()
                .await
                .write_all(format!("{}\n", json!({"id":request["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if method == "connection.close" {
                break;
            }
        }
    });
    Runtime {
        client: Client::connect(read, write).await.unwrap(),
        seen: received,
        scopes,
        closed,
        task,
    }
}

fn call(name: &str, path: &str) -> ToolCall {
    let arguments = if name == "fs_create" {
        json!({"path":format!("workspace://repo/{path}"),"text":"new"})
    } else {
        json!({"path":format!("workspace://repo/{path}")})
    };
    ToolCall {
        id: path.into(),
        name: name.into(),
        arguments: arguments.to_string(),
    }
}

async fn open(
    dir: &Path,
    calls: Vec<ToolCall>,
    limits: Limits,
    extensions: ToolExtensions,
) -> (Arc<Engine>, Arc<BatchModel>, Runtime, String, String) {
    let data = dir.join("data");
    let workspace = dir.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let runtime = runtime(&data).await;
    let model = Arc::new(BatchModel {
        calls,
        requests: AtomicUsize::new(0),
    });
    let engine = Engine::open_with_extensions(
        &data,
        model.clone(),
        limits,
        Some(RuntimeConfig {
            client: runtime.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scope: None,
            command_scratch: None,
        }),
        extensions,
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("inspect files")])
        .await
        .unwrap();
    (engine, model, runtime, thread.id, turn.id)
}

fn parallel() -> ToolExtensions {
    ToolExtensions {
        policy: ToolPolicy {
            parallel_read_calls: 2,
            ..Default::default()
        },
        ..Default::default()
    }
}

async fn close(engine: Arc<Engine>, runtime: Runtime) {
    engine.shutdown().await;
    runtime.client.shutdown().await.unwrap();
    bounded(runtime.task).await.unwrap();
}

#[tokio::test]
async fn reads_overlap_without_reordering_history_or_crossing_write_barriers() {
    let dir = tempfile::tempdir().unwrap();
    let calls = vec![
        call("fs_read", "a"),
        call("fs_read", "b"),
        call("fs_create", "c"),
        call("fs_stat", "d"),
        call("fs_stat", "e"),
    ];
    let (engine, model, mut runtime, thread, _) =
        open(dir.path(), calls, Limits::default(), parallel()).await;
    let (a, b) = runtime.pair("/a", "/b").await;
    b.succeed();
    runtime.assert_no_dispatch().await;
    a.succeed();
    let write = runtime.next().await;
    assert!(write.path().ends_with("/c"));
    runtime.assert_no_dispatch().await;
    write.succeed();
    let (d, e) = runtime.pair("/d", "/e").await;
    e.succeed();
    d.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    assert_eq!(runtime.scopes.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.closed.load(Ordering::SeqCst), 1);
    let ids: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall {
                call_id, execution, ..
            } => {
                assert_eq!(execution.outcome, ToolOutcome::Succeeded);
                Some(call_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["a", "b", "c", "d", "e"]);
    close(engine, runtime).await;
}

#[tokio::test]
async fn defaults_finite_output_repeated_failure_limits_and_hooks_keep_serial_execution() {
    for case in 0..4 {
        let dir = tempfile::tempdir().unwrap();
        let mut extensions = parallel();
        let mut limits = Limits::default();
        match case {
            0 => extensions = ToolExtensions::default(),
            1 => limits.max_output_bytes = 1_000_000,
            2 => limits.max_repeated_tool_failures = 2,
            _ => extensions.hooks.push(HookDefinition {
                name: "unmatched".into(),
                event: HookEvent::PreToolUse,
                matcher: "unused".into(),
                argv: vec!["/bin/true".into()],
                timeout_ms: 1000,
            }),
        }
        let (engine, _, mut runtime, thread, _) = open(
            dir.path(),
            vec![call("fs_stat", "a"), call("fs_stat", "b")],
            limits,
            extensions,
        )
        .await;
        let first = runtime.next().await;
        runtime.assert_no_dispatch().await;
        first.succeed();
        runtime.next().await.succeed();
        assert_eq!(
            bounded(engine.wait(&thread)).await.unwrap().turns[0].status,
            TurnStatus::Completed
        );
        close(engine, runtime).await;
    }
}

#[tokio::test]
async fn unknown_waits_for_other_inflight_reads_and_never_dispatches_the_following_write() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, model, mut runtime, thread, _) = open(
        dir.path(),
        vec![
            call("fs_stat", "a"),
            call("fs_stat", "b"),
            call("fs_create", "c"),
        ],
        Limits::default(),
        parallel(),
    )
    .await;
    let (first, second) = runtime.pair("/a", "/b").await;
    second.unknown();
    runtime.assert_no_dispatch().await;
    first.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    let outcomes: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall { execution, .. } => Some(execution.outcome.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes, [ToolOutcome::Succeeded, ToolOutcome::Unknown]);
    assert_eq!(model.requests.load(Ordering::SeqCst), 1);
    assert!(runtime.seen.try_recv().is_err());
    close(engine, runtime).await;
}

#[tokio::test]
async fn cancellation_settles_all_parallel_reads_before_scope_cleanup_without_replay() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, model, mut runtime, thread, turn) = open(
        dir.path(),
        vec![
            call("fs_stat", "a"),
            call("fs_stat", "b"),
            call("fs_stat", "c"),
        ],
        Limits::default(),
        parallel(),
    )
    .await;
    let _first = runtime.next().await;
    let _second = runtime.next().await;
    engine.interrupt(&thread, &turn).await.unwrap();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    let outcomes: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall { execution, .. } => Some(execution.outcome.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes, [ToolOutcome::Unknown, ToolOutcome::Unknown]);
    assert_eq!(runtime.closed.load(Ordering::SeqCst), 1);
    assert_eq!(model.requests.load(Ordering::SeqCst), 1);
    assert!(runtime.seen.try_recv().is_err());
    close(engine, runtime).await;
}
