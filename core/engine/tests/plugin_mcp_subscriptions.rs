//! Failure cases before implementation: duplicate wire subscriptions, cross-App unsubscribe,
//! notifications delivered to nonowners/closed Apps, last-close leaks, close/subscribe race,
//! and old generation ownership inherited by a reconnected server. Real Engine + stdio MCP.
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_plugins::Store;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path, sync::Arc, time::Duration};
struct NoInference;
#[async_trait]
impl Model for NoInference {
    fn name(&self) -> &str {
        "unused"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        anyhow::bail!("subscription fixture must not invoke inference")
    }
}
fn write(root: &Path, path: &str, value: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
struct Fixture {
    workspace: tempfile::TempDir,
    _data: tempfile::TempDir,
    engine: Arc<Engine>,
    digest: String,
    server: String,
    generation: u64,
}
impl Fixture {
    async fn new() -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(
            workspace.path(),
            ".agents/plugins/marketplace.json",
            r#"{"name":"local","plugins":[{"name":"subscriptions","source":"./pkg"}]}"#,
        );
        write(
            workspace.path(),
            "pkg/.codex-plugin/plugin.json",
            r#"{"name":"subscriptions"}"#,
        );
        write(
            workspace.path(),
            "pkg/server.py",
            include_str!("fixtures/plugin_subscriptions.py"),
        );
        write(workspace.path(), "pkg/.mcp.json", &json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"FIXTURE_ROOT":workspace.path()},"tool_timeout_sec":10}}}).to_string());
        let engine = Engine::open(data.path(), Arc::new(NoInference), Limits::default()).unwrap();
        let store = Arc::new(
            Store::open(
                workspace.path().join("plugins"),
                workspace.path().into(),
                None,
            )
            .unwrap(),
        );
        engine.install_plugin_store(store.clone()).unwrap();
        let d = store.read("subscriptions@local").unwrap();
        engine
            .plugin_install(
                d.id.clone(),
                "user".into(),
                d.revision,
                d.source,
                d.source_digest,
            )
            .await
            .unwrap();
        let digest = store.read(&d.id).unwrap().installed_digest.unwrap();
        engine
            .plugin_connection(d.id, digest.clone(), true)
            .await
            .unwrap();
        let apps = engine.mcp_apps_list(None).await.unwrap();
        Self {
            workspace,
            _data: data,
            engine,
            digest,
            server: apps["data"][0]["serverId"].as_str().unwrap().into(),
            generation: apps["data"][0]["generation"].as_u64().unwrap(),
        }
    }
    async fn open(&self, name: &str) -> (String, String) {
        let thread = self
            .engine
            .create(self.workspace.path().to_str().unwrap().into())
            .await
            .unwrap();
        let app = self
            .engine
            .mcp_app_open(
                "owner".into(),
                None,
                thread.id.clone(),
                self.server.clone(),
                self.generation,
                "app".into(),
                None,
                name.into(),
                None,
                None,
            )
            .await
            .unwrap();
        (thread.id, app["instanceId"].as_str().unwrap().into())
    }
    async fn request(
        &self,
        app: &(String, String),
        method: &str,
        uri: &str,
    ) -> areal_engine::Result<Value> {
        self.engine
            .mcp_app_request(
                "owner".into(),
                app.0.clone(),
                app.1.clone(),
                self.generation,
                json!({"jsonrpc":"2.0","id":1,"method":method,"params":{"uri":uri}}),
                None,
            )
            .await
    }
    async fn close(&self, app: &(String, String)) {
        self.engine
            .mcp_app_close(
                "owner".into(),
                app.0.clone(),
                app.1.clone(),
                self.generation,
            )
            .await
            .unwrap();
    }
    fn count(&self, method: &str, uri: &str) -> usize {
        fs::read_to_string(self.workspace.path().join("wire.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|q| q["method"] == method && q["params"]["uri"] == uri)
            .count()
    }
}
async fn notices(events: &mut tokio::sync::broadcast::Receiver<Value>) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    while let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(150), events.recv()).await
    {
        if event["method"] == "areal/mcp/app/notification" {
            ids.insert(event["params"]["instanceId"].as_str().unwrap().into());
        }
    }
    ids
}
#[tokio::test]
async fn subscriptions_are_shared_on_wire_but_owned_and_released_per_app() {
    let f = Fixture::new().await;
    let a = f.open("a").await;
    let b = f.open("b").await;
    let observer = f.open("observer").await;
    let mut a_events = f.engine.subscribe(&a.0).await.unwrap();
    let mut b_events = f.engine.subscribe(&b.0).await.unwrap();
    let mut other_events = f.engine.subscribe(&observer.0).await.unwrap();
    f.request(&a, "resources/subscribe", "watch://shared")
        .await
        .unwrap();
    f.request(&a, "resources/subscribe", "watch://shared")
        .await
        .unwrap();
    f.request(&b, "resources/subscribe", "watch://shared")
        .await
        .unwrap();
    assert_eq!(
        f.count("resources/subscribe", "watch://shared"),
        1,
        "one wire subscription for two Apps, idempotent within one App"
    );
    f.request(&observer, "resources/unsubscribe", "watch://shared")
        .await
        .unwrap();
    f.request(&a, "resources/unsubscribe", "watch://unknown")
        .await
        .unwrap();
    assert_eq!(f.count("resources/unsubscribe", "watch://shared"), 0);
    assert_eq!(f.count("resources/unsubscribe", "watch://unknown"), 0);
    // Discard the subscribe-time notification; subsequent updates must reach exactly URI owners.
    notices(&mut a_events).await;
    notices(&mut b_events).await;
    notices(&mut other_events).await;
    f.request(&observer, "resources/read", "notify://shared")
        .await
        .unwrap();
    assert_eq!(notices(&mut a_events).await, BTreeSet::from([a.1.clone()]));
    assert_eq!(notices(&mut b_events).await, BTreeSet::from([b.1.clone()]));
    assert!(
        notices(&mut other_events).await.is_empty(),
        "same-server nonowner receives no update"
    );
    f.close(&a).await;
    assert_eq!(
        f.count("resources/unsubscribe", "watch://shared"),
        0,
        "closing first owner preserves second owner"
    );
    f.request(&observer, "resources/read", "notify://shared")
        .await
        .unwrap();
    assert!(notices(&mut a_events).await.is_empty());
    assert_eq!(notices(&mut b_events).await, BTreeSet::from([b.1.clone()]));
    f.close(&b).await;
    assert_eq!(
        f.count("resources/unsubscribe", "watch://shared"),
        1,
        "last close releases server subscription once"
    );
    f.request(&observer, "resources/subscribe", "watch://explicit")
        .await
        .unwrap();
    f.request(&observer, "resources/unsubscribe", "watch://explicit")
        .await
        .unwrap();
    f.request(&observer, "resources/unsubscribe", "watch://explicit")
        .await
        .unwrap();
    f.close(&observer).await;
    assert_eq!(
        f.count("resources/unsubscribe", "watch://explicit"),
        1,
        "explicit release and later close do not replay unsubscribe"
    );
    f.engine.shutdown().await;
}
#[tokio::test]
async fn subscribe_close_race_cannot_resurrect_closed_owner() {
    let f = Fixture::new().await;
    let app = f.open("race").await;
    fs::write(f.workspace.path().join("block"), "").unwrap();
    let request = |engine: Arc<Engine>, app: (String, String), generation| async move {
        engine.mcp_app_request("owner".into(),app.0,app.1,generation,json!({"jsonrpc":"2.0","id":2,"method":"resources/subscribe","params":{"uri":"watch://slow"}}),None).await
    };
    let subscribing = tokio::spawn(request(f.engine.clone(), app.clone(), f.generation));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !f.workspace.path().join("entered").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let closing = {
        let e = f.engine.clone();
        let app = app.clone();
        let generation = f.generation;
        tokio::spawn(async move {
            e.mcp_app_close("owner".into(), app.0, app.1, generation)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        !closing.is_finished(),
        "close must wait for in-flight subscribe ownership transition"
    );
    let late = tokio::spawn(request(f.engine.clone(), app.clone(), f.generation));
    fs::remove_file(f.workspace.path().join("block")).unwrap();
    subscribing.await.unwrap().unwrap();
    closing.await.unwrap().unwrap();
    assert!(
        late.await.unwrap().is_err(),
        "queued subscribe rechecks closed App under mutation gate"
    );
    assert_eq!(f.count("resources/subscribe", "watch://slow"), 1);
    assert_eq!(f.count("resources/unsubscribe", "watch://slow"), 1);
    f.engine.shutdown().await;
}
#[tokio::test]
async fn revoked_generation_cannot_deliver_or_release_new_generation_subscriptions() {
    let mut f = Fixture::new().await;
    let old = f.open("old").await;
    let old_generation = f.generation;
    let mut old_events = f.engine.subscribe(&old.0).await.unwrap();
    f.request(&old, "resources/subscribe", "watch://shared")
        .await
        .unwrap();
    notices(&mut old_events).await;
    f.engine
        .plugin_connection("subscriptions@local".into(), f.digest.clone(), false)
        .await
        .unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(2), old_events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closed["method"], "areal/mcp/app/notification");
    assert_eq!(closed["params"]["threadId"], old.0);
    assert_eq!(closed["params"]["instanceId"], old.1);
    assert_eq!(closed["params"]["generation"], old_generation);
    assert_eq!(
        closed["params"]["notification"],
        json!({"jsonrpc":"2.0","method":"ui/notifications/closed"})
    );
    f.engine
        .plugin_connection("subscriptions@local".into(), f.digest.clone(), true)
        .await
        .unwrap();
    let apps = f.engine.mcp_apps_list(None).await.unwrap();
    f.generation = apps["data"][0]["generation"].as_u64().unwrap();
    assert_ne!(f.generation, old_generation);
    let new = f.open("new").await;
    let mut new_events = f.engine.subscribe(&new.0).await.unwrap();
    f.request(&new, "resources/subscribe", "watch://shared")
        .await
        .unwrap();
    notices(&mut new_events).await;
    assert_eq!(
        f.engine
            .mcp_app_close("owner".into(), old.0.clone(), old.1, old_generation)
            .await
            .unwrap(),
        json!({"closed": true})
    );
    assert_eq!(
        f.count("resources/unsubscribe", "watch://shared"),
        0,
        "old-generation close cannot unsubscribe new generation"
    );
    f.request(&new, "resources/read", "notify://shared")
        .await
        .unwrap();
    assert!(notices(&mut old_events).await.is_empty());
    assert_eq!(
        notices(&mut new_events).await,
        BTreeSet::from([new.1.clone()])
    );
    f.close(&new).await;
    assert_eq!(f.count("resources/unsubscribe", "watch://shared"), 1);
    f.engine.shutdown().await;
}
