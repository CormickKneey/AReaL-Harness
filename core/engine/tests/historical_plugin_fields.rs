use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::{
    Input,
    desktop::{DesktopState, EffectiveConfig},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Default)]
struct OrdinaryModel(AtomicUsize);
#[async_trait]
impl Model for OrdinaryModel {
    fn name(&self) -> &str {
        "ordinary"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.fetch_add(1, Ordering::SeqCst);
        assert!(
            !messages
                .iter()
                .any(|m| m.text_content().contains("HISTORICAL_PLUGIN_ONLY"))
        );
        Ok(Box::pin(futures_util::stream::iter([Ok(
            "ordinary response".into(),
        )])))
    }
}

#[tokio::test]
async fn historical_plugin_data_survives_open_and_ordinary_writes_without_execution() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(OrdinaryModel::default());
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let path = dir.path().join(format!("{}.json", thread.id));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let mut configuration = serde_json::to_value(EffectiveConfig::default()).unwrap();
    configuration["allowPluginSkills"] = json!(true);
    configuration["pluginSkills"] =
        json!([{"id":"HISTORICAL_PLUGIN_ONLY", "revision":"v1", "extra":{"preserve":true}}]);
    let hooks = json!([{"id":"historical-hook", "event":"SessionStart", "delivered":false,
        "output":{"text":"HISTORICAL_PLUGIN_ONLY", "nested":[1,false,null]}}]);
    let mut desktop = serde_json::to_value(DesktopState::default()).unwrap();
    desktop["configuration"] = configuration.clone();
    desktop["hookRuns"] = hooks.clone();
    desktop["receipts"] = json!([{"identity":"fixture", "requestId":"old", "method":"turn/start", "digest":"old", "result":{"turn":{"configuration":configuration}}}]);
    record["thread"]["desktop"] = desktop;
    record["thread"]["turns"] = json!([{"id":"old-turn", "items":[], "status":"completed", "error":null, "configuration":configuration}]);
    let original = serde_json::to_vec(&record).unwrap();
    std::fs::write(&path, &original).unwrap();

    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let restored = engine.read(&thread.id, true).await.unwrap();
    assert_eq!(restored.turns.len(), 1);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        original,
        "opening idle history must not rewrite it"
    );
    assert_eq!(
        model.0.load(Ordering::SeqCst),
        0,
        "restoring history must not replay a request"
    );
    engine
        .start(&thread.id, vec![Input::text("Continue ordinary work")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["thread"]["desktop"]["hookRuns"], hooks);
    assert_eq!(
        saved["thread"]["desktop"]["configuration"]["allowPluginSkills"],
        true
    );
    assert_eq!(
        saved["thread"]["desktop"]["configuration"]["pluginSkills"],
        configuration["pluginSkills"]
    );
    assert_eq!(saved["thread"]["turns"][0], record["thread"]["turns"][0]);
    assert_eq!(
        saved["thread"]["desktop"]["receipts"],
        record["thread"]["desktop"]["receipts"]
    );
    assert_eq!(model.0.load(Ordering::SeqCst), 1);
    let reopened = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    assert_eq!(
        reopened.read(&thread.id, true).await.unwrap().turns.len(),
        2
    );
    reopened.shutdown().await;
    assert_eq!(model.0.load(Ordering::SeqCst), 1);
}

#[test]
fn compatibility_is_explicit_and_does_not_add_fields_to_ordinary_sessions() {
    let plain = serde_json::to_value(EffectiveConfig::default()).unwrap();
    assert!(plain.get("allowPluginSkills").is_none());
    assert!(plain.get("pluginSkills").is_none());
    let mut invalid = plain;
    invalid["unrecognizedConfigurationField"] = json!(true);
    assert!(serde_json::from_value::<EffectiveConfig>(invalid).is_err());
    let mut desktop = serde_json::to_value(DesktopState::default()).unwrap();
    assert!(desktop.get("hookRuns").is_none());
    desktop["unrecognizedDesktopField"] = json!([]);
    assert!(serde_json::from_value::<DesktopState>(desktop).is_err());
}
