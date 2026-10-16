use areal_runtime_protocol::*;
use std::{process::Stdio, time::Duration};
use tokio::process::Command;

// End-to-end contract: the public client/daemon admission reaches the native
// sandbox, and a same-task ordinary command can release two concurrent hooks.
#[tokio::test]
async fn native_hook_group_allows_progress_without_releasing_foreign_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_areal-runtime"))
        .arg("--workspace")
        .arg(dir.path())
        .args([
            "--allow-write",
            "--max-processes",
            "8",
            "--wall-time-ms",
            "5000",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let read = daemon.stdout.take().unwrap();
    let write = daemon.stdin.take().unwrap();
    let client = areal_runtime_client::Client::connect(read, write)
        .await
        .unwrap();
    let root = client.info().root_scope_id.clone();
    let scope = |parent: String| CreateScope {
        operation_id: client.operation_id(),
        parent_scope_id: parent,
        owner: Owner {
            task_id: "native-hook-fixture".into(),
            plugin_instance_id: None,
        },
        permissions: PermissionRequest::default(),
        limits: LimitRequest::default(),
    };
    let task = client
        .create_participant_scope(CreateParticipantScope {
            authority_scope_id: root.clone(),
            scope: scope(root.clone()),
            participation: ScopeParticipation::Task {
                admission_window_ms: 4000,
            },
        })
        .await
        .unwrap();
    let hook = client
        .create_participant_scope(CreateParticipantScope {
            authority_scope_id: root.clone(),
            scope: scope(task.scope_id.clone()),
            participation: ScopeParticipation::Hook {
                task_scope_id: task.scope_id.clone(),
            },
        })
        .await
        .unwrap();
    let command = |scope: String, text: &str| StartProcess {
        operation_id: client.operation_id(),
        scope_id: scope,
        argv: vec!["/bin/sh".into(), "-c".into(), text.into()],
        cwd: "workspace://repo".into(),
        env: Default::default(),
        tty: false,
        pipe_stdin: false,
        limits: LimitRequest::default(),
    };
    let first = client
        .start(command(
            hook.scope_id.clone(),
            "touch hook-one; while [ ! -e release ]; do sleep 0.02; done",
        ))
        .await
        .unwrap();
    let second = client
        .start(command(
            hook.scope_id,
            "touch hook-two; while [ ! -e release ]; do sleep 0.02; done",
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !dir.path().join("hook-one").exists() || !dir.path().join("hook-two").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let foreign = {
        let client = client.clone();
        let req = command(root, "touch foreign");
        tokio::spawn(async move { client.start(req).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!foreign.is_finished());
    assert!(!dir.path().join("foreign").exists());
    let own = client
        .start(command(task.scope_id, "touch release"))
        .await
        .unwrap();
    for process in [&first, &second, &own] {
        assert_eq!(
            client.wait(&process.process_id).await.unwrap().exit_code,
            Some(0)
        );
    }
    let foreign = foreign.await.unwrap().unwrap();
    assert_eq!(
        client.wait(&foreign.process_id).await.unwrap().exit_code,
        Some(0)
    );
    assert!(dir.path().join("foreign").exists());
    client.shutdown().await.unwrap();
    assert!(daemon.wait().await.unwrap().success());
}
