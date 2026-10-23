use areal_runtime_protocol::*;
use std::{process::Stdio, time::Duration};
use tokio::process::Command;

#[cfg(target_os = "macos")]
#[tokio::test]
async fn desktop_path_runs_installed_tools_in_parent_and_read_only_child() {
    use futures_util::{StreamExt, stream};
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let tools: Vec<_> = ["node", "npm", "pnpm", "rg", "rustc", "cargo", "uv"]
        .into_iter()
        .filter(|tool| {
            ["/opt/homebrew/bin", "/usr/local/bin"]
                .iter()
                .any(|bin| std::path::Path::new(bin).join(tool).is_file())
                || home.as_ref().is_some_and(|home| {
                    [".cargo/bin", ".local/bin"]
                        .iter()
                        .any(|bin| home.join(bin).join(tool).is_file())
                })
        })
        .collect();
    assert!(
        !tools.is_empty(),
        "原生工具链验证需要至少一个已安装的标准工具"
    );
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("source"), "keep").unwrap();
    std::fs::write(outside.path().join("private"), "private").unwrap();
    let binary = std::path::Path::new(env!("CARGO_BIN_EXE_areal-runtime"));
    let client = areal_runtime_client::Client::launch_with_command_path(
        binary,
        &binary.with_file_name("areal-runtime-fs"),
        dir.path(),
        true,
        &Limits::default(),
        "/usr/bin:/bin:/usr/sbin:/sbin",
    )
    .await
    .unwrap();
    let child = client
        .create_scope(CreateScope {
            operation_id: client.operation_id(),
            parent_scope_id: client.info().root_scope_id.clone(),
            owner: Owner {
                task_id: "readonly-tools".into(),
                plugin_instance_id: None,
            },
            permissions: PermissionRequest {
                read_roots: Some(vec!["workspace://repo".into()]),
                write_roots: Some(vec![]),
                network: NetworkRequest::Deny,
            },
            limits: LimitRequest::default(),
        })
        .await
        .unwrap();
    let mut probes = Vec::new();
    for scope in [&client.info().root_scope_id, &child.scope_id] {
        for tool in &tools {
            probes.push((scope.clone(), format!("{tool} --version"), true));
        }
    }
    probes.extend([
        (
            child.scope_id.clone(),
            "printf changed > source".into(),
            false,
        ),
        (
            child.scope_id.clone(),
            format!("cat '{}'", outside.path().join("private").display()),
            false,
        ),
        (
            child.scope_id.clone(),
            "node -e 'require(\"node:net\").createServer().listen(0,\"127.0.0.1\")'".into(),
            false,
        ),
    ]);
    let results: Vec<_> = stream::iter(probes)
        .map(|(scope, code, allowed)| {
            let client = client.clone();
            async move {
                let process = client
                    .start(StartProcess {
                        operation_id: client.operation_id(),
                        scope_id: scope,
                        argv: vec!["/bin/sh".into(), "-c".into(), code.clone()],
                        cwd: "workspace://repo".into(),
                        env: Default::default(),
                        tty: false,
                        pipe_stdin: false,
                        limits: LimitRequest {
                            wall_time_ms: Some(10_000),
                            ..Default::default()
                        },
                    })
                    .await
                    .unwrap();
                let result = client.wait(&process.process_id).await.unwrap();
                if allowed && result.exit_code != Some(0) {
                    let output: serde_json::Value = client
                        .call(
                            "output.read",
                            serde_json::json!({"processId":process.process_id,"maxBytes":8192}),
                        )
                        .await
                        .unwrap();
                    eprintln!("failed-output {code:?} {output}");
                }
                eprintln!(
                    "probe={code:?} allowed={allowed} exit={:?} cleanup={}",
                    result.exit_code, result.cleanup_confirmed
                );
                (code, allowed, result)
            }
        })
        .buffer_unordered(4)
        .collect()
        .await;
    client.shutdown().await.unwrap();
    for (code, allowed, result) in results {
        assert_eq!(result.exit_code == Some(0), allowed, "{code}: {result:?}");
        assert!(result.cleanup_confirmed);
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("source")).unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn trusted_launch_inherits_only_granted_network_and_child_scopes_can_deny_it() {
    for network in [NetworkRequest::Deny, NetworkRequest::Inherit] {
        let dir = tempfile::tempdir().unwrap();
        let binary = std::path::Path::new(env!("CARGO_BIN_EXE_areal-runtime"));
        let helper = binary.with_file_name("areal-runtime-fs");
        let client = areal_runtime_client::Client::launch_with_environment(
            binary,
            &helper,
            dir.path(),
            true,
            &Limits::default(),
            "/usr/bin:/bin",
            network,
        )
        .await
        .unwrap();
        assert_eq!(
            client.info().capabilities["rootNetwork"],
            serde_json::to_value(network).unwrap()
        );
        for narrowed in [false, true] {
            let scope = client
                .create_scope(CreateScope {
                    operation_id: client.operation_id(),
                    parent_scope_id: client.info().root_scope_id.clone(),
                    owner: Owner {
                        task_id: "network-boundary".into(),
                        plugin_instance_id: None,
                    },
                    permissions: PermissionRequest {
                        network: if narrowed {
                            NetworkRequest::Deny
                        } else {
                            NetworkRequest::Inherit
                        },
                        ..Default::default()
                    },
                    limits: LimitRequest::default(),
                })
                .await
                .unwrap();
            let process = client
                .start(StartProcess {
                    operation_id: client.operation_id(),
                    scope_id: scope.scope_id,
                    argv: vec![
                        "/usr/bin/python3".into(),
                        "-I".into(),
                        "-B".into(),
                        "-c".into(),
                        "import socket,sys\ntry:\n with socket.socket() as s: s.bind(('127.0.0.1',0))\nexcept PermissionError: sys.exit(42)".into(),
                    ],
                    cwd: "workspace://repo".into(),
                    env: Default::default(),
                    tty: false,
                    pipe_stdin: false,
                    limits: LimitRequest::default(),
                })
                .await
                .unwrap();
            let result = client.wait(&process.process_id).await.unwrap();
            let allowed = network == NetworkRequest::Inherit && !narrowed;
            assert_eq!(
                result.exit_code,
                Some(if allowed { 0 } else { 42 }),
                "network={network:?}, narrowed={narrowed}, result={result:?}"
            );
        }
        client.shutdown().await.unwrap();
    }
}

// End-to-end contract: the public client/daemon admission reaches the native
// sandbox, and a same-task ordinary command can release two concurrent hooks.
#[tokio::test]
async fn native_hook_group_allows_progress_without_releasing_foreign_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(target_os = "macos")]
    let mut command = {
        // 与产品启动桥接一致，由系统父进程启动本地原生程序，保留原退出状态和管道。
        let mut command = Command::new("/usr/bin/python3");
        command.args(["-I", "-S", "-c", "import subprocess,sys; r=subprocess.run(sys.argv[1:]).returncode; sys.exit(r if r>=0 else 128-r)"]);
        command.arg(env!("CARGO_BIN_EXE_areal-runtime"));
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(env!("CARGO_BIN_EXE_areal-runtime"));
    let mut daemon = command
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
