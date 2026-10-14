use areal_runtime_protocol::*;
use areal_runtime_supervisor::{
    Config,
    backend::{Backend, Event, Execution},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct NoExecution;

#[tokio::test]
async fn initialization_failure_preserves_cleanup_evidence_through_client_handshake() {
    for (code, cleaned) in [
        (ErrorCode::Unavailable, true),
        (ErrorCode::CleanupFailed, false),
    ] {
        let (client, server) = tokio::io::duplex(4096);
        let (read, write) = tokio::io::split(server);
        let service = tokio::spawn(areal_runtime::reject_startup(
            read,
            write,
            Error::new(code, "native executor cannot initialize"),
        ));
        let (read, write) = tokio::io::split(client);
        let error = match areal_runtime_client::Client::connect(read, write).await {
            Ok(_) => panic!("failed initialization must not yield a Runtime client"),
            Err(error) => error,
        };
        assert_eq!(error.code, code);
        assert_eq!(
            error.details.as_ref().unwrap()["initializationFailed"],
            true
        );
        assert_eq!(error.details.as_ref().unwrap()["cleanupConfirmed"], cleaned);
        let result = service.await.unwrap();
        if cleaned {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().code, ErrorCode::CleanupFailed);
        }
    }
}

#[tokio::test]
async fn failed_initialization_never_acknowledges_a_non_handshake_request() {
    let (client, server) = tokio::io::duplex(4096);
    let (read, write) = tokio::io::split(server);
    let service = tokio::spawn(areal_runtime::reject_startup(
        read,
        write,
        Error::new(ErrorCode::Unavailable, "sandbox unavailable"),
    ));
    let (read, mut write) = tokio::io::split(client);
    write
        .write_all(
            format!(
                "{}\n",
                json!({"id":1,"method":"process.start","params":{"protocolVersion":VERSION}})
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    assert_eq!(
        service.await.unwrap().unwrap_err().code,
        ErrorCode::InvalidRequest
    );
    assert!(
        BufReader::new(read)
            .lines()
            .next_line()
            .await
            .unwrap()
            .is_none()
    );
}

#[async_trait]
impl Backend for NoExecution {
    async fn start(&self, _: Execution) -> Result<mpsc::Receiver<Event>> {
        panic!("invalid request reached executor");
    }
    async fn terminate(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn private_transport_requires_handshake_and_rejects_unadvertised_privileges() {
    let dir = tempfile::tempdir().unwrap();
    let host =
        RuntimeHost::with_backend(Config::read_only(dir.path().into()), Arc::new(NoExecution))
            .await
            .unwrap();
    let runtime = host.supervisor();
    let root = runtime.connection_info().root_scope_id;
    let epoch = runtime.connection_info().runtime_epoch;
    let (client, server) = tokio::io::duplex(16 * 1024);
    let (read, write) = tokio::io::split(server);
    let service = tokio::spawn(areal_runtime::serve(
        read,
        write,
        host,
        CancellationToken::new(),
    ));
    let (read, mut write) = tokio::io::split(client);
    let mut read = BufReader::new(read).lines();
    let cases = [
        (
            json!({"id":1,"method":"scope.get","params":{"scopeId":root}}),
            Some("UNAUTHENTICATED"),
        ),
        (
            json!({"id":2,"method":"connection.open","params":{"protocolVersion":"invalid"}}),
            Some("UNSUPPORTED"),
        ),
        (
            json!({"id":3,"method":"connection.open","params":{"protocolVersion":VERSION}}),
            None,
        ),
        (
            json!({"id":4,"method":"process.start","params":{"operationId":format!("{epoch}:op:{}",uuid::Uuid::new_v4()),
            "scopeId":root,"argv":["/usr/bin/true"],"cwd":"workspace://repo","sandbox":null}}),
            Some("INVALID_ARGUMENT"),
        ),
        (
            json!({"id":5,"method":"fs.write","params":{}}),
            Some("UNSUPPORTED"),
        ),
        (
            json!({"id":6,"method":"connection.close","params":{}}),
            None,
        ),
    ];
    for (request, expected) in cases {
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let line = tokio::time::timeout(Duration::from_secs(3), read.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], request["id"]);
        assert_eq!(
            response.get("error").map(|e| e["code"].as_str().unwrap()),
            expected
        );
    }
    service.await.unwrap().unwrap();
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Closed);
}

#[tokio::test]
async fn a_client_that_never_reads_cannot_leave_the_response_writer_running() {
    let dir = tempfile::tempdir().unwrap();
    let host =
        RuntimeHost::with_backend(Config::read_only(dir.path().into()), Arc::new(NoExecution))
            .await
            .unwrap();
    let runtime = host.supervisor();
    let root = runtime.connection_info().root_scope_id;
    let (mut client, server) = tokio::io::duplex(32);
    let (read, write) = tokio::io::split(server);
    let service = tokio::spawn(areal_runtime::serve(
        read,
        write,
        host,
        CancellationToken::new(),
    ));
    let flood = tokio::spawn(async move {
        for id in 0..100 {
            if client
                .write_all(
                    format!("{}\n", json!({"id":id,"method":"scope.get","params":{}})).as_bytes(),
                )
                .await
                .is_err()
            {
                break;
            }
        }
        // 保持客户端存活，避免把 EOF 当成慢消费者问题的解决方式。
        tokio::time::sleep(Duration::from_secs(10)).await;
    });
    let result = tokio::time::timeout(Duration::from_secs(4), service)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::Unavailable);
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Closed);
    flood.abort();
    let _ = flood.await;
}
use areal_runtime::components::RuntimeHost;

// End-to-end contract: the public client/daemon admission reaches the native
// sandbox, and a same-task ordinary command can release two concurrent hooks.
#[tokio::test]
async fn native_hook_group_allows_progress_without_releasing_foreign_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::read_only(dir.path().into());
    config.writable = true;
    config.limits.max_processes = 8;
    config.limits.wall_time_ms = 5000;
    let host = RuntimeHost::launch(config).await.unwrap();
    let (wire, server) = tokio::io::duplex(64 * 1024);
    let (read, write) = tokio::io::split(server);
    let service = tokio::spawn(areal_runtime::serve(
        read,
        write,
        host,
        CancellationToken::new(),
    ));
    let (read, write) = tokio::io::split(wire);
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
    service.await.unwrap().unwrap();
}
