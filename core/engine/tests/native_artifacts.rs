use anyhow::{Context, Result};
use areal_engine::{
    Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    workgroup::{
        Admission, Plan, Task,
        service::{NativeFactory, Policy, Service, Start},
    },
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct ArtifactModel(&'static str);

#[async_trait]
impl Model for ArtifactModel {
    fn name(&self) -> &str {
        "native-artifact-fixture"
    }

    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        unreachable!()
    }

    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> Result<ModelStream> {
        let last = messages
            .iter()
            .rev()
            .find(|message| message.role != "areal_context")
            .context("worker conversation is empty")?;
        let event = if last.role == "tool" {
            let output: Value = serde_json::from_str(&last.text_content())?;
            anyhow::ensure!(output["exitCode"] == 0, "worker command failed: {output}");
            ModelEvent::TextDelta("Finished".into())
        } else {
            ModelEvent::ToolCall(ToolCall {
                id: "produce-artifact".into(),
                name: "run_command".into(),
                arguments: json!({
                    "argv":["/bin/sh", "-c", self.0],
                    "cwd":"workspace://repo",
                    "timeoutMs":5000,
                })
                .to_string(),
            })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

fn binary(name: &str) -> PathBuf {
    PathBuf::from(std::env::var(name).expect(name))
}

async fn artifact(
    command: &'static str,
    path: &str,
    baseline: Option<&[u8]>,
) -> (tempfile::TempDir, Value, Value) {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(workspace.join("generated")).unwrap();
    std::fs::write(workspace.join(".gitignore"), "generated/\n").unwrap();
    std::fs::write(workspace.join("generated/cache.txt"), "source cache").unwrap();
    if let Some(bytes) = baseline {
        std::fs::write(workspace.join(path), bytes).unwrap();
    }
    let service = Service::open(
        &temp.path().join("workgroups"),
        &workspace,
        Policy {
            allowed_writes: vec![path.into()],
            allowed_directories: vec![],
            checks: vec![vec![
                "/bin/sh".into(),
                "-c".into(),
                "test -f .gitignore && test ! -e generated/cache.txt && test ! -e generated/unrelated.txt".into(),
            ]],
            workers: 1,
            verifiers: 1,
            active_groups: 1,
            timeout_seconds: 30,
            command_timeout_ms: 5000,
            max_model_requests: 4,
        },
        Arc::new(NativeFactory {
            worker_limits: Limits::default(),
            catalog: None,
            model: Arc::new(ArtifactModel(command)),
            watchdog_disable: false,
            tool_call_limits: Default::default(),
            runtime: binary("AREAL_WORKGROUP_RUNTIME"),
            file_helper: binary("AREAL_WORKGROUP_HELPER"),
            toolchain: None,
        }),
    )
    .unwrap();
    let started = service
        .start(
            "parent".into(),
            Start {
                request_id: "ignored-artifact".into(),
                plan: Plan {
                    objective: "Publish the explicitly owned artifact".into(),
                    tasks: vec![Task {
                        configuration: None,
                        id: "producer".into(),
                        instruction: "Run the artifact command".into(),
                        writes: vec![path.into()],
                        depends: vec![],
                        integration_depends: vec![],
                        checks: vec![],
                    }],
                },
                workers: Some(1),
                admission: Admission::Fixed,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let id = started["id"].as_str().unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            let value = service.read(id, Some("parent")).await.unwrap();
            if value["record"]["status"] != "running" {
                break value;
            }
            service
                .wait(
                    id,
                    Some("parent"),
                    value["record"]["revision"].as_u64().unwrap(),
                    Duration::from_secs(1),
                )
                .await
                .unwrap();
        }
    })
    .await
    .unwrap();
    service.shutdown().await;
    assert_eq!(settled["record"]["status"], "completed", "{settled}");
    assert_eq!(settled["record"]["cleanupConfirmed"], true, "{settled}");
    let paths = service.artifact(id, Some("parent"), None, 0).await.unwrap();
    assert_eq!(
        paths["paths"],
        json!([path]),
        "declared ignored artifacts must be published and unrelated ignored products excluded"
    );
    let file = service
        .artifact(id, Some("parent"), Some(path.into()), 0)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(workspace.join("generated/cache.txt")).unwrap(),
        b"source cache"
    );
    (temp, paths, file)
}

#[tokio::test]
#[ignore = "requires built native Runtime and file helper paths"]
async fn native_worker_publishes_a_new_declared_file_under_an_ignored_directory() {
    let (temp, paths, file) = artifact(
        "test ! -e generated/cache.txt && mkdir -p generated && printf 'delivered\n' > generated/result.txt && printf 'unrelated\n' > generated/unrelated.txt && test -f generated/result.txt && test -f generated/unrelated.txt",
        "generated/result.txt",
        None,
    )
    .await;
    assert_eq!(paths["verified"], true);
    assert_eq!(file["exists"], true);
    assert_eq!(file["baseSha256"], Value::Null);
    assert_eq!(file["text"], "delivered\n");
    assert!(!temp.path().join("workspace/generated/result.txt").exists());
}

#[tokio::test]
#[ignore = "requires built native Runtime and file helper paths"]
async fn native_worker_preserves_deletion_of_a_declared_ignored_baseline_file() {
    let (temp, _, file) = artifact(
        "test ! -e generated/cache.txt && test \"$(cat generated/existing.txt)\" = original && rm generated/existing.txt && printf 'unrelated\n' > generated/unrelated.txt && test ! -e generated/existing.txt",
        "generated/existing.txt",
        Some(b"original\n"),
    )
    .await;
    assert_eq!(file["exists"], false);
    assert!(file["baseSha256"].is_string());
    assert_eq!(file["sha256"], Value::Null);
    assert_eq!(
        std::fs::read(temp.path().join("workspace/generated/existing.txt")).unwrap(),
        b"original\n"
    );
}
