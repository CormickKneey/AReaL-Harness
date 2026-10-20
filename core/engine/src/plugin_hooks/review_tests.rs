//! Shared-store revocation must reach frozen hooks without a directory refresh.
use super::*;
use crate::model::{Message, Model, ModelEvent, ModelStream};

struct Fixture;
#[async_trait::async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        "fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter(vec![Ok(
            ModelEvent::text("done"),
        )])))
    }
}

#[tokio::test]
async fn peer_disable_revokes_frozen_hook_and_background_invocation() {
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let root = workspace.path();
    std::fs::create_dir_all(root.join(".agents/plugins")).unwrap();
    std::fs::create_dir_all(root.join("pkg/.codex-plugin")).unwrap();
    std::fs::write(
        root.join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    std::fs::write(root.join("pkg/.codex-plugin/plugin.json"), r#"{"name":"sample","hooks":{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}}"#).unwrap();
    let store = Arc::new(
        areal_plugins::Store::open(home.path().join("plugins"), root.into(), None).unwrap(),
    );
    let d = store.read("sample@local").unwrap();
    store
        .install(&d.id, "user", d.revision, &d.source, &d.source_digest)
        .unwrap();
    let engine = Engine::open(data.path(), Arc::new(Fixture), Limits::default()).unwrap();
    engine.install_plugin_store(store.clone()).unwrap();
    let row = engine.plugin_hooks_list().await.unwrap()["data"][0].clone();
    engine.plugin_hooks_configure(serde_json::from_value(json!({"requestId":"trust-review","id":d.id,"expectedDigest":row["installedDigest"],"definitionDigest":row["definitionDigest"],"enabled":true,"trusted":true})).unwrap()).await.unwrap();
    let thread = engine.create(root.to_string_lossy().into()).await.unwrap();
    let cell = engine.cell(&thread.id).await.unwrap();
    let hook = engine.frozen_plugin_hooks(&thread).pop().unwrap();
    ensure_current(&engine, &cell, &hook).await.unwrap();
    let cancel = CancellationToken::new();
    engine.plugin_hooks.invocations.lock().unwrap().insert(
        "owned-background".into(),
        (d.id.clone(), true, cancel.clone()),
    );
    // Updating to a package with no hooks must not erase the ownership of an
    // already admitted invocation from the old revision.
    std::fs::write(
        root.join("pkg/.codex-plugin/plugin.json"),
        r#"{"name":"sample"}"#,
    )
    .unwrap();
    let replacement = store.read(&d.id).unwrap();
    store
        .install(
            &d.id,
            "user",
            replacement.revision,
            &replacement.source,
            &replacement.source_digest,
        )
        .unwrap();
    engine.refresh_plugins().await.unwrap();
    assert!(engine.plugin_hooks.plans.read().unwrap().is_empty());
    ensure_current(&engine, &cell, &hook).await.unwrap();
    let peer = areal_plugins::Store::open(home.path().join("plugins"), root.into(), None).unwrap();
    peer.configure(&d.id, "user", false, peer.list().unwrap().revision)
        .unwrap();
    let denied = ensure_current(&engine, &cell, &hook).await.is_err();
    let cancelled = tokio::time::timeout(Duration::from_secs(2), cancel.cancelled())
        .await
        .is_ok();
    engine.shutdown().await;
    assert!(denied, "peer disable still admits a frozen command hook");
    assert!(
        cancelled,
        "idle background hook did not receive peer revocation"
    );
}

struct LeaseFixture(tokio::sync::Semaphore);
#[async_trait::async_trait]
impl Model for LeaseFixture {
    fn name(&self) -> &str {
        "hook-lease-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.add_permits(1);
        Ok(Box::pin(futures_util::stream::pending()))
    }
}

#[tokio::test]
async fn inherited_inspection_with_frozen_hooks_admits_writer_before_sampling() {
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let root = workspace.path();
    std::fs::create_dir_all(root.join(".agents/plugins")).unwrap();
    std::fs::create_dir_all(root.join("pkg/.codex-plugin")).unwrap();
    std::fs::write(
        root.join(".agents/plugins/marketplace.json"),
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    )
    .unwrap();
    // 即使工具只读，冻结的生命周期 hook 也可能写入；不能先无锁采样再等第一个工具。
    std::fs::write(root.join("pkg/.codex-plugin/plugin.json"),
        r#"{"name":"sample","hooks":{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}}"#).unwrap();
    let store = Arc::new(
        areal_plugins::Store::open(home.path().join("plugins"), root.into(), None).unwrap(),
    );
    let descriptor = store.read("sample@local").unwrap();
    store
        .install(
            &descriptor.id,
            "user",
            descriptor.revision,
            &descriptor.source,
            &descriptor.source_digest,
        )
        .unwrap();
    let model = Arc::new(LeaseFixture(tokio::sync::Semaphore::new(0)));
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            inspection_permissions: areal_config::InspectionPermissions::Inherit,
            ..Default::default()
        },
    )
    .unwrap();
    engine.install_plugin_store(store).unwrap();
    let row = engine.plugin_hooks_list().await.unwrap()["data"][0].clone();
    engine.plugin_hooks_configure(serde_json::from_value(json!({
        "requestId":"trust-lease","id":descriptor.id,"expectedDigest":row["installedDigest"],
        "definitionDigest":row["definitionDigest"],"enabled":true,"trusted":true
    })).unwrap()).await.unwrap();
    let parent = engine.create(root.to_string_lossy().into()).await.unwrap();
    let turn = engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    model.0.acquire().await.unwrap().forget();
    let writer = engine.workspace_gate.clone().write_owned().await;
    let (child,child_turn) = engine.spawn_delegated_child(serde_json::from_value(json!({
        "parentThreadId":parent.id,"input":[{"type":"text","text":"inspect"}],"workspaceMode":"sharedWrite"
    })).unwrap(),turn.id.clone(),false,None).await.unwrap();
    let cell = engine.raw_cell(&child.id).await.unwrap();
    assert!(
        !cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .unwrap()
            .hooks
            .is_empty()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), model.0.acquire())
            .await
            .is_err(),
        "hook-bearing inspector sampled while another writer owned the workspace"
    );
    drop(writer);
    tokio::time::timeout(Duration::from_secs(3), model.0.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(
        engine.workspace_gate.try_read().is_err(),
        "frozen hooks did not retain exclusive admission"
    );
    engine.interrupt(&child.id, &child_turn.id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), engine.wait(&child.id))
        .await
        .unwrap()
        .unwrap();
    assert!(
        engine.workspace_gate.try_write().is_ok(),
        "cancelled hook-bearing inspector retained the lease"
    );
    engine.interrupt(&parent.id, &turn.id).await.unwrap();
    engine.shutdown().await;
}
