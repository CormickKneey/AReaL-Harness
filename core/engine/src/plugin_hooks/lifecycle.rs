use super::*;
impl Engine {
    pub(crate) async fn plugin_hooks_before_turn(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        cancel: &CancellationToken,
    ) -> anyhow::Result<()> {
        self.drain_hook_results(cell, true).await?;
        if cell.hooks.child_start.swap(false, Ordering::AcqRel) {
            self.plugin_hook_event(
                cell,
                HookEvent::SubagentStart,
                json!({"agent_type":"default"}),
                cancel,
            )
            .await?;
        }
        let sources = std::mem::take(&mut *cell.hooks.pending.lock().await);
        for source in sources {
            let effects = self
                .plugin_hook_event(
                    cell,
                    HookEvent::SessionStart,
                    json!({"source":source}),
                    cancel,
                )
                .await?;
            if effects.stop.is_some() {
                anyhow::bail!("SessionStart hook stopped sampling");
            }
        }
        let (prompt, is_user) = {
            let state = cell.state.lock().await;
            let active = state.active.as_ref().unwrap();
            (
                state
                    .thread
                    .turns
                    .last()
                    .unwrap()
                    .items
                    .iter()
                    .find_map(|item| {
                        if let Item::UserMessage { content, .. } = item {
                            Some(
                                content
                                    .iter()
                                    .map(Input::as_text)
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            )
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default(),
                active.hook_user_input
                    && active.direct_tool.is_none()
                    && state.thread.parent_thread_id.is_none()
                    && state.thread.source != "nativeTaskAgent"
                    && !cell.research,
            )
        };
        cell.hooks.started.store(true, Ordering::Release);
        cell.hooks.stop_active.store(false, Ordering::Release);
        if is_user {
            let effects = self
                .plugin_hook_event(
                    cell,
                    HookEvent::UserPromptSubmit,
                    json!({"prompt":prompt}),
                    cancel,
                )
                .await?;
            if effects.stop.is_some() || effects.block.is_some() {
                anyhow::bail!(
                    "UserPromptSubmit hook rejected input: {}",
                    effects.stop.or(effects.block).unwrap_or_default()
                );
            }
        }
        Ok(())
    }
    pub(crate) async fn plugin_hooks_stop(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        cancel: &CancellationToken,
    ) -> anyhow::Result<bool> {
        if self.drain_hook_results(cell, true).await? {
            return Ok(true);
        }
        let last = {
            let state = cell.state.lock().await;
            state.thread.turns.last().and_then(|t| {
                t.items.iter().rev().find_map(|i| {
                    if let Item::AgentMessage { text, .. } = i {
                        Some(text.clone())
                    } else {
                        None
                    }
                })
            })
        };
        let event = if cell.state.lock().await.thread.parent_thread_id.is_some() {
            HookEvent::SubagentStop
        } else {
            HookEvent::Stop
        };
        let mut input = json!({"stop_hook_active":cell.hooks.stop_active.load(Ordering::Acquire),"last_assistant_message":last});
        if event == HookEvent::SubagentStop {
            input["agent_type"] = json!("default");
        }
        let effects = self.plugin_hook_event(cell, event, input, cancel).await?;
        if effects.stop.is_some() || effects.continuation.is_empty() {
            return Ok(false);
        }
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        candidate.turns.last_mut().unwrap().items.push(Item::ModelContext{id:id(),value:json!({"type":"areal_request_context","messages":[{"role":"user","text":format!("hooks.stop.continuation: {}",effects.continuation.join("\n"))}]})});
        self.persist(&candidate).await?;
        state.thread = candidate;
        cell.hooks.stop_active.store(true, Ordering::Release);
        Ok(true)
    }
    pub(crate) async fn plugin_hooks_end(self: &Arc<Self>, cell: &Arc<Cell>) -> anyhow::Result<()> {
        let _end = cell.hooks.end_gate.lock().await;
        if cell.hooks.ended.load(Ordering::Acquire) {
            return Ok(());
        }
        cell.hooks.closing.store(true, Ordering::Release);
        cell.hooks.cancel.cancel();
        // Cancel accepted background work, then join; never abort/drop cleanup futures.
        cell.hooks.tasks.close();
        cell.hooks.tasks.wait().await;
        let result = if cell.hooks.started.load(Ordering::Acquire)
            && cell.state.lock().await.thread.parent_thread_id.is_none()
        {
            self.plugin_hook_event(
                cell,
                HookEvent::SessionEnd,
                json!({"reason":"other"}),
                &CancellationToken::new(),
            )
            .await
            .map(|_| ())
        } else {
            Ok(())
        };
        cell.hooks.tasks.close();
        cell.hooks.tasks.wait().await;
        let task_cleanup = self.close_hook_task_scope(cell).await;
        cell.hooks.ended.store(true, Ordering::Release);
        result.and(task_cleanup)
    }
    pub(crate) async fn plugin_hooks_user_input(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        input: &[Input],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let prompt = input
            .iter()
            .map(Input::as_text)
            .collect::<Vec<_>>()
            .join("\n");
        let effects = self
            .plugin_hook_event(
                cell,
                HookEvent::UserPromptSubmit,
                json!({"prompt":prompt}),
                cancel,
            )
            .await
            .map_err(invalid)?;
        if let Some(reason) = effects.block.or(effects.stop) {
            return Err(invalid(format!(
                "UserPromptSubmit hook rejected input: {reason}"
            )));
        }
        Ok(())
    }
}
