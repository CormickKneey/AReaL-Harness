//! 边界：纯 MCP 包不靠 Skill 激活；发现不运行；显式摘要连接；App 同代隔离、单次日志调用与失效。
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream},
};
use areal_plugins::Store;
use async_trait::async_trait;
use serde_json::json;
use std::{fs, path::Path, sync::Arc};
struct ModelFixture;
#[async_trait]
impl Model for ModelFixture {
    fn name(&self) -> &str {
        "fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter(vec![Ok(
            ModelEvent::text("done"),
        )])))
    }
}
fn write(root: &Path, path: &str, value: &str) {
    let p = root.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, value).unwrap();
}
#[tokio::test]
async fn mcp_only_discovery_trust_and_revocation() {
    let t = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        t.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        t.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    write(t.path(),"pkg/.mcp.json",&json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"LITERAL":"private-literal"}}}}).to_string());
    let e = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    e.set_permissions(
        serde_json::from_value(json!({"mode":"ASK_PERMISSIONS","ask":["mcp__*"]})).unwrap(),
        None,
    )
    .unwrap();
    let s = Arc::new(Store::open(t.path().join("plugins"), t.path().into(), None).unwrap());
    e.install_plugin_store(s.clone()).unwrap();
    let d = s.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = s.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    let listed = e.plugin_mcp_list().await.unwrap();
    assert!(!listed.to_string().contains("private-literal"));
    assert_eq!(listed["data"][0]["state"], "disconnected");
    assert!(
        e.plugin_connection(d.id.clone(), "wrong".into(), true)
            .await
            .is_err()
    );
    e.plugin_connection(d.id.clone(), digest, true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    assert_eq!(apps["data"].as_array().unwrap().len(), 1);
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e.create(t.path().to_str().unwrap().into()).await.unwrap();
    assert!(
        e.mcp_app_open(
            "owner".into(),
            thread.id.clone(),
            server.clone(),
            generation + 1,
            "app".into(),
            None,
            "badgen".into(),
            None,
            None
        )
        .await
        .is_err()
    );
    write(t.path(), "input.txt", "private file content");
    let app = e
        .mcp_app_open(
            "owner".into(),
            thread.id.clone(),
            server.clone(),
            generation,
            "app".into(),
            None,
            "open".into(),
            Some(json!({"uri":"opaque://file","path":t.path().join("input.txt")})),
            None,
        )
        .await
        .unwrap();
    assert_eq!(app["resource"]["html"], "<p>Hello</p>");
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    let file_request = |method: &str, params: serde_json::Value| json!({"jsonrpc":"2.0","id":30,"method":"ui/host-file","params":{"request":{"jsonrpc":"2.0","id":31,"method":method,"params":params}}});
    let read = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request("resources/read", json!({"uri":"opaque://file"})),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        read["result"]["contents"][0]["text"],
        "private file content"
    );
    assert_eq!(
        read["result"]["contents"][0]["_meta"]["openai/resource"]["writable"],
        false
    );
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request(
                "openai/resources/write",
                json!({"uri":"opaque://file","text":"mutated"})
            ),
            None
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request("resources/read", json!({"uri":"opaque://other"})),
            None
        )
        .await
        .is_err()
    );
    fs::remove_file(t.path().join("input.txt")).unwrap();
    std::os::unix::fs::symlink(t.path().join("pkg/server.py"), t.path().join("input.txt")).unwrap();
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request("resources/read", json!({"uri":"opaque://file"})),
            None
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_app_request(
            "other".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            json!({"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://app"}}),
            None
        )
        .await
        .is_err()
    );
    e.mcp_app_request("owner".into(),thread.id.clone(),instance.clone(),generation,json!({"jsonrpc":"2.0","id":2,"method":"ui/update-model-context","params":{"content":[{"type":"text","text":"new context","_meta":{"secret":true}}]}}),None).await.unwrap();
    let request = json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"app","arguments":{}}});
    let job = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        let request = request.clone();
        tokio::spawn(async move {
            e.mcp_app_request(
                "owner".into(),
                thread,
                instance,
                generation,
                request,
                Some("tool-once".into()),
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    if job.is_finished() {
        panic!(
            "early App outcome: {:?}; state: {:?}",
            job.await.unwrap(),
            e.read(&thread.id, true).await.unwrap()
        );
    }
    approve(&e, &thread.id).await;
    let called = tokio::time::timeout(std::time::Duration::from_secs(5), job)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(called["result"]["_meta"]["secret"], "retained");
    let retry = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request,
            Some("tool-once".into()),
        )
        .await
        .unwrap();
    assert_eq!(called, retry);
    assert_eq!(e.read(&thread.id, true).await.unwrap().turns.len(), 1);
    let context = e.context_read(&thread.id, 0, 16).await.unwrap().to_string();
    assert!(!context.contains("retained"));
    let form_request = json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"app","arguments":{"form":"elicitation/create"}}});
    let job = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request(
                "owner".into(),
                thread,
                instance,
                generation,
                form_request,
                Some("form-once".into()),
            )
            .await
        })
    };
    approve(&e, &thread.id).await;
    let form = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let data = e.mcp_forms_list(thread.id.clone()).await.unwrap();
            if let Some(form) = data["data"].as_array().unwrap().first() {
                break form.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        e.mcp_form_respond(
            "other".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"accept","content":{"answer":"yes"}})
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"accept","content":{"answer":true}})
        )
        .await
        .is_err()
    );
    e.mcp_form_respond(
        "owner".into(),
        thread.id.clone(),
        form["requestId"].as_str().unwrap().into(),
        json!({"action":"accept","content":{"answer":"yes"}}),
    )
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), job)
            .await
            .unwrap()
            .unwrap()
            .is_ok()
    );
    let pending_call = {
        let e = e.clone();
        let thread_id = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request("owner".into(),thread_id,instance,generation,json!({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"app","arguments":{"form":"elicitation/create"}}}),Some("cancel-form".into())).await
        })
    };
    approve(&e, &thread.id).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if !e.mcp_forms_list(thread.id.clone()).await.unwrap()["data"]
                .as_array()
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let revision = s.list().unwrap().revision;
    s.configure(&d.id, "user", false, revision).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), pending_call)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(
        e.mcp_forms_list(thread.id.clone()).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        e.start(
            &thread.id,
            vec![areal_protocol::Input::text("do not replay")]
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            json!({"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://app"}}),
            None
        )
        .await
        .is_err()
    );
    e.shutdown().await;
    drop(e);
    s.configure(&d.id, "user", true, s.list().unwrap().revision)
        .unwrap();
    // Simulate the persisted generation number reused by a fresh Core process.
    let saved_path = state.path().join("desktop/mcp-apps.json");
    let mut saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&saved_path).unwrap()).unwrap();
    saved[&instance]["generation"] = json!(1);
    fs::write(&saved_path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "persisted_app_epoch_probe", "--nocapture"])
        .env("AREAL_EPOCH_TEST_STATE", state.path())
        .env("AREAL_EPOCH_TEST_WORKSPACE", t.path())
        .env("AREAL_EPOCH_TEST_THREAD", &thread.id)
        .env("AREAL_EPOCH_TEST_INSTANCE", &instance)
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "restart probe failed ({:?}): {} {}",
        child.status,
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
}

#[tokio::test]
async fn persisted_app_epoch_probe() {
    let Ok(state) = std::env::var("AREAL_EPOCH_TEST_STATE") else {
        return;
    };
    let workspace = std::path::PathBuf::from(std::env::var("AREAL_EPOCH_TEST_WORKSPACE").unwrap());
    let e = Engine::open(
        std::path::Path::new(&state),
        Arc::new(ModelFixture),
        Limits::default(),
    )
    .unwrap();
    let store = Arc::new(Store::open(workspace.join("plugins"), workspace, None).unwrap());
    e.install_plugin_store(store.clone()).unwrap();
    let detail = store.read("sample@local").unwrap();
    e.plugin_connection(detail.id, detail.installed_digest.unwrap(), true)
        .await
        .unwrap();
    assert_eq!(
        e.mcp_apps_list(None).await.unwrap()["data"][0]["generation"],
        1
    );
    let result = e
        .mcp_app_request(
            "owner".into(),
            std::env::var("AREAL_EPOCH_TEST_THREAD").unwrap(),
            std::env::var("AREAL_EPOCH_TEST_INSTANCE").unwrap(),
            1,
            json!({"jsonrpc":"2.0","id":100,"method":"resources/read","params":{"uri":"ui://app"}}),
            None,
        )
        .await;
    e.shutdown().await;
    assert!(
        result.is_err(),
        "persisted App capability revived after restart: {result:?}"
    );
}

async fn approve(e: &Arc<Engine>, thread: &str) {
    let pending = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let interactions = e.interactions(thread).await.unwrap();
            if let Some(item) = interactions["data"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["status"] == "pending")
            {
                break item.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|error| panic!("approval wait: {error}"));
    e.respond(serde_json::from_value(json!({"threadId":thread,"turnId":pending["turnId"],"requestId":pending["requestId"],"decision":"allowOnce","argumentsDigest":pending["argumentsDigest"]})).unwrap()).await.unwrap();
}
struct GatedModel {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    rounds: std::sync::atomic::AtomicUsize,
    schemas: std::sync::Mutex<Vec<Vec<serde_json::Value>>>,
}
#[async_trait]
impl Model for GatedModel {
    fn name(&self) -> &str {
        "gated"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        _: Vec<Message>,
        tools: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        self.schemas.lock().unwrap().push(tools.clone());
        let round = self
            .rounds
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let event = if round == 0 {
            self.entered.notify_one();
            self.release.notified().await;
            let name = tools
                .iter()
                .find_map(|t| {
                    t["function"]["name"]
                        .as_str()
                        .filter(|n| n.ends_with("__app"))
                })
                .unwrap();
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: "old-call".into(),
                name: name.into(),
                arguments: "{}".into(),
            })
        } else {
            ModelEvent::text("done")
        };
        Ok(Box::pin(futures_util::stream::iter(vec![Ok(event)])))
    }
}
#[tokio::test]
async fn active_schema_survives_update_and_busy_configure() {
    let t = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        t.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    let script =
        include_str!("../../mcp/tests/substrate.py").replace("[\"app\"]", "[\"app\",\"model\"]");
    write(t.path(), "pkg/server.py", &script);
    write(t.path(),"pkg/.mcp.json",&json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"LITERAL":"old-generation"}}}}).to_string());
    let model = Arc::new(GatedModel {
        entered: Default::default(),
        release: Default::default(),
        rounds: Default::default(),
        schemas: Default::default(),
    });
    let e = Engine::open(state.path(), model.clone(), Limits::default()).unwrap();
    let s = Arc::new(Store::open(t.path().join("plugins"), t.path().into(), None).unwrap());
    e.install_plugin_store(s.clone()).unwrap();
    let d = s.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = s.read(&d.id).unwrap();
    e.plugin_connection(d.id.clone(), d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let thread = e.create(t.path().to_str().unwrap().into()).await.unwrap();
    e.start(&thread.id, vec![areal_protocol::Input::text("run")])
        .await
        .unwrap();
    model.entered.notified().await;
    write(
        t.path(),
        "pkg/server.py",
        &script.replace("\"name\":\"app\"", "\"name\":\"replacement\""),
    );
    let next = s.read(&d.id).unwrap();
    e.plugin_install(
        next.id.clone(),
        "user".into(),
        next.revision,
        next.source,
        next.source_digest,
    )
    .await
    .unwrap();
    let next = s.read(&d.id).unwrap();
    e.plugin_connection(next.id, next.installed_digest.unwrap(), true)
        .await
        .unwrap();
    assert!(
        e.configure_thread(
            serde_json::from_value(
                json!({"threadId":thread.id,"expectedRevision":1,"parameters":{}})
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    model.release.notify_one();
    let completed = tokio::time::timeout(std::time::Duration::from_secs(5), e.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.turns.last().unwrap().status,
        areal_protocol::TurnStatus::Completed
    );
    assert!(
        serde_json::to_string(&completed)
            .unwrap()
            .contains("old-generation")
    );
    e.start(&thread.id, vec![areal_protocol::Input::text("next")])
        .await
        .unwrap();
    e.wait(&thread.id).await.unwrap();
    let schemas = model.schemas.lock().unwrap();
    assert_eq!(schemas[0], schemas[1]);
    assert_ne!(schemas[1], schemas[2]);
    drop(schemas);
    e.shutdown().await;
}

// Real MCP transport and descriptor IO; Runtime connection only supplies deployment capabilities.
async fn file_runtime() -> (
    Arc<areal_runtime_client::Client>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (local, peer) = tokio::io::duplex(65536);
    let (read, write) = tokio::io::split(local);
    let (peer_read, mut peer_write) = tokio::io::split(peer);
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let r: serde_json::Value = serde_json::from_str(&line).unwrap();
            let result = match r["method"].as_str().unwrap() {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":"fixture","connectionId":"fixture","rootScopeId":"fixture:scope:root","capabilities":{"methods":["fs.execute"]}})
                }
                "connection.close" => json!({"closed":true}),
                other => panic!("unexpected Runtime operation {other}"),
            };
            peer_write
                .write_all(format!("{}\n", json!({"id":r["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if r["method"] == "connection.close" {
                break;
            }
        }
    });
    (
        areal_runtime_client::Client::connect(read, write)
            .await
            .unwrap(),
        task,
    )
}

#[tokio::test]
async fn app_file_receipt_and_close_context_race() {
    let workspace = tempfile::tempdir().unwrap();
    let workspace_root = workspace.path().canonicalize().unwrap();
    let data = tempfile::tempdir().unwrap();
    let block = workspace_root.as_path().join("block");
    let entered = workspace_root.as_path().join("entered");
    write(
        workspace_root.as_path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace_root.as_path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    let script=include_str!("../../mcp/tests/substrate.py").replace("import sys,json,os","import sys,json,os,time").replace("elif m==\"resources/read\":out=",&format!("elif m==\"resources/read\":\n  if os.path.exists({}):\n   open({},'w').close()\n   while os.path.exists({}):time.sleep(0.01)\n  out=",json!(block),json!(entered),json!(block)));
    write(workspace_root.as_path(), "pkg/server.py", &script);
    write(
        workspace_root.as_path(),
        "pkg/.mcp.json",
        r#"{"mcpServers":{"fixture":{"command":"python3","args":["server.py"]}}}"#,
    );
    write(workspace_root.as_path(), "file.txt", "original");
    let (runtime, peer) = file_runtime().await;
    let e = Engine::open_with_runtime(
        data.path(),
        Arc::new(ModelFixture),
        Limits::default(),
        areal_engine::tools::RuntimeConfig {
            client: runtime.clone(),
            workspace: workspace_root.as_path().into(),
            writable: true,
            command_scope: None,
            command_scratch: None,
        },
    )
    .unwrap();
    let store = Arc::new(
        Store::open(
            workspace_root.as_path().join("plugins"),
            workspace_root.as_path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    e.plugin_connection(d.id, d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(workspace_root.as_path().to_str().unwrap().into())
        .await
        .unwrap();
    let app = e
        .mcp_app_open(
            "owner".into(),
            thread.id.clone(),
            server.clone(),
            generation,
            "app".into(),
            None,
            "file-open".into(),
            Some(json!({"uri":"opaque://file","path":workspace_root.as_path().join("file.txt")})),
            None,
        )
        .await
        .unwrap();
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    let request = |text: &str| json!({"jsonrpc":"2.0","id":1,"method":"ui/host-file","params":{"request":{"jsonrpc":"2.0","id":2,"method":"openai/resources/write","params":{"uri":"opaque://file","text":text}}}});
    let key = uuid::Uuid::new_v4().to_string();
    let first = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request("saved"),
            Some(key.clone()),
        )
        .await
        .unwrap();
    assert_eq!(first["result"]["outcome"], "saved");
    write(
        workspace_root.as_path(),
        "file.txt",
        "intervening user edit",
    );
    let retry = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request("saved"),
            Some(key.clone()),
        )
        .await
        .unwrap();
    assert_eq!(retry, first);
    assert_eq!(
        fs::read_to_string(workspace_root.as_path().join("file.txt")).unwrap(),
        "intervening user edit"
    );
    assert!(matches!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request("different"),
            Some(key)
        )
        .await,
        Err(areal_engine::Error::Conflict)
    ));

    // Hold App mutation across a real resource request, queue close first, then update.
    fs::write(&block, "").unwrap();
    let opening = {
        let e = e.clone();
        let thread = thread.id.clone();
        tokio::spawn(async move {
            e.mcp_app_open(
                "owner".into(),
                thread,
                server,
                generation,
                "app".into(),
                None,
                "blocking-open".into(),
                None,
                None,
            )
            .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !entered.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let closing = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_close("owner".into(), thread, instance, generation)
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    let updating = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request("owner".into(),thread,instance,generation,json!({"jsonrpc":"2.0","id":3,"method":"ui/update-model-context","params":{"content":[{"type":"text","text":"must not resurrect"}]}}),None).await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    fs::remove_file(block).unwrap();
    opening.await.unwrap().unwrap();
    closing.await.unwrap().unwrap();
    assert!(updating.await.unwrap().is_err());
    let records: serde_json::Value =
        serde_json::from_slice(&fs::read(data.path().join("desktop/mcp-apps.json")).unwrap())
            .unwrap();
    assert!(records.get(&instance).is_none());
    e.shutdown().await;
    runtime.shutdown().await.unwrap();
    peer.await.unwrap();
}

#[tokio::test]
async fn long_mcp_aliases_are_valid_distinct_and_preserve_connector_id() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        workspace.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    let original = "original-github-acceptance-id";
    write(
        workspace.path(),
        "pkg/.app.json",
        &json!({"apps":[{"id":original,"name":"GitHub"}]}).to_string(),
    );
    let config = json!({"command":"python3","args":["server.py"]});
    let mut servers = serde_json::Map::new();
    for name in [
        original,
        "identical-prefix-server-name-one",
        "identical-prefix-server-name-two",
    ] {
        servers.insert(name.into(), config.clone());
    }
    write(
        workspace.path(),
        "pkg/.mcp.json",
        &json!({"mcpServers":servers}).to_string(),
    );
    let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    e.plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let aliases: std::collections::BTreeSet<_> = apps["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["serverId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(aliases.len(), 3);
    assert!(aliases.iter().all(|name| name.len() <= 32));
    e.plugin_connection(d.id.clone(), digest.clone(), false)
        .await
        .unwrap();
    let mapping = e
        .connector_configure(
            d.id.clone(),
            original.into(),
            "github".into(),
            "fixture-reference".into(),
            digest,
        )
        .await
        .unwrap();
    assert_eq!(mapping["connectorId"], original);
    assert_eq!(
        e.plugin_component_summary(d.id).await.unwrap()["apps"][0]["id"],
        original
    );
    e.shutdown().await;
}

#[tokio::test]
async fn optional_server_readiness_preserves_healthy_siblings() {
    for mode in [
        "optional",
        "required",
        "auth",
        "disabled-auth",
        "unsupported-auth",
        "all-failed",
        "all-auth",
        "all-disabled",
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(
            workspace.path(),
            ".agents/plugins/marketplace.json",
            r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
        );
        let portable = mode == "unsupported-auth";
        write(
            workspace.path(),
            if portable {
                "pkg/plugin.json"
            } else {
                "pkg/.codex-plugin/plugin.json"
            },
            if portable {
                r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample"}"#
            } else {
                r#"{"name":"sample"}"#
            },
        );
        write(
            workspace.path(),
            "pkg/server.py",
            include_str!("../../mcp/tests/substrate.py"),
        );
        let good = if portable {
            json!({"type":"stdio","command":"python3","args":["server.py"]})
        } else {
            json!({"command":"python3","args":["server.py"]})
        };
        let bad = match mode {
            "unsupported-auth" => {
                json!({"type":"streamable-http","url":"https://example.invalid/mcp","extensions":{"com.openai":{"auth":{"type":"api_key","headerScheme":"bearer"}}}})
            }
            "auth" | "all-auth" => json!({"url":"https://example.invalid/mcp","auth":"oauth"}),
            "disabled-auth" | "all-disabled" => {
                json!({"url":"https://example.invalid/mcp","auth":"oauth","enabled":false})
            }
            _ => json!({"command":"/no-such-fixture-command","required":mode=="required"}),
        };
        let mut servers = json!({"bad":bad});
        if !mode.starts_with("all-") {
            servers["good"] = good;
        }
        if mode == "optional" {
            servers["malformed"] = json!(7);
        }
        write(
            workspace.path(),
            if portable {
                "pkg/mcp.json"
            } else {
                "pkg/.mcp.json"
            },
            &if portable {json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":servers})} else {json!({"mcpServers":servers})}.to_string(),
        );
        let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
        let store = Arc::new(
            Store::open(
                workspace.path().join("plugins"),
                workspace.path().into(),
                None,
            )
            .unwrap(),
        );
        e.install_plugin_store(store.clone()).unwrap();
        let d = store.read("sample@local").unwrap();
        e.plugin_install(
            d.id.clone(),
            "user".into(),
            d.revision,
            d.source,
            d.source_digest,
        )
        .await
        .unwrap();
        let d = store.read(&d.id).unwrap();
        let digest = d.installed_digest.unwrap();
        let result = e
            .plugin_connection(d.id.clone(), digest.clone(), true)
            .await;
        if mode == "required" {
            assert!(result.is_err());
            assert!(
                e.mcp_apps_list(None).await.unwrap()["data"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        } else {
            let value = result.unwrap_or_else(|error| panic!("{mode}: {error}"));
            let row = &value["data"][0];
            let expected = match mode {
                "disabled-auth" => "connected",
                "all-disabled" => "disabled",
                "all-auth" => "authRequired",
                "all-failed" => "failed",
                _ => "partial",
            };
            assert_eq!(row["state"], expected, "{mode}");
            assert_eq!(
                e.mcp_apps_list(None).await.unwrap()["data"]
                    .as_array()
                    .unwrap()
                    .len(),
                if mode.starts_with("all-") { 0 } else { 1 },
                "{mode}"
            );
            if expected == "partial" {
                assert_eq!(
                    e.plugin_connection(d.id.clone(), digest, true)
                        .await
                        .unwrap()["data"][0]["state"],
                    "partial"
                );
                assert!(!row["diagnostics"].as_array().unwrap().is_empty());
            }
            assert!(
                row["servers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|server| server["state"].is_string())
            );
        }
        e.shutdown().await;
    }
}

struct ProfileInventory(std::sync::Mutex<Vec<Vec<serde_json::Value>>>);
#[async_trait]
impl Model for ProfileInventory {
    fn name(&self) -> &str {
        "profile-inventory"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        _: Vec<Message>,
        tools: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        self.0.lock().unwrap().push(tools);
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("done"),
        )])))
    }
}
#[tokio::test]
async fn explicit_profile_entrypoint_does_not_expand_model_or_app_visibility() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    let script = include_str!("../../mcp/tests/substrate.py")
        .replace("\"visibility\":[\"app\"]", "\"visibility\":[\"model\"]")
        .replace(
            "}},\"icons\"",
            "},\"openai/ui\":{\"entrypoints\":[{\"type\":\"global\"}]}},\"icons\"",
        );
    write(workspace.path(), "pkg/server.py", &script);
    write(
        workspace.path(),
        "pkg/.mcp.json",
        r#"{"mcpServers":{"fixture":{"command":"python3","args":["server.py"]}}}"#,
    );
    let model = Arc::new(ProfileInventory(Default::default()));
    let e = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
    write(
        workspace.path(),
        "deployment.json",
        r#"{"profiles":[{"id":"explicit","revision":"v1","displayName":"Explicit","instructions":""},{"id":"restricted","revision":"v1","displayName":"Restricted","instructions":"","toolAllowlist":[]}]}"#,
    );
    e.install_deployment(&workspace.path().join("deployment.json"))
        .unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    e.plugin_connection(d.id, d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    e.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,"agentProfile":{"id":"explicit","revision":"v1"}})).unwrap()).await.unwrap();
    assert!(
        !e.read(&thread.id, true)
            .await
            .unwrap()
            .desktop
            .unwrap()
            .configuration
            .allow_plugin_skills
    );
    let app = e
        .mcp_app_open(
            "owner".into(),
            thread.id.clone(),
            server.clone(),
            generation,
            "app".into(),
            Some(json!({})),
            "entrypoint".into(),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(app["initialResult"]["structuredContent"]["v"], 1);
    assert!(
        model.0.lock().unwrap().is_empty(),
        "explicit App call must not run inference"
    );
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    assert!(e.mcp_app_request("owner".into(),thread.id.clone(),instance,generation,json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app","arguments":{}}}),Some("not-an-entrypoint".into())).await.is_err());
    e.start(
        &thread.id,
        vec![areal_protocol::Input::text("ordinary inventory")],
    )
    .await
    .unwrap();
    e.wait(&thread.id).await.unwrap();
    assert!(model.0.lock().unwrap().iter().flatten().all(|tool| {
        !tool["function"]["name"]
            .as_str()
            .unwrap_or("")
            .starts_with("mcp__")
    }));
    let restricted = e
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    e.configure_thread(serde_json::from_value(json!({"threadId":restricted.id,"expectedRevision":1,"agentProfile":{"id":"restricted","revision":"v1"}})).unwrap()).await.unwrap();
    assert!(
        e.mcp_app_open(
            "owner".into(),
            restricted.id,
            server,
            generation,
            "app".into(),
            Some(json!({})),
            "restricted-entrypoint".into(),
            None,
            None
        )
        .await
        .is_err()
    );
    e.shutdown().await;
}

async fn retry_oauth_fixture(
    axum::extract::State(base): axum::extract::State<String>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let result = match uri.path() {
        "/.well-known/oauth-protected-resource/mcp" | "/.well-known/oauth-protected-resource" => {
            json!({"resource":format!("{base}/mcp"),"authorization_servers":[base]})
        }
        "/.well-known/oauth-authorization-server" => {
            json!({"issuer":base,"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"response_types_supported":["code"],"grant_types_supported":["authorization_code"],"code_challenge_methods_supported":["S256"]})
        }
        "/token" => {
            json!({"access_token":"synthetic-retry-token","token_type":"Bearer","expires_in":3600})
        }
        "/mcp" => {
            if headers.get("authorization").is_none() {
                return (axum::http::StatusCode::UNAUTHORIZED,[("www-authenticate",format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\""))]).into_response();
            }
            assert!(headers["authorization"] == "Bearer synthetic-retry-token");
            let request: serde_json::Value = serde_json::from_str(&body).unwrap();
            let result = match request["method"].as_str().unwrap() {
                "server/discover" => return axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Method not found"}})).into_response(),
                "initialize" => {
                    json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"authorized","version":"1"}})
                }
                "tools/list" => {
                    json!({"tools":[{"name":"authorized","inputSchema":{"type":"object"}}]})
                }
                _ => return axum::http::StatusCode::ACCEPTED.into_response(),
            };
            json!({"jsonrpc":"2.0","id":request["id"],"result":result})
        }
        _ => return axum::http::StatusCode::NOT_FOUND.into_response(),
    };
    axum::Json(result).into_response()
}
#[tokio::test]
async fn explicit_retry_after_optional_oauth_keeps_old_app_owner() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = axum::Router::new()
        .fallback(retry_oauth_fixture)
        .with_state(base);
    let address = listener.local_addr().unwrap();
    let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        workspace.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    write(workspace.path(),"pkg/.mcp.json",&json!({"mcpServers":{"healthy":{"command":"python3","args":["server.py"]},"optional":{"url":format!("http://{address}/mcp"),"oauth":{"clientId":"fixture"}}}}).to_string());
    let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    let partial = e
        .plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    assert_eq!(partial["data"][0]["state"], "partial");
    let auth_server = partial["data"][0]["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["state"] == "authRequired")
        .unwrap()["serverId"]
        .as_str()
        .unwrap()
        .to_owned();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    let app = e
        .mcp_app_open(
            "owner".into(),
            thread.id.clone(),
            server,
            generation,
            "app".into(),
            None,
            "retained".into(),
            None,
            None,
        )
        .await
        .unwrap();
    let pending = e
        .plugin_auth(d.id.clone(), auth_server.clone(), "start".into())
        .await
        .unwrap();
    let url = reqwest::Url::parse(
        pending["authorizationUrl"]
            .as_str()
            .expect("OAuth pending URL"),
    )
    .unwrap();
    let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let mut callback = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", "fixture-code")
        .append_pair("state", &query["state"]);
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(callback)
        .send()
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while e
            .plugin_auth(d.id.clone(), auth_server.clone(), "status".into())
            .await
            .unwrap()["status"]
            != "ready"
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let complete = e
        .plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    assert_eq!(complete["data"][0]["state"], "connected");
    assert_eq!(
        e.mcp_apps_list(None).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let before = e.mcp_apps_list(None).await.unwrap();
    e.plugin_connection(d.id.clone(), digest, true)
        .await
        .unwrap();
    let after = e.mcp_apps_list(None).await.unwrap();
    assert!(
        after["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|server| before["data"]
                .as_array()
                .unwrap()
                .iter()
                .all(|old| old["generation"] != server["generation"])),
        "explicit retry must replace even apparently connected handles after reauth"
    );
    let old = e
        .mcp_app_request(
            "owner".into(),
            thread.id,
            app["instanceId"].as_str().unwrap().into(),
            generation,
            json!({"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://app"}}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(old["result"]["contents"][0]["text"], "<p>Hello</p>");
    e.shutdown().await;
    http.abort();
    let _ = http.await;
}

#[tokio::test]
async fn mrtr_app_resource_and_tool_share_authoritative_forms() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        root.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"modern","source":"./pkg"}]}"#,
    );
    write(
        root.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"modern"}"#,
    );
    write(
        root.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/mrtr.py"),
    );
    write(root.path(),"pkg/.mcp.json",&json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"READ_FORM":"1"}}}}).to_string());
    let e = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    e.set_permissions(
        serde_json::from_value(json!({"mode":"ASK_PERMISSIONS","ask":["mcp__*"]})).unwrap(),
        None,
    )
    .unwrap();
    let store =
        Arc::new(Store::open(root.path().join("plugins"), root.path().into(), None).unwrap());
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("modern@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    e.plugin_connection(d.id.clone(), d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(root.path().to_str().unwrap().into())
        .await
        .unwrap();
    let open = {
        let e = e.clone();
        let thread = thread.id.clone();
        let server = server.clone();
        tokio::spawn(async move {
            e.mcp_app_open(
                "owner".into(),
                thread,
                server,
                generation,
                "app".into(),
                None,
                "modern-open".into(),
                None,
                None,
            )
            .await
        })
    };
    async fn next_form(e: &Arc<Engine>, thread: &str) -> serde_json::Value {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let forms = e.mcp_forms_list(thread.into()).await.unwrap();
                if let Some(f) = forms["data"].as_array().unwrap().first() {
                    return f.clone();
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    for index in 0..2 {
        let form = next_form(&e, &thread.id).await;
        assert_eq!(form["turnId"], "");
        let id = form["requestId"].as_str().unwrap().to_owned();
        assert!(
            e.mcp_form_respond(
                "stranger".into(),
                thread.id.clone(),
                id.clone(),
                json!({"action":"accept","content":{"answer":"yes"}})
            )
            .await
            .is_err()
        );
        assert!(
            e.mcp_form_respond(
                "owner".into(),
                thread.id.clone(),
                id.clone(),
                json!({"action":"accept","content":{"answer":true}})
            )
            .await
            .is_err()
        );
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            id,
            json!({"action":"accept","content":{"answer":format!("round{index}")}}),
        )
        .await
        .unwrap();
    }
    let app = open.await.unwrap().unwrap();
    assert_eq!(app["resource"]["html"], "<p>MRTR finished</p>");
    assert!(e.read(&thread.id, true).await.unwrap().turns.is_empty());
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app","arguments":{"mode":"normal"}}});
    let job = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        let request = request.clone();
        tokio::spawn(async move {
            e.mcp_app_request(
                "owner".into(),
                thread,
                instance,
                generation,
                request,
                Some("mrtr-once".into()),
            )
            .await
        })
    };
    approve(&e, &thread.id).await;
    for _ in 0..2 {
        let form = next_form(&e, &thread.id).await;
        assert_ne!(form["turnId"], "");
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"accept","content":{"answer":"accepted"}}),
        )
        .await
        .unwrap();
    }
    let result = job.await.unwrap().unwrap();
    assert_eq!(result["result"]["_meta"]["preserved"], true);
    let replay = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request,
            Some("mrtr-once".into()),
        )
        .await
        .unwrap();
    assert_eq!(replay, result);
    assert_eq!(e.read(&thread.id, true).await.unwrap().turns.len(), 1);
    // Uploaded directory is outside the workspace; only the explicit picker operation can import it.
    let picked = tempfile::tempdir().unwrap();
    let picked_path = picked.path().canonicalize().unwrap();
    std::fs::write(picked_path.join("data.txt"), "snapshot-before").unwrap();
    let upload = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request("owner".into(),thread,instance,generation,json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"app","arguments":{"mode":"upload"}}}),Some("upload-once".into())).await
        })
    };
    approve(&e, &thread.id).await;
    let form = next_form(&e, &thread.id).await;
    let form_id = form["requestId"].as_str().unwrap().to_owned();
    assert!(
        e.mcp_form_resource_prepare(
            "stranger".into(),
            thread.id.clone(),
            form_id.clone(),
            "selected".into()
        )
        .await
        .is_err()
    );
    let prepared = e
        .mcp_form_resource_prepare(
            "owner".into(),
            thread.id.clone(),
            form_id.clone(),
            "selected".into(),
        )
        .await
        .unwrap();
    let token = prepared["selectionToken"].as_str().unwrap().to_owned();
    assert_eq!(prepared["multiple"], false);
    assert!(
        e.mcp_form_resource_stage("stranger".into(), token.clone(), vec![picked_path.clone()])
            .await
            .is_err()
    );
    let paths = vec![picked_path.clone()];
    let parameters = json!({"selectionToken":token,"paths":paths});
    let stage_id = uuid::Uuid::new_v4().to_string();
    let staged = e
        .management_submission(
            "owner".into(),
            stage_id.clone(),
            "areal/mcp/form/resource/stage".into(),
            parameters.clone(),
            {
                let token = token.clone();
                let paths = paths.clone();
                move |e| async move {
                    e.mcp_form_resource_stage("owner".into(), token, paths)
                        .await
                        .unwrap()
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(staged["summary"]["fileCount"], 1);
    assert_eq!(staged["summary"]["totalBytes"], 15);
    let uri = staged["resources"][0]["uri"].as_str().unwrap().to_owned();
    assert!(uri.starts_with("areal-mcp-resource://"));
    assert!(!staged.to_string().contains(picked_path.to_str().unwrap()));
    std::fs::write(picked_path.join("data.txt"), "changed-after-stage").unwrap();
    let repeated = e
        .management_submission(
            "owner".into(),
            stage_id,
            "areal/mcp/form/resource/stage".into(),
            parameters,
            |_| async { panic!("duplicate stage must not run") },
        )
        .await
        .unwrap();
    assert_eq!(repeated, staged);
    assert!(
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form_id.clone(),
            json!({"action":"accept","content":{"selected":"file:///ungranted"}})
        )
        .await
        .is_err()
    );
    e.mcp_form_respond(
        "owner".into(),
        thread.id.clone(),
        form_id,
        json!({"action":"accept","content":{"selected":uri}}),
    )
    .await
    .unwrap();
    let result = upload.await.unwrap().unwrap();
    let receipt: serde_json::Value =
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(receipt["snapshot"], "snapshot-before");
    assert_eq!(
        std::fs::read_to_string(picked_path.join("data.txt")).unwrap(),
        "changed-after-stage"
    );
    let snapshot = reqwest::Url::parse(receipt["fileUri"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while snapshot.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        e.mcp_form_resource_stage("owner".into(), token, paths)
            .await
            .is_err()
    );
    let read = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request("owner".into(),thread,instance,generation,json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://app"}}),None).await
        })
    };
    let form = next_form(&e, &thread.id).await;
    e.mcp_app_close("owner".into(), thread.id.clone(), instance, generation)
        .await
        .unwrap();
    assert!(
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"cancel"})
        )
        .await
        .is_err()
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), read)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    e.shutdown().await;
}

// Planned failure: the transport challenge's scope is lost between failed discovery
// and explicit Core authentication; auth must not replay the rejected startup POST.
async fn scoped_challenge_fixture(
    axum::extract::State((base, attempts)): axum::extract::State<(
        String,
        Arc<std::sync::atomic::AtomicUsize>,
    )>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if uri.path() == "/mcp" && headers.get("authorization").is_none() {
        let n = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let scope = if n == 0 {
            "protected.read"
        } else {
            "unexpected.probe"
        };
        return (axum::http::StatusCode::UNAUTHORIZED,[("www-authenticate",format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\", scope=\"{scope}\""))]).into_response();
    }
    if uri
        .path()
        .starts_with("/.well-known/oauth-protected-resource")
    {
        return axum::Json(json!({"resource":format!("{base}/mcp"),"authorization_servers":[base],"scopes_supported":["default.read"]})).into_response();
    }
    retry_oauth_fixture(axum::extract::State(base), uri, headers, body).await
}
#[tokio::test]
async fn explicit_auth_uses_private_startup_challenge_without_replay() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = axum::Router::new()
        .fallback(scoped_challenge_fixture)
        .with_state((base.clone(), attempts.clone()));
    let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","version":"1.0.0"}"#,
    );
    write(workspace.path(),"pkg/mcp.json",&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"scoped":{"type":"streamable-http","url":format!("{base}/mcp"),"extensions":{"com.openai":{"auth":{"type":"mixed","client":{"mode":"provided","clientId":"fixture"}}}}}}}).to_string());
    let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    let failed = e
        .plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    let server = failed["data"][0]["servers"][0]["serverId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(failed["data"][0]["servers"][0]["state"], "authRequired");
    assert!(!failed.to_string().contains("protected.read"));
    let pending = e
        .plugin_auth(d.id.clone(), server.clone(), "start".into())
        .await
        .unwrap();
    let url = reqwest::Url::parse(pending["authorizationUrl"].as_str().unwrap()).unwrap();
    let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let scopes: std::collections::BTreeSet<_> = query["scope"].split_whitespace().collect();
    assert_eq!(
        scopes,
        std::collections::BTreeSet::from(["default.read", "protected.read"])
    );
    assert_eq!(
        attempts.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "explicit authentication never replays discovery"
    );
    let mut callback = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", "fixture-code")
        .append_pair("state", &query["state"]);
    assert!(
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(callback)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while e
            .plugin_auth(d.id.clone(), server.clone(), "status".into())
            .await
            .unwrap()["status"]
            != "ready"
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let ready = e.plugin_connection(d.id, digest, true).await.unwrap();
    assert_eq!(ready["data"][0]["state"], "connected");
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    e.shutdown().await;
    http.abort();
}

// Planned policy failures: ON_INSTALL mixed accidentally calls anonymously;
// listing/installation starts OAuth; ON_USE is prematurely blocked as installed.
#[tokio::test]
async fn marketplace_authentication_timing_gates_only_declared_servers() {
    for (timing, expected) in [("ON_INSTALL", "authRequired"), ("ON_USE", "disconnected")] {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(workspace.path(),".agents/plugins/marketplace.json",&json!({"name":"local","plugins":[{"name":"sample","source":"./pkg","policy":{"installation":"AVAILABLE","authentication":timing}}]}).to_string());
        write(
            workspace.path(),
            "pkg/plugin.json",
            r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","version":"1.0.0"}"#,
        );
        write(workspace.path(),"pkg/mcp.json",&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"authenticated":{"type":"streamable-http","url":"http://127.0.0.1:1/mcp","extensions":{"com.openai":{"auth":{"type":"mixed","client":{"mode":"provided","clientId":"fixture"}}}}},"anonymous":{"type":"streamable-http","url":"http://127.0.0.1:1/other"}}}).to_string());
        let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
        let store = Arc::new(
            Store::open(
                workspace.path().join("plugins"),
                workspace.path().into(),
                None,
            )
            .unwrap(),
        );
        e.install_plugin_store(store.clone()).unwrap();
        let d = store.read("sample@local").unwrap();
        e.plugin_install(
            d.id.clone(),
            "user".into(),
            d.revision,
            d.source,
            d.source_digest,
        )
        .await
        .unwrap();
        let listed = e.plugin_mcp_list().await.unwrap();
        let row = &listed["data"][0];
        assert_eq!(row["state"], expected);
        let servers = row["servers"].as_array().unwrap();
        let authenticated = servers
            .iter()
            .find(|s| s["authentication"] != "none")
            .unwrap();
        let anonymous = servers
            .iter()
            .find(|s| s["authentication"] == "none")
            .unwrap();
        assert_eq!(authenticated["state"], expected);
        assert_eq!(anonymous["state"], "disconnected");
        assert!(
            e.plugin_auth(
                d.id,
                authenticated["serverId"].as_str().unwrap().into(),
                "status".into()
            )
            .await
            .unwrap()
            .is_null(),
            "installation/listing must never initiate OAuth"
        );
        e.shutdown().await;
    }
}
