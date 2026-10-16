//! Leaf execution only. Admission, trust and lifecycle receipts belong to the parent.
//! Acceptance failures to exercise with real Runtime/MCP fixtures before integration:
//! EOF-reading stdin; split UTF-8/output gaps and budget overflow; timeout/cancellation
//! with descendants; start/cleanup ambiguity (never replay); package root mutation;
//! deployment-denied roots; stale MCP generations and elicitation-paused deadlines.
use super::BoundHook;
use crate::{Cell, Engine};
use anyhow::{Context, Result, ensure};
use areal_plugins::hooks::HookHandler;
use areal_runtime_protocol as rt;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

const INPUT_LIMIT: usize = 1024 * 1024;
const OUTPUT_LIMIT: usize = 256 * 1024;

pub(super) struct RawOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub operation_id: Option<String>,
    pub outcome: String,
}
impl RawOutput {
    fn new(outcome: &str, operation: Option<String>) -> Self {
        Self {
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            operation_id: operation,
            outcome: outcome.into(),
        }
    }
}

pub(super) async fn run(
    engine: &Arc<Engine>,
    cell: &Arc<Cell>,
    hook: &BoundHook,
    input: &Value,
    cancel: &CancellationToken,
) -> Result<RawOutput> {
    ensure!(!cancel.is_cancelled(), "hook cancelled before admission");
    // Tokio's writer preference makes even nested read admission unsafe. Synchronous
    // tool events inherit the caller's admission; async events always own their lease.
    let active_exclusive = cell
        .state
        .lock()
        .await
        .active
        .as_ref()
        .is_some_and(|a| a.workspace_exclusive);
    let caller_admitted = !hook.definition.r#async && (active_exclusive || hook.caller_admitted);
    let _workspace = if caller_admitted {
        None
    } else {
        Some(tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("hook cancelled before workspace admission"),
            guard = engine.workspace_gate.clone().read_owned() => guard,
        })
    };
    super::ensure_current(engine, cell, hook).await?;
    ensure!(!cancel.is_cancelled(), "hook cancelled before execution");
    match &hook.definition.handler {
        HookHandler::Command {
            command,
            command_windows,
        } => {
            let command = if cfg!(windows) {
                command_windows.as_deref().unwrap_or(command)
            } else {
                command
            };
            command_run(engine, cell, hook, input, command, cancel).await
        }
        HookHandler::Mcp { server, tool, .. } => {
            let arguments = hook.definition.handler.render_input(input)?;
            ensure!(
                serde_json::to_vec(&arguments)?.len() <= INPUT_LIMIT,
                "MCP hook input exceeds budget"
            );
            let tool = engine
                .plugin_hook_mcp_tool(&hook.plugin_id, &hook.package_digest, server, tool)?
                .with_timeout_limit(Duration::from_secs(hook.definition.timeout_secs));
            let meta = serde_json::from_value(json!({"threadId":cell.id}))?;
            let lease = super::mcp_owner(engine, cell, hook, &tool, cancel).await?;
            // RequestChannel owns timeout accounting, including paused elicitation.
            // No reconnect, approval recursion or transport retry is performed here.
            let result = tool
                .call_raw_owned(
                    arguments,
                    Some(meta),
                    cancel.child_token(),
                    Some(&lease.context),
                )
                .await;
            lease.close().await;
            let mut output = RawOutput::new("unknown", None);
            match result {
                Err(_) => {
                    output.stderr = "MCP hook did not return a confirmed result; no replay".into()
                }
                Ok(result) => {
                    output.outcome = if result.is_error == Some(true) {
                        "failed"
                    } else {
                        "succeeded"
                    }
                    .into();
                    output.exit_code = Some(if result.is_error == Some(true) { 1 } else { 0 });
                    let value = serde_json::to_value(result)?;
                    if let Some(content) = value["content"].as_array() {
                        for part in content {
                            if part["type"] == "text"
                                && let Some(text) = part["text"].as_str()
                            {
                                if output
                                    .stdout
                                    .len()
                                    .saturating_add(text.len())
                                    .saturating_add(1)
                                    > OUTPUT_LIMIT
                                {
                                    output.outcome = "failed".into();
                                    output.exit_code = None;
                                    output.stdout.clear();
                                    output.stderr = "MCP hook output exceeds budget".into();
                                    break;
                                }
                                if !output.stdout.is_empty() {
                                    output.stdout.push('\n');
                                }
                                output.stdout.push_str(text);
                            }
                        }
                    }
                }
            }
            Ok(output)
        }
    }
}

// Store roots are canonical when bound. Never turn a redirected data directory
// into a new write grant by canonicalizing it at execution time. A missing leaf
// may be created by the hook under its existing, fixed data parent.
fn read_only_data_uri(path: &Path, runtime: &crate::tools::RuntimeConfig) -> Result<String> {
    ensure!(
        !path.starts_with(&runtime.workspace) && !runtime.workspace.starts_with(path),
        "read-only hook data cannot overlap task workspace"
    );
    let parent = path.parent().context("hook data has no parent")?;
    ensure!(
        path.is_absolute() && parent.canonicalize()? == parent && parent.is_dir(),
        "read-only hook data parent was redirected"
    );
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => ensure!(
            metadata.is_dir() && path.canonicalize()? == path,
            "read-only hook data was redirected"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    areal_plugins::prepare_data_directory(path)?;
    let data = path.to_str().context("hook data root is not UTF-8")?;
    if runtime.client.info().capabilities["fullAccess"] == true
        && !path.starts_with(&runtime.workspace)
        && !runtime
            .command_scratch
            .as_ref()
            .is_some_and(|root| !root.starts_with(&runtime.workspace) && path.starts_with(root))
    {
        // Keep the reviewed literal identity. Native sandbox execution rejects
        // redirected grants; it must not receive their newly resolved target.
        Ok(format!("workspace://host{data}"))
    } else {
        crate::tools::resource_uri(data, runtime)
    }
}

async fn command_run(
    engine: &Arc<Engine>,
    cell: &Arc<Cell>,
    hook: &BoundHook,
    input: &Value,
    command: &str,
    cancel: &CancellationToken,
) -> Result<RawOutput> {
    let runtime = engine.runtime.as_ref().context("hooks require Runtime")?;
    let client = &runtime.client;
    if hook.read_only {
        ensure!(
            client.info().capabilities["restrictedScopeIsolation"] == true,
            "read-only hooks require confirmed native Scope isolation; no fallback"
        );
        ensure!(
            matches!(hook.definition.handler, HookHandler::Command { .. }),
            "read-only consent excludes MCP handlers"
        );
    }
    let cwd = cell.state.lock().await.thread.cwd.clone();
    let cwd_uri = crate::tools::resource_uri(&cwd, runtime)?;
    let root = hook.root.to_str().context("plugin root is not UTF-8")?;
    let data = hook
        .data_root
        .to_str()
        .context("plugin data root is not UTF-8")?;
    let root_uri = crate::tools::resource_uri(root, runtime)?;
    let data_uri = if hook.read_only && hook.packaged {
        read_only_data_uri(&hook.data_root, runtime)?
    } else {
        crate::tools::resource_uri(data, runtime)?
    };
    let mut input = serde_json::to_vec(input)?;
    ensure!(input.len() < INPUT_LIMIT, "hook stdin exceeds budget");
    input.push(b'\n');
    let env: BTreeMap<String, String> = if hook.packaged {
        [
            ("PLUGIN_ROOT", root),
            ("PLUGIN_DATA", data),
            ("CLAUDE_PLUGIN_ROOT", root),
            ("CLAUDE_PLUGIN_DATA", data),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect()
    } else {
        BTreeMap::new()
    };
    let command = env
        .iter()
        .fold(command.to_owned(), |command, (key, value)| {
            command.replace(&format!("${{{key}}}"), value)
        });
    let parent = match engine.runtime_task_parent(cell).await {
        Ok(parent) => parent,
        Err(error) if uncertain(&error) => {
            let operation = engine
                .hook_task_unknown(cell)
                .await
                .and_then(|v| v["operationId"].as_str().map(str::to_owned));
            return Ok(RawOutput::new("unknown", operation));
        }
        Err(error) => return Err(error.into()),
    };
    let parent_info: rt::ScopeInfo = client.call("scope.get", json!({"scopeId":parent})).await?;
    let wall_ms = hook
        .definition
        .timeout_secs
        .saturating_mul(1000)
        .min(parent_info.limits.wall_time_ms);
    let output_limit = (OUTPUT_LIMIT as u64).min(parent_info.limits.output_bytes);
    let mut permissions = engine.active_permissions(cell).await?;
    if hook.read_only {
        // Build the capability explicitly rather than inheriting broad launcher
        // roots. The task anchor supplies identity only, never execution grants.
        let mut reads = vec!["workspace://repo".into()];
        let mut writes = Vec::new();
        if runtime.command_scratch.is_some() {
            let scratch = engine.scratch_uri(cell);
            reads.push(scratch.clone());
            writes.push(scratch);
        }
        if hook.packaged {
            reads.extend([root_uri.clone(), data_uri.clone()]);
            writes.push(data_uri.clone());
        }
        permissions = rt::PermissionRequest {
            read_roots: Some(reads),
            write_roots: Some(writes),
            network: rt::NetworkRequest::Deny,
        };
    } else {
        if permissions.read_roots.is_none() {
            permissions.read_roots = Some(parent_info.read_roots.clone());
        }
        if permissions.write_roots.is_none() {
            let mut roots = if runtime.writable {
                vec!["workspace://repo".into()]
            } else {
                vec![]
            };
            if runtime.command_scratch.is_some() {
                roots.push(engine.scratch_uri(cell));
            }
            permissions.write_roots = Some(roots);
        }
        if let Some(reads) = &mut permissions.read_roots
            && hook.packaged
        {
            reads.extend([root_uri.clone(), data_uri.clone()]);
        }
        if hook.packaged {
            permissions
                .write_roots
                .as_mut()
                .unwrap()
                .push(data_uri.clone());
        }
    }
    let writes = permissions.write_roots.as_ref().unwrap();
    // A read grant cannot subtract a covering write grant. Reject that layout instead
    // of describing the installed package as immutable while granting writes to it.
    for write in writes.iter().filter(|_| hook.packaged) {
        ensure!(
            !write_contains_package(write, &hook.root, runtime)?,
            "hook package overlaps a writable root"
        );
    }
    super::ensure_current(engine, cell, hook).await?;
    ensure!(
        !cancel.is_cancelled(),
        "hook cancelled before Runtime scope admission"
    );
    let create_operation = client.operation_id();
    let scope = match client
        .create_participant_scope(rt::CreateParticipantScope {
            authority_scope_id: client.info().root_scope_id.clone(),
            participation: rt::ScopeParticipation::Hook {
                task_scope_id: parent.clone(),
            },
            scope: rt::CreateScope {
                operation_id: create_operation.clone(),
                parent_scope_id: parent,
                owner: rt::Owner {
                    task_id: cell.id.clone(),
                    plugin_instance_id: Some(format!(
                        "hook:{}:{}:{}",
                        hook.plugin_id, hook.package_digest, cell.id
                    )),
                },
                permissions,
                limits: rt::LimitRequest {
                    output_bytes: Some(output_limit),
                    max_processes: Some(1),
                    ..Default::default()
                },
            },
        })
        .await
    {
        Ok(scope) => scope,
        Err(error) if uncertain(&error) => {
            let mut output = RawOutput::new("unknown", Some(create_operation));
            output.stderr = "Runtime hook scope admission is unknown; no replay".into();
            return Ok(output);
        }
        Err(error) => return Err(error.into()),
    };
    let operation = client.operation_id();
    let mut output = RawOutput::new("failed", Some(operation.clone()));
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let timeout = Duration::from_millis(wall_ms);
    let execution = async {
        let argv = if cfg!(windows) {
            vec![
                "cmd.exe".into(),
                "/D".into(),
                "/S".into(),
                "/C".into(),
                command,
            ]
        } else {
            vec!["/bin/sh".into(), "-lc".into(), command]
        };
        let process = client
            .start(rt::StartProcess {
                operation_id: operation.clone(),
                scope_id: scope.scope_id.clone(),
                argv,
                cwd: cwd_uri,
                env,
                tty: false,
                pipe_stdin: true,
                limits: rt::LimitRequest {
                    wall_time_ms: Some(wall_ms),
                    output_bytes: Some(output_limit),
                    ..Default::default()
                },
            })
            .await?;
        let send = async {
            for chunk in input.chunks(16 * 1024) {
                client
                    .write(rt::ProcessInput {
                        operation_id: client.operation_id(),
                        process_id: process.process_id.clone(),
                        data_base64: STANDARD.encode(chunk),
                    })
                    .await?;
            }
            client
                .close_stdin(rt::CloseStdin {
                    operation_id: client.operation_id(),
                    process_id: process.process_id.clone(),
                })
                .await?;
            Ok::<_, anyhow::Error>(())
        };
        let receive = async {
            let mut cursor = None;
            loop {
                let page = client
                    .output(rt::ReadOutput {
                        process_id: process.process_id.clone(),
                        after: cursor,
                        max_bytes: 32 * 1024,
                        wait_ms: 100,
                    })
                    .await?;
                ensure!(!page.gap && !page.truncated, "hook output is incomplete");
                for chunk in page.chunks {
                    let bytes = STANDARD.decode(chunk.data_base64)?;
                    ensure!(
                        stdout.len() + stderr.len() + bytes.len() <= OUTPUT_LIMIT,
                        "hook output exceeds budget"
                    );
                    if chunk.stream == rt::OutputStream::Stderr {
                        stderr.extend(bytes);
                    } else {
                        stdout.extend(bytes);
                    }
                }
                cursor = Some(page.next_cursor);
                if page.closed {
                    break;
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::try_join!(send, receive)?;
        let process = client.wait(&process.process_id).await?;
        Ok::<_, anyhow::Error>(process)
    };
    let result = tokio::select! { biased;
        _=cancel.cancelled()=>{output.outcome="cancelled".into();None},
        result=tokio::time::timeout(timeout,execution)=>match result {
            Ok(result)=>Some(result), Err(_)=>{output.outcome="timedOut".into();None}
        }
    };
    match result {
        Some(Ok(process)) => {
            output.exit_code = process.exit_code;
            output.outcome =
                if process.state == rt::ProcessState::Unknown || process.cleanup_error.is_some() {
                    "unknown"
                } else if process.stop_reason.as_deref() == Some("wallTimeMs exceeded") {
                    "timedOut"
                } else if process.exit_code == Some(0)
                    && !process.sandbox_denied
                    && process.stop_reason.is_none()
                {
                    "succeeded"
                } else {
                    "failed"
                }
                .into();
        }
        Some(Err(error)) => {
            output.outcome = if error.downcast_ref::<rt::Error>().is_some_and(uncertain) {
                "unknown"
            } else {
                "failed"
            }
            .into();
            // Diagnostic text is private receipt data; do not echo stdin or environment.
            output.stderr = "Runtime hook execution failed; no replay".into();
        }
        None => {}
    }
    output.stdout = String::from_utf8_lossy(&stdout).into_owned();
    if output.stderr.is_empty() {
        output.stderr = String::from_utf8_lossy(&stderr).into_owned();
    }
    // Await cleanup outside the cancellation/timeout branch. A cancelled wait is not
    // evidence that descendants stopped, and cleanup failure overrides every outcome.
    match client.close_scope(&scope.scope_id).await {
        Ok(closed)
            if closed.state == rt::ScopeState::Closed
                && closed.active_processes == 0
                && closed.cleanup_error.is_none() => {}
        _ => {
            output.outcome = "unknown".into();
            output.exit_code = None;
            output.stderr = "Runtime hook cleanup is unconfirmed; no replay".into();
        }
    }
    Ok(output)
}
pub(super) fn uncertain(error: &rt::Error) -> bool {
    matches!(
        error.code,
        rt::ErrorCode::Unavailable | rt::ErrorCode::StaleHandle | rt::ErrorCode::CleanupFailed
    )
}
fn write_contains_package(
    root: &str,
    package: &std::path::Path,
    runtime: &crate::tools::RuntimeConfig,
) -> Result<bool> {
    let resolve = |prefix: &str, base: &std::path::Path| -> Option<std::path::PathBuf> {
        if root == prefix {
            Some(base.to_owned())
        } else {
            root.strip_prefix(&format!("{prefix}/"))
                .map(|tail| base.join(tail))
        }
    };
    let path = resolve("workspace://repo", &runtime.workspace)
        .or_else(|| {
            runtime
                .command_scratch
                .as_ref()
                .and_then(|base| resolve("workspace://scratch", base))
        })
        .or_else(|| {
            root.strip_prefix("workspace://host/")
                .map(|tail| std::path::Path::new("/").join(tail))
        })
        .context("unsupported hook write root")?;
    Ok(package.canonicalize()?.starts_with(path.canonicalize()?))
}
