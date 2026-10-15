//! Trusted task ancestry for bounded Runtime hook write groups. Task identity is
//! the validated opaque scope, never the free-form owner task/plugin label.
use super::*;
use anyhow::Context;
use areal_runtime_protocol as rt;

pub(super) enum Anchor {
    Ready(rt::ScopeInfo),
    Unknown {
        operation: Option<String>,
        scope: Option<String>,
        error: rt::Error,
    },
    Closed,
}
impl Engine {
    pub(crate) async fn runtime_task_parent(&self, cell: &Cell) -> rt::Result<String> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| rt::Error::new(rt::ErrorCode::Unavailable, "Runtime unavailable"))?;
        let client = &runtime.client;
        let parent = runtime.command_scope.as_ref().map_or_else(
            || client.info().root_scope_id.clone(),
            |scope| scope.scope_id.clone(),
        );
        let needed = {
            let state = cell.state.lock().await;
            let hooks = state.active.as_ref().map_or_else(
                || self.frozen_plugin_hooks(&state.thread),
                |active| active.hooks.clone(),
            );
            hooks.iter().any(|hook| {
                matches!(
                    hook.definition.handler,
                    areal_plugins::hooks::HookHandler::Command { .. }
                )
            })
        };
        let mut anchor = cell.hooks.task_scope.lock().await;
        match anchor.as_ref() {
            Some(Anchor::Ready(scope)) => return Ok(scope.scope_id.clone()),
            Some(Anchor::Unknown { error, .. }) => return Err(error.clone()),
            Some(Anchor::Closed) => {
                return Err(rt::Error::new(
                    rt::ErrorCode::ScopeClosed,
                    "hook task scope closed",
                ));
            }
            None if !needed => return Ok(parent),
            None => {}
        }
        let info: rt::ScopeInfo = client.call("scope.get", json!({"scopeId":parent})).await?;
        let operation = client.operation_id();
        let result = client
            .create_participant_scope(rt::CreateParticipantScope {
                authority_scope_id: client.info().root_scope_id.clone(),
                scope: rt::CreateScope {
                    operation_id: operation.clone(),
                    parent_scope_id: parent,
                    owner: rt::Owner {
                        task_id: cell.id.clone(),
                        plugin_instance_id: None,
                    },
                    permissions: rt::PermissionRequest::default(),
                    limits: rt::LimitRequest::default(),
                },
                participation: rt::ScopeParticipation::Task {
                    admission_window_ms: info.limits.wall_time_ms.min(60_000),
                },
            })
            .await;
        match result {
            Ok(scope) => {
                let id = scope.scope_id.clone();
                *anchor = Some(Anchor::Ready(scope));
                Ok(id)
            }
            Err(error) if super::runner::uncertain(&error) => {
                *anchor = Some(Anchor::Unknown {
                    operation: Some(operation),
                    scope: None,
                    error: error.clone(),
                });
                drop(anchor);
                cell.state.lock().await.poisoned = true;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }
    pub(crate) async fn hook_task_unknown(&self, cell: &Cell) -> Option<Value> {
        let anchor = cell.hooks.task_scope.lock().await;
        match anchor.as_ref() {
            Some(Anchor::Unknown {
                operation, scope, ..
            }) => Some(
                json!({"threadId":cell.id,"kind":"hookTaskScope","operationId":operation,"scopeId":scope}),
            ),
            _ => None,
        }
    }
    pub(super) async fn close_hook_task_scope(&self, cell: &Cell) -> anyhow::Result<()> {
        let mut anchor = cell.hooks.task_scope.lock().await;
        let scope = match anchor.as_ref() {
            Some(Anchor::Ready(scope)) => scope.scope_id.clone(),
            Some(Anchor::Unknown { .. }) => {
                anyhow::bail!("UNKNOWN Runtime hook task scope; no replay")
            }
            _ => return Ok(()),
        };
        let client = &self.runtime.as_ref().context("Runtime unavailable")?.client;
        match client.close_scope(&scope).await {
            Ok(closed)
                if closed.state == rt::ScopeState::Closed
                    && closed.active_processes == 0
                    && closed.cleanup_error.is_none() =>
            {
                *anchor = Some(Anchor::Closed);
                Ok(())
            }
            _ => {
                *anchor = Some(Anchor::Unknown {
                    operation: None,
                    scope: Some(scope),
                    error: rt::Error::new(
                        rt::ErrorCode::CleanupFailed,
                        "Runtime hook task scope cleanup unconfirmed",
                    ),
                });
                drop(anchor);
                cell.state.lock().await.poisoned = true;
                anyhow::bail!("UNKNOWN Runtime hook task scope cleanup; no replay")
            }
        }
    }
}
