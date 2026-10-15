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
