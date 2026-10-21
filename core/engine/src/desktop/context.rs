use super::*;
impl Engine {
    pub async fn context_read(
        &self,
        thread_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Value> {
        if limit == 0 || limit > 32 {
            return Err(invalid("context page limit must be 1..32"));
        }
        let cell = self.raw_cell(thread_id).await?;
        let thread = cell.state.lock().await.thread.clone();
        // 查看已有上下文不要求模型凭据当前可用；无法解析时只省略预算诊断。
        let model = self
            .configured_model(
                &thread
                    .turns
                    .last()
                    .and_then(|t| t.configuration.clone())
                    .unwrap_or_default(),
            )
            .ok();
        let overhead = self
            .recorded_context_overhead(&cell, &thread)
            .await
            .map_err(invalid)?;
        let messages = history(&thread, &self.store).map_err(invalid)?;
        let budget = model.as_ref().and_then(|model| {
            crate::context::ContextBudget::resolve(&self.limits, model.as_ref()).ok().map(|budget| {
                json!({"windowTokens":budget.window,"outputReserveTokens":budget.reserve,"inputLimitTokens":budget.input_limit,"targetTokens":budget.target,"outputLimitTokens":model.capabilities().max_output_tokens,"historyEstimatedTokens":crate::context::estimate_tokens(&messages),"estimatedInputTokens":crate::context::estimate_tokens(&messages).saturating_add(overhead),"estimateScope":"historyWithRecordedInstructionsAndCurrentTools","retentionStrategy":if self.limits.context_recent_tokens > 0 || self.limits.context_recent_bytes > 0 {"legacyRecentBoundary"}else{"automatic"},"windowSource":if model.capabilities().context_window_tokens.is_some(){"model"}else{"fallback"}})
            })
        });
        if offset > messages.len() {
            return Err(invalid("context offset exceeds message count"));
        }
        let data:Vec<_>=messages.iter().skip(offset).take(limit).map(|m|json!({"role":m.role,"text":m.text_content(),"toolCalls":m.tool_calls,"toolCallId":m.tool_call_id,"opaqueProviderContextOmitted":m.provider_context.is_some(),"media":m.content.iter().filter_map(|p|match p{model::ContentPart::Image{..}=>Some("image"),model::ContentPart::Audio{..}=>Some("audio"),model::ContentPart::File{..}=>Some("file"),_=>None}).collect::<Vec<_>>()})).collect();
        Ok(
            json!({"threadId":thread_id,"view":"historyProjectionForNextRequest","budget":budget,"systemInstructionsIncluded":thread.turns.last().is_some_and(|t|t.instruction_snapshot.is_some()),"instructionSnapshot":thread.turns.last().and_then(|t|t.instruction_snapshot.as_ref()),"checkpoint":thread.context_checkpoint,"offset":offset,"nextOffset":(offset+data.len()<messages.len()).then_some(offset+data.len()),"data":data}),
        )
    }
    pub async fn context_compact(self: &Arc<Self>, thread_id: String) -> Result<Value> {
        self.context_compact_owned(String::new(), thread_id).await
    }
    pub async fn context_compact_owned(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
    ) -> Result<Value> {
        if !self.limits.context_compaction_enabled {
            return Err(Error::Invalid("context compaction is disabled".into()));
        }
        self.mutate(move |engine| async move {
            if !engine.accepting_work() {
                return Err(Error::Closed);
            }
            let admission = engine.desktop.lifecycle.gate.lock().await;
            if !engine.accepting_work() {
                return Err(Error::Closed);
            }
            let cell = engine.cell(&thread_id).await?;
            let cancel = engine.shutdown.child_token();
            if cell.state.lock().await.thread.is_side() {
                return Err(invalid("SIDE_POLICY_VIOLATION"));
            }
            {
                let mut state = cell.state.lock().await;
                engine.ensure_hook_session_open(&cell, &state.thread)?;
                if state.active.is_some()
                    || state.compacting
                    || state
                        .thread
                        .goals
                        .goal
                        .as_ref()
                        .is_some_and(|g| g.status == areal_protocol::goals::GoalStatus::Active)
                {
                    return Err(Error::Conflict);
                }
                state.compacting = true;
                let activation = id();
                state.compaction_owner = Some(crate::desktop::mcp_apps::CallOwner {
                    token: activation.clone(),
                    scope: crate::desktop::mcp_apps::CallOwnerScope::CompactionHook { activation },
                    cancellation: cancel.clone(),
                    identity,
                    thread: thread_id.clone(),
                    turn: String::new(),
                    call: String::new(),
                    instance: None,
                });
            }
            drop(admission);
            let result = async {
                // 模型容量在实际摘要请求内统一取得；入口再次取同一许可会在容量为 1 时自锁。
                let thread = cell.state.lock().await.thread.clone();
                let overhead = engine
                    .recorded_context_overhead(&cell, &thread)
                    .await
                    .map_err(invalid)?;
                engine
                    .compact_context_with_trigger(&cell, &cancel, overhead, None, true, "manual")
                    .await
                    .map_err(invalid)
            }
            .await;
            {
                let mut state = cell.state.lock().await;
                cancel.cancel();
                state.compaction_owner = None;
                state.compacting = false;
            }
            engine.goals.request(&cell.id);
            result?;
            engine.context_read(&thread_id, 0, 16).await
        })
        .await
    }
}
