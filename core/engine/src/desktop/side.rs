use super::*;

impl Engine {
    pub async fn side_context_read(&self, thread_id: &str, evidence_ref: Option<String>, cursor: Option<String>, max_bytes: Option<usize>) -> Result<Value> {
        if evidence_ref.is_some() && cursor.is_some() { return Err(invalid("evidenceRef and cursor are mutually exclusive")); }
        let max_bytes = max_bytes.unwrap_or(8192);
        if !(64..=16384).contains(&max_bytes) { return Err(invalid("maxBytes must be 64..16384")); }
        let thread = self.read(thread_id, false).await?;
        let Some(areal_protocol::Conversation::Side { reference_snapshot, .. }) = thread.conversation else {
            return Err(invalid("SIDE_POLICY_VIOLATION"));
        };
        let snapshot = reference_snapshot.snapshot_id;
        let decode = |value: &str, with_offset: bool| -> Result<(usize, usize)> {
            let (prefix, tail) = value.rsplit_once(':').ok_or_else(|| invalid("invalid evidence cursor"))?;
            let (id, index, offset) = if with_offset {
                let (id, index) = prefix.rsplit_once(':').ok_or_else(|| invalid("invalid evidence cursor"))?;
                (id, index, tail.parse::<usize>().map_err(invalid)?)
            } else { (prefix, tail, 0) };
            if id != snapshot { return Err(invalid("invalid evidence cursor")); }
            Ok((index.parse().map_err(invalid)?, offset))
        };
        let (index, offset) = if let Some(value) = &evidence_ref { decode(value, false)? }
            else if let Some(value) = &cursor { decode(value, true)? } else { (0, 0) };
        let (turns, source_ids) = self.store.read_fork_snapshot_with_sources(&snapshot).map_err(|e| Error::Storage(e.to_string()))?;
        let entries: Vec<Value> = turns.into_iter().zip(source_ids).flat_map(|(turn, source)| turn.items.into_iter().map(move |item| {
            json!({"sourceThreadId":source,"sourceTurnId":turn.id,"sourceItemId":item.id(),"sourceTurnStatus":turn.status,"item":item})
        })).collect();
        if index > entries.len() || index == entries.len() && offset != 0 { return Err(invalid("invalid evidence cursor")); }
        if index == entries.len() { return Ok(json!({"snapshotId":snapshot,"evidence":[],"nextCursor":null,"complete":true})); }
        let entry = &entries[index];
        let content = entry["item"].to_string();
        if offset > content.len() || !content.is_char_boundary(offset) { return Err(invalid("invalid evidence cursor")); }
        // JSON 字符串转义会放大输出；保守限制正文，下一页用 UTF-8 字节位置续读。
        let excerpt = crate::tools::prefix(&content[offset..], (max_bytes / 4).max(16));
        let next_offset = offset + excerpt.len();
        let next_cursor = if next_offset < content.len() { Some(format!("{}:{}:{}",snapshot,index,next_offset)) }
            else if index + 1 < entries.len() { Some(format!("{}:{}:0",snapshot,index + 1)) } else { None };
        Ok(json!({"snapshotId":snapshot,"evidence":[{"evidenceRef":format!("{}:{}",snapshot,index),
            "sourceTurnId":entry["sourceTurnId"],"sourceItemId":entry["sourceItemId"],
            "sourceTurnStatus":entry["sourceTurnStatus"],"text":excerpt,
            "range":{"startUtf8":offset,"endUtf8":next_offset,"totalBytes":content.len()}}],
            "nextCursor":next_cursor,"complete":next_cursor.is_none()}))
    }
    /// 首问与只读身份在同一持久记录中提交；提交之前不会激活模型。
    pub async fn side_start(self: &Arc<Self>, identity: String, request: SideStart) -> Result<(Thread, Turn)> {
        self.mutate(move |engine| async move {
            let _serial = engine.desktop.creation.lock().await;
            let hash = digest(&request)?;
            let method = "areal/side/start";
            if !valid_id(&request.request_id) { return Err(invalid("invalid requestId")); }
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in cells {
                let state = cell.state.lock().await;
                if let Some(data) = &state.thread.desktop {
                    if let Some(found) = data.receipts.iter().find(|r| r.identity == identity && r.request_id == request.request_id && r.method == method) {
                        if found.digest != hash { return Err(Error::Conflict); }
                        let turn = state.thread.turns.first().cloned().ok_or_else(|| Error::Storage("Side first Turn missing".into()))?;
                        return Ok((state.thread.clone(), turn));
                    }
                }
            }
            if request.workspace_access != "none" { return Err(invalid("WORKSPACE_READ_UNAVAILABLE")); }
            if request.input.len() != 1 || !matches!(&request.input[0], Input::Text { .. }) {
                return Err(invalid("Side first question must be one text input"));
            }
            let source_cell = engine.raw_cell(&request.source_thread_id).await?;
            let source_state = source_cell.state.lock().await;
            if source_state.thread.parent_thread_id.is_some() || source_state.thread.is_side()
                || source_state.thread.desktop.as_ref().is_some_and(|d| d.workflow_run.is_some() || d.archived) {
                return Err(invalid("SOURCE_KIND_UNSUPPORTED"));
            }
            let cwd = source_state.thread.cwd.clone();
            drop(source_state);
            let source = engine.store.read_thread(&request.source_thread_id).await.map_err(|e| Error::Storage(e.to_string()))?;
            let (mut logical, mut source_ids) = match &source.conversation {
                Some(areal_protocol::Conversation::Fork { history_seed, .. }) => engine.store.read_fork_snapshot_with_sources(&history_seed.snapshot_id).map_err(|e| Error::Storage(e.to_string()))?,
                _ => (Vec::new(), Vec::new()),
            };
            source_ids.extend(std::iter::repeat_n(source.id.clone(), source.turns.len()));
            logical.extend(source.turns.iter().cloned());
            let anchor = request.anchor.as_ref();
            let end = match anchor {
                None => logical.len(),
                Some(SideAnchor { kind, .. }) if kind == "latestCommitted" => logical.len(),
                Some(SideAnchor { kind, turn_id: Some(id), boundary: Some(boundary) }) if kind == "turn" => {
                    let index = logical.iter().position(|t| &t.id == id).ok_or_else(|| invalid("ANCHOR_NOT_FOUND"))?;
                    match boundary.as_str() { "before" => index, "after" if logical[index].status == TurnStatus::Completed => index + 1,
                        "after" => return Err(invalid("TURN_NOT_TERMINAL")), _ => return Err(invalid("invalid Side boundary")) }
                }
                _ => return Err(invalid("invalid Side anchor")),
            };
            let prefix = &logical[..end];
            let config = prefix.iter().rev().find_map(|t| t.configuration.clone()).unwrap_or_default();
            if config.profile.as_ref().is_some_and(|p| p.workflow.is_some()) { return Err(invalid("PROFILE_NOT_SUPPORTED")); }
            let mut config = engine.resolve_config(None, request.model.or(config.model),
                request.parameters.unwrap_or(config.parameters), config.revision)?;
            config.profile = None;
            config.read_only = true;
            config.tool_allowlist = Some(vec!["side_context_read".into()]);
            config.instructions.clear();
            config.options.system_prompt = None;
            config.options.append_instructions.clear();
            let model = engine.configured_model(&config).map_err(|_| invalid("MODEL_CONTEXT_INCOMPATIBLE"))?;
            if !model.capabilities().supports_input(areal_protocol::Modality::Text) { return Err(invalid("MODEL_CONTEXT_INCOMPATIBLE")); }
            let limit = if engine.limits.max_history_bytes == 0 { 64 * 1024 * 1024 } else { engine.limits.max_history_bytes.min(64 * 1024 * 1024) };
            let (snapshot_id, logical_bytes) = engine.store.write_fork_snapshot(prefix.to_vec(), source_ids[..end].to_vec(), limit).await.map_err(|e| Error::Storage(e.to_string()))?;
            let thread_id = id();
            let mut data = DesktopState { configuration: config, ..Default::default() };
            remember(&mut data, &identity, &request.request_id, method, hash.clone(), json!({"threadId":thread_id}));
            let origin_turn = match anchor { Some(SideAnchor { kind, turn_id: Some(id), .. }) if kind == "turn" => id.clone(),
                _ => prefix.last().map(|t| t.id.clone()).unwrap_or_default() };
            let boundary = match anchor { Some(SideAnchor { kind, boundary: Some(boundary), .. }) if kind == "turn" => boundary.as_str(),
                _ => "latestCommitted" };
            let base = Thread {
                conversation: Some(areal_protocol::Conversation::Side {
                    version: 1,
                    origin: areal_protocol::ConversationOrigin { source_thread_id: request.source_thread_id,
                        source_turn_id: origin_turn, boundary: boundary.into(), snapshot_id: snapshot_id.clone() },
                    reference_snapshot: areal_protocol::HistorySeed { snapshot_id, turn_count: end,
                        item_count: prefix.iter().map(|t| t.items.len()).sum(), logical_bytes },
                    policy: areal_protocol::SidePolicy { kind: "sideReadOnlyV1".into(), workspace_access: "none".into() },
                }),
                goals: Default::default(), goal_owner: None, desktop: Some(data),
                id: thread_id.clone(), session_id: thread_id.clone(), parent_thread_id: None,
                preview: String::new(), model_provider: engine.model_provider(), created_at: now(), updated_at: now(),
                status: ThreadStatus::Idle, cwd, cli_version: env!("CARGO_PKG_VERSION").into(), source: "appServer".into(),
                ephemeral: false, turns: Vec::new(), history_archive: None, context_checkpoint: None,
                dynamic_tools: Vec::new(), toolset_revision: 0,
            };
            let (thread, turn) = engine.prepare_turn(&base, request.input)?;
            let admission = engine.reserve_active_turn()?;
            let cell = Cell::new(thread.clone(), 0, crate::tools::Bindings { registry: engine.registry.clone().side_only(), host: None });
            let mut threads = engine.threads.write().await;
            if threads.len() >= engine.limits.max_threads { return Err(Error::Exhausted("thread capacity reached".into())); }
            if let Err(error) = engine.persist(&thread).await {
                if let Ok(saved) = engine.store.read_thread(&thread_id).await {
                    if saved.desktop.as_ref().is_some_and(|d| receipt(d, &identity, &request.request_id, method, &hash).ok().flatten().is_some()) {
                        cell.state.lock().await.poisoned = true;
                        threads.insert(thread_id, cell);
                    }
                }
                return Err(error);
            }
            let mut state = cell.state.lock().await;
            engine.activate(&cell, &mut state, &turn, engine.shutdown.child_token(), admission);
            drop(state);
            threads.insert(thread_id, cell);
            Ok((thread, turn))
        }).await
    }
}
