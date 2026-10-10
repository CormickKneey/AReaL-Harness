use super::*;

impl Engine {
    /// Fork 持有已提交前缀的不可变副本；创建不激活 Turn，也不继承来源执行绑定。
    pub async fn fork_thread(self: &Arc<Self>, identity: String, request: ForkThread) -> Result<Thread> {
        self.mutate(move |engine| async move {
            let _serial = engine.desktop.creation.lock().await;
            let hash = digest(&request)?;
            let method = "areal/thread/fork";
            if !valid_id(&request.request_id) {
                return Err(invalid("requestId must be 1..128 ASCII identifier characters"));
            }
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in cells {
                let state = cell.state.lock().await;
                if let Some(data) = &state.thread.desktop {
                    if let Some(found) = data.receipts.iter().find(|record| {
                        record.identity == identity && record.request_id == request.request_id && record.method == method
                    }) {
                        if found.digest != hash { return Err(Error::Conflict); }
                        return Ok(state.thread.clone());
                    }
                }
            }
            if request.workspace_mode != "sharedCurrent" || request.anchor.boundary != "after" {
                return Err(invalid("SCF-01 supports only after and sharedCurrent"));
            }
            let source_cell = engine.raw_cell(&request.source_thread_id).await?;
            let source_state = source_cell.state.lock().await;
            if source_state.thread.parent_thread_id.is_some() || source_state.thread.conversation.is_some()
                || source_state.thread.history_archive.is_some() || source_state.thread.context_checkpoint.is_some()
                || source_state.thread.desktop.as_ref().is_some_and(|d| d.workflow_run.is_some() || d.archived) {
                return Err(invalid("SOURCE_KIND_UNSUPPORTED"));
            }
            let source_cwd = source_state.thread.cwd.clone();
            drop(source_state);
            // 固定读取一份已提交记录；流式状态和来源 checkpoint 不进入历史种子。
            let source = engine.store.read_thread(&request.source_thread_id).await
                .map_err(|e| Error::Storage(e.to_string()))?;
            let Some(last) = source.turns.last() else { return Err(invalid("ANCHOR_NOT_FOUND")); };
            if last.id != request.anchor.turn_id { return Err(invalid("ANCHOR_NOT_FOUND")); }
            if last.status != TurnStatus::Completed { return Err(invalid("TURN_NOT_TERMINAL")); }
            if source.turns.iter().any(|turn| turn.status != TurnStatus::Completed) { return Err(invalid("HISTORY_UNRESOLVED")); }
            if source.turns.iter().flat_map(|t| &t.items).any(|item| !match item {
                Item::UserMessage { content, .. } => content.iter().all(|i| matches!(i, Input::Text { .. })),
                Item::AgentMessage { .. } => true,
                _ => false,
            }) {
                return Err(invalid("HISTORY_UNRESOLVED"));
            }
            let config = last.configuration.clone().or_else(|| source.desktop.as_ref().map(|d| d.configuration.clone())).unwrap_or_default();
            if config.profile.as_ref().is_some_and(|p| p.workflow.is_some()) { return Err(invalid("PROFILE_NOT_SUPPORTED")); }
            let model = engine.configured_model(&config).map_err(|_| invalid("MODEL_CONTEXT_INCOMPATIBLE"))?;
            if !model.capabilities().supports_input(areal_protocol::Modality::Text) { return Err(invalid("MODEL_CONTEXT_INCOMPATIBLE")); }
            let item_count = source.turns.iter().map(|t| t.items.len()).sum();
            let turn_count = source.turns.len();
            #[cfg(test)]
            engine.store.check_fork_fault(crate::store::ForkFault::BeforeSnapshot)?;
            let (snapshot_id, logical_bytes) = engine.store.write_fork_snapshot(source.turns).await
                .map_err(|e| Error::Storage(e.to_string()))?;
            #[cfg(test)]
            engine.store.check_fork_fault(crate::store::ForkFault::AfterSnapshot)?;
            let thread_id = id();
            let mut data = DesktopState { configuration: config, ..Default::default() };
            remember(&mut data, &identity, &request.request_id, method, hash.clone(),
                json!({"threadId":thread_id}));
            let thread = Thread {
                conversation: Some(areal_protocol::Conversation::Fork {
                    version: 1,
                    origin: areal_protocol::ConversationOrigin {
                        source_thread_id: request.source_thread_id,
                        source_turn_id: request.anchor.turn_id,
                        boundary: "after".into(),
                        snapshot_id: snapshot_id.clone(),
                    },
                    history_seed: areal_protocol::HistorySeed { snapshot_id, turn_count, item_count, logical_bytes },
                    workspace_mode: "sharedCurrent".into(),
                }),
                goals: Default::default(), goal_owner: None, desktop: Some(data),
                id: thread_id.clone(), session_id: thread_id.clone(), parent_thread_id: None,
                preview: format!("分支 · {}", source.preview), model_provider: engine.model_provider(),
                created_at: now(), updated_at: now(), status: ThreadStatus::Idle,
                cwd: source_cwd, cli_version: env!("CARGO_PKG_VERSION").into(), source: "appServer".into(),
                ephemeral: false, turns: Vec::new(), history_archive: None, context_checkpoint: None,
                dynamic_tools: Vec::new(), toolset_revision: 0,
            };
            let cell = Cell::new(thread.clone(), 0, crate::tools::Bindings { registry: engine.registry.clone(), host: None });
            // 容量锁跨越持久提交；read/list 只会看见已经同步完成的目标。
            let mut threads = engine.threads.write().await;
            if threads.len() >= engine.limits.max_threads { return Err(Error::Exhausted("thread capacity reached".into())); }
            if let Err(error) = engine.persist(&thread).await {
                // rename 已完成而目录同步失败时，磁盘可能已有目标。先注册可核对的
                // 完整记录，避免同进程的同键请求再创建第二个目标；原错误仍保持 UNKNOWN。
                if let Ok(saved) = engine.store.read_thread(&thread_id).await {
                    if saved.desktop.as_ref().is_some_and(|data| {
                        receipt(data, &identity, &request.request_id, method, &hash)
                            .ok().flatten().is_some()
                    }) {
                        cell.state.lock().await.poisoned = true;
                        threads.insert(thread_id, cell);
                    }
                }
                return Err(error);
            }
            #[cfg(test)]
            engine.store.check_fork_fault(crate::store::ForkFault::AfterTarget)?;
            threads.insert(thread_id, cell);
            Ok(thread)
        }).await
    }

    pub async fn fork_history(&self, thread_id: &str, cursor: Option<String>, max_bytes: Option<usize>) -> Result<Value> {
        let max_bytes = max_bytes.unwrap_or(65536);
        if !(1..=262144).contains(&max_bytes) { return Err(invalid("maxBytes must be 1..262144")); }
        let thread = self.read(thread_id, false).await?;
        let Some(areal_protocol::Conversation::Fork { origin, history_seed, .. }) = thread.conversation else {
            return Err(invalid("inherited history requires a Fork"));
        };
        let index = match cursor {
            Some(value) => {
                let (id, index) = value.rsplit_once(':').ok_or_else(|| invalid("invalid history cursor"))?;
                if id != history_seed.snapshot_id { return Err(invalid("invalid history cursor")); }
                index.parse::<usize>().map_err(invalid)?
            }
            None => 0,
        };
        let mut entries = Vec::new();
        for turn in self.store.read_fork_snapshot(&history_seed.snapshot_id)
            .map_err(|e| Error::Storage(e.to_string()))? {
            for item in turn.items {
                entries.push(json!({"sourceThreadId":origin.source_thread_id,
                    "sourceTurnId":turn.id,"sourceItemId":item.id(),"item":item}));
            }
        }
        if index > entries.len() { return Err(invalid("invalid history cursor")); }
        let mut data = Vec::new();
        let mut size = 0;
        for entry in entries.iter().skip(index) {
            let bytes = serde_json::to_vec(entry).map_err(invalid)?.len();
            if bytes > max_bytes { return Err(Error::Exhausted("history item exceeds page budget".into())); }
            if size + bytes > max_bytes { break; }
            size += bytes;
            data.push(entry.clone());
        }
        let next = index + data.len();
        Ok(json!({"snapshotId":history_seed.snapshot_id,"data":data,
            "nextCursor":(next < entries.len()).then(||format!("{}:{}",history_seed.snapshot_id,next)),
            "complete":next == entries.len()}))
    }
    /// 空闲旧会话只追加部署固定 Browser 包，受理回执与工具表同一快照提交。
    pub async fn attach_browser_tools(
        self: &Arc<Self>,
        identity: String,
        request: AttachBrowserTools,
        host: Arc<dyn crate::tools::DynamicToolHost>,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            if request.bundle_id != BROWSER_V1_BUNDLE {
                return Err(invalid("unsupported browser bundle"));
            }
            if host.is_closed() || host.identity() != identity {
                return Err(Error::Conflict);
            }
            // 与 thread/start 共用串行门：同一身份/方法/requestId 不能跨 Thread 落两份回执。
            let _serial = engine.desktop.creation.lock().await;
            let hash = digest(&request)?;
            let method = "areal/thread/tools/attach";
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for existing in cells {
                let state = existing.state.lock().await;
                if let Some(record) = state.thread.desktop.as_ref().and_then(|data| data.receipts.iter()
                    .find(|record| record.identity == identity && record.request_id == request.request_id && record.method == method)) {
                    if record.digest != hash || state.thread.id != request.thread_id { return Err(Error::Conflict); }
                    return Ok(record.result.clone());
                }
            }
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let mut data = desktop(&state.thread);
            if let Some(result) = receipt(&data, &identity, &request.request_id, method, &hash)? {
                return Ok(result);
            }
            if state.poisoned || state.active.is_some() || state.compacting
                || !matches!(state.thread.status, ThreadStatus::Idle)
                || state.thread.parent_thread_id.is_some() || data.archived
                || state.thread.toolset_revision != request.expected_toolset_revision
            {
                return Err(Error::Conflict);
            }
            let mut bindings = cell.bindings.write().await;
            if bindings.host.as_ref().is_some_and(|old| old.id() != host.id() && !old.is_closed()) {
                return Err(Error::Conflict);
            }
            let tool = areal_protocol::desktop::browser_v1_tool();
            let present = state.thread.dynamic_tools.iter().find(|entry| entry.name == tool.name);
            if present.is_some_and(|entry| digest(entry).ok() != digest(&tool).ok()) {
                return Err(Error::Conflict);
            }
            // 旧工具仅在原 live ToolHost 当前连接上继续执行；不能改绑给不认识它们的 GUI。
            if state.thread.dynamic_tools.iter().any(|entry| entry.name != tool.name)
                && !bindings.host.as_ref().is_some_and(|old| old.id() == host.id() && !old.is_closed())
            {
                return Err(invalid("existing client tools require their original live host; browser attachment unavailable"));
            }
            let mut candidate = state.thread.clone();
            let mut registry = bindings.registry.clone();
            if present.is_none() {
                registry = registry.with_dynamic(&[tool.clone()]).map_err(invalid)?;
                candidate.dynamic_tools.push(tool);
                candidate.toolset_revision = candidate.toolset_revision.checked_add(1)
                    .ok_or(Error::Conflict)?;
            }
            let result = json!({"threadId": candidate.id, "toolsetRevision":candidate.toolset_revision,
                "bundleId":BROWSER_V1_BUNDLE});
            remember(&mut data, &identity, &request.request_id, method, hash, result.clone());
            candidate.desktop = Some(data);
            engine.persist(&candidate).await?;
            state.thread = candidate;
            bindings.registry = registry;
            bindings.host = Some(host);
            cell.emit("areal/thread/tools/attached", json!({"threadId":request.thread_id,
                "toolsetRevision":state.thread.toolset_revision,
                "dynamicTools":state.thread.dynamic_tools}));
            Ok(result)
        }).await
    }

    pub async fn create_configured(
        self: &Arc<Self>,
        identity: String,
        request: ThreadStart,
        host: Arc<dyn crate::tools::DynamicToolHost>,
    ) -> Result<Thread> {
        self.mutate(move |engine| async move {
            let _serial = engine.desktop.creation.lock().await;
            let hash = digest(&request)?;
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in cells {
                let state = cell.state.lock().await;
                if let Some(data) = &state.thread.desktop
                    && data.receipts.iter().any(|r| {
                        r.identity == identity
                            && r.request_id == request.request_id
                            && r.method == "areal/thread/start"
                    })
                    && receipt(
                        data,
                        &identity,
                        &request.request_id,
                        "areal/thread/start",
                        &hash,
                    )?
                    .is_some()
                {
                    let thread = state.thread.clone();
                    drop(state);
                    return engine.ensure_profile_workflow(thread, &hash).await;
                }
            }
            let mut data = DesktopState {
                configuration: engine.resolve_config(
                    request
                        .agent_profile
                        .or_else(|| engine.desktop.default_profile.read().unwrap().clone()),
                    request.model,
                    request.parameters,
                    1,
                )?,
                ..Default::default()
            };
            receipt(
                &data,
                &identity,
                &request.request_id,
                "areal/thread/start",
                &hash,
            )?;
            remember(
                &mut data,
                &identity,
                &request.request_id,
                "areal/thread/start",
                hash.clone(),
                Value::Null,
            );
            let workflow = data
                .configuration
                .profile
                .as_ref()
                .and_then(|profile| profile.workflow.clone());
            if let Some(reference) = &workflow {
                let definition = engine.workflow(reference)?;
                let start = profile_workgroup_start(&hash, definition.plan);
                engine
                    .workgroups()
                    .map_err(invalid)?
                    .validate_start(&start)
                    .map_err(invalid)?;
            }
            let (thread, _) = engine
                .create_inner(
                    request.cwd.unwrap_or_else(|| engine.default_cwd()),
                    None,
                    None,
                    request.dynamic_tools,
                    Some(host),
                    Some(data),
                )
                .await?;
            engine.ensure_profile_workflow(thread, &hash).await
        })
        .await
    }

    async fn ensure_profile_workflow(
        self: &Arc<Self>,
        thread: Thread,
        hash: &str,
    ) -> Result<Thread> {
        let Some(reference) = thread
            .desktop
            .as_ref()
            .and_then(|data| data.configuration.profile.as_ref())
            .and_then(|profile| profile.workflow.clone())
        else {
            return Ok(thread);
        };
        if thread
            .desktop
            .as_ref()
            .is_some_and(|data| data.workflow_run.is_some())
        {
            return Ok(thread);
        }
        let definition = self.workflow(&reference)?;
        let run = self
            .start_workgroup(
                format!("thread:{}", thread.id),
                profile_workgroup_start(hash, definition.plan),
                self.shutdown.child_token(),
            )
            .await
            .map_err(invalid)?;
        let workgroup_id = run["id"]
            .as_str()
            .context("workflow start missing workgroup ID")
            .map_err(invalid)?
            .to_owned();
        let status = run["record"]["status"]
            .as_str()
            .unwrap_or("running")
            .to_owned();
        let mut candidate = thread.clone();
        candidate
            .desktop
            .get_or_insert_with(Default::default)
            .workflow_run = Some(areal_protocol::desktop::WorkflowRun {
            workflow: reference,
            workgroup_id,
            status,
        });
        self.persist(&candidate).await?;
        let cell = self.cell(&thread.id).await?;
        cell.state.lock().await.thread = candidate.clone();
        Ok(candidate)
    }
    pub async fn configure_thread(
        self: &Arc<Self>,
        request: ConfigureThread,
    ) -> Result<EffectiveConfig> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&request.thread_id).await?;
            engine.refresh_managed_tools(&cell).await.map_err(invalid)?;
            let mut state = cell.state.lock().await;
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            let previous = desktop(&state.thread).configuration;
            if previous.revision != request.expected_revision {
                return Err(Error::Conflict);
            }
            if request.reset_model && request.model.is_some() {
                return Err(invalid("model and resetModel cannot be used together"));
            }
            let mut configuration = engine.resolve_config(
                request.agent_profile.or_else(|| {
                    previous.profile.as_ref().map(|p| VersionRef {
                        id: p.id.clone(),
                        revision: p.revision.clone(),
                    })
                }),
                if request.reset_model {
                    None
                } else {
                    request.model.or(previous.model)
                },
                request.parameters.unwrap_or(previous.parameters),
                previous.revision + 1,
            )?;
            if previous.profile.as_ref().map(|p| (&p.id, &p.revision))
                != configuration.profile.as_ref().map(|p| (&p.id, &p.revision))
                && (previous
                    .profile
                    .as_ref()
                    .is_some_and(|p| p.workflow.is_some())
                    || configuration
                        .profile
                        .as_ref()
                        .is_some_and(|p| p.workflow.is_some()))
            {
                return Err(invalid(
                    "workflow-bound profiles can only be selected when creating a new thread",
                ));
            }
            configuration.options = request.options.unwrap_or(previous.options);
            let selected_skills = match request.selected_skills {
                Some(skills) if skills.is_empty() => None,
                Some(skills) => Some(skills),
                None => previous.selected_skills,
            };
            if let Some(skills) = &selected_skills {
                if skills.len() > 128 {
                    return Err(invalid("selected skills exceed budget"));
                }
                let mut unique = std::collections::BTreeSet::new();
                let catalog = engine.desktop.catalog.read().unwrap();
                for skill in skills {
                    if !unique.insert((skill.id.clone(), skill.revision.clone())) {
                        return Err(invalid("duplicate selected skill"));
                    }
                    if !catalog
                        .skills
                        .contains_key(&format!("{}/{}", skill.id, skill.revision))
                    {
                        return Err(invalid("selected skill is unavailable"));
                    }
                }
                if let Some(profile) = &configuration.profile
                    && !skills.iter().all(|skill| profile.skills.contains(skill))
                {
                    return Err(invalid("selected skill is outside the effective profile"));
                }
            }
            configuration.selected_skills = selected_skills;
            let o = &configuration.options;
            configuration.read_only |= o.read_only;
            configuration.instructions = previous.instructions;
            if o.system_prompt.as_ref().is_some_and(|s| s.len() > 32768)
                || o.append_instructions.len() > 32768
                || o.max_model_rounds.is_some_and(|n| n == 0 || n > 1024)
                || o.approval_tools.len() > 128
                || o.preapproved_tools.len() > 128
            {
                return Err(invalid("invalid client option budget"));
            }
            if let Some(names) = &o.tool_allowlist {
                let registry = cell.bindings.read().await;
                if names.len() > 128 {
                    return Err(invalid("tool allowlist exceeds budget"));
                }
                for name in names {
                    registry.registry.get(name).map_err(invalid)?;
                    if configuration
                        .tool_allowlist
                        .as_ref()
                        .is_some_and(|allowed| !allowed.contains(name))
                    {
                        return Err(invalid("client tools exceed profile boundary"));
                    }
                }
                configuration.tool_allowlist = Some(names.clone());
            }
            let mut candidate = state.thread.clone();
            candidate
                .desktop
                .get_or_insert_with(Default::default)
                .configuration = configuration.clone();
            engine.persist(&candidate).await?;
            state.thread = candidate;
            cell.emit(
                "areal/thread/configured",
                json!({"threadId":request.thread_id,"configuration":configuration}),
            );
            Ok(configuration)
        })
        .await
    }
    pub async fn plan(&self, thread_id: &str) -> Result<Plan> {
        Ok(desktop(&self.read(thread_id, false).await?).plan)
    }
    pub async fn update_plan(self: &Arc<Self>, request: PlanUpdate) -> Result<Plan> {
        self.mutate(move |engine| async move { engine.update_plan_inner(request).await })
            .await
    }
    pub(super) async fn update_plan_inner(&self, request: PlanUpdate) -> Result<Plan> {
        let mut ids = HashSet::new();
        if request.steps.len() > 64
            || request.steps.iter().any(|s| {
                !valid_id(&s.id)
                    || !ids.insert(&s.id)
                    || s.text.is_empty()
                    || s.text.len() > 1024
                    || !matches!(
                        s.status.as_str(),
                        "pending" | "inProgress" | "completed" | "cancelled"
                    )
            })
        {
            return Err(invalid(
                "invalid plan steps (maximum 64 steps, 1024 bytes each, unique IDs)",
            ));
        }
        let cell = self.cell(&request.thread_id).await?;
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let data = candidate.desktop.get_or_insert_with(Default::default);
        if data.plan.revision != request.expected_revision {
            return Err(Error::Conflict);
        }
        data.plan = Plan {
            revision: data.plan.revision + 1,
            steps: request.steps,
        };
        let plan = data.plan.clone();
        self.persist(&candidate).await?;
        state.thread = candidate;
        cell.emit(
            "areal/plan/updated",
            json!({"threadId":request.thread_id,"plan":plan}),
        );
        Ok(plan)
    }
    pub(crate) async fn visible_tools(
        &self,
        cell: &Cell,
        config: &EffectiveConfig,
        desktop_enabled: bool,
    ) -> Vec<Value> {
        let goal_enabled = cell.goal_role.load(Ordering::Acquire) != 0;
        let bindings = cell.bindings.read().await;
        let mut definitions = bindings.registry.definitions();
        let core_names: Vec<_> = crate::desktop::definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        definitions.retain(|d| {
            let name = d["function"]["name"].as_str().unwrap_or("");
            (!matches!(name, "task_spawn" | "task_wait" | "task_channel_read") || goal_enabled)
                && (!matches!(name, "task_spawn" | "task_wait")
                    || cell.goal_role.load(Ordering::Acquire) == 1)
                && (!name.starts_with("goal_")
                    || (goal_enabled && (!matches!(name, "goal_update" | "goal_set_limits") || cell.depth == 0)))
                && (!name.starts_with("workgroup_") || self.workgroups.get().is_some())
                && (!matches!(name, "agent_spawn" | "agent_spawn_configured")
                    || (cell.depth < self.limits.max_agent_depth
                        && self.limits.max_children_per_turn > 0))
                // Explicit research-agent extensions own the child lifecycle;
                // exposing the desktop facade as well creates two subtly
                // different spawn/wait contracts for the same Turn.
                && (self.extensions.agents.is_none()
                    || !matches!(name, "agent_spawn_configured" | "agent_wait_all"))
                && (name != "agent_report" || cell.depth > 0)
                // 原文回取属于所有 Core 会话，不依赖桌面扩展状态。
                && (desktop_enabled || matches!(name, "read_tool_result" | "read_history") || !core_names.iter().any(|n| n == name))
                && config
                    .tool_allowlist
                    .as_ref()
                    .is_none_or(|a| a.iter().any(|n| n == name))
                && (!config.read_only
                    || bindings.registry.get(name).is_ok_and(|t| {
                        crate::agents::read_only_tool(name, &t.backend)
                            || matches!(
                                t.backend,
                                crate::tools::Backend::Builtin
                                    | crate::tools::Backend::Core
                                    | crate::tools::Backend::Command(_)
                            )
                    }))
        });
        if let Some(service) = self.workgroups.get() {
            for definition in &mut definitions {
                if definition["function"]["name"] == "workgroup_start" {
                    definition["function"]["parameters"]["properties"]["workers"]["maximum"] =
                        json!(service.policy().workers);
                }
            }
        }
        definitions
    }
    pub async fn inspect(&self, thread_id: &str) -> Result<Value> {
        let cell = self.cell(thread_id).await?;
        let state = cell.state.lock().await;
        let config = state
            .thread
            .turns
            .last()
            .filter(|_| state.active.is_some())
            .and_then(|t| t.configuration.clone())
            .unwrap_or_else(|| desktop(&state.thread).configuration);
        let tools = self
            .visible_tools(&cell, &config, state.thread.desktop.is_some())
            .await;
        Ok(
            json!({"threadId":thread_id,"sessionId":state.thread.session_id,"parentThreadId":state.thread.parent_thread_id,
            "activeTurnId":state.active.as_ref().map(|a| &a.id),"configuration":config,
            "instructionSnapshot":state.thread.turns.last().and_then(|t|t.instruction_snapshot.as_ref()),"instructionSources":["runtime/defaultOrClientSystem","profile","childTask","clientAppend","workspace/AGENTS.md"],"tools":tools,"loadedSkills":state.thread.desktop.as_ref().map(|d| &d.loaded_skills),
            "contextCheckpoint":state.thread.context_checkpoint,"usage":state.thread.turns.last().and_then(|t| t.usage.as_ref()),
            "usageKnown":state.thread.turns.last().is_some_and(|t| t.usage.is_some()),
            "limits":{"historyBytes":self.limits.max_history_bytes,"contextBytes":self.limits.context_window_bytes},
            "runtime":self.runtime_capabilities()}),
        )
    }
    pub async fn find_request(&self, identity: &str, request_id: &str) -> Result<Value> {
        let mut management = self.management_receipts(identity, request_id).await;
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        for cell in cells {
            let state = cell.state.lock().await;
            if let Some(d) = &state.thread.desktop {
                for receipt in &d.receipts {
                    if receipt.identity == identity && receipt.request_id == request_id {
                        let mut v = json!(receipt);
                        v["threadId"] = json!(state.thread.id);
                        management["data"].as_array_mut().unwrap().push(v);
                    }
                }
            }
        }
        Ok(management)
    }
    pub async fn request_status(
        &self,
        identity: &str,
        thread_id: &str,
        request_id: &str,
    ) -> Result<Value> {
        let thread = self.read(thread_id, false).await?;
        let records = desktop(&thread)
            .receipts
            .into_iter()
            .filter(|r| r.identity == identity && r.request_id == request_id)
            .collect::<Vec<_>>();
        Ok(json!({"data":records,"retention":"threadLifetime","capacity":1024}))
    }
    pub(crate) async fn active_permissions(
        &self,
        cell: &Cell,
    ) -> anyhow::Result<areal_runtime_protocol::PermissionRequest> {
        if let Some(scratch) = self.command_scratch(cell) {
            // 目录由可信 Core 创建，Runtime 再绑定和校验目录身份。
            std::fs::create_dir_all(scratch).context("cannot create task scratch")?;
        }
        let state = cell.state.lock().await;
        let readonly = state
            .thread
            .turns
            .last()
            .and_then(|t| t.configuration.as_ref())
            .is_some_and(|c| c.read_only);
        Ok(areal_runtime_protocol::PermissionRequest {
            read_roots: if readonly || cell.research {
                Some(
                    vec!["workspace://repo".into(), self.scratch_uri(cell)]
                        .into_iter()
                        .filter(|p| {
                            p == "workspace://repo"
                                || self
                                    .runtime
                                    .as_ref()
                                    .is_some_and(|r| r.command_scratch.is_some())
                        })
                        .collect(),
                )
            } else {
                None
            },
            write_roots: if readonly {
                Some(
                    if self
                        .runtime
                        .as_ref()
                        .is_some_and(|r| r.command_scratch.is_some())
                    {
                        vec![self.scratch_uri(cell)]
                    } else {
                        Vec::new()
                    },
                )
            } else {
                self.scope_permissions(cell).write_roots
            },
            network: if readonly {
                areal_runtime_protocol::NetworkRequest::Deny
            } else {
                areal_runtime_protocol::NetworkRequest::Inherit
            },
        })
    }
}

fn profile_workgroup_start(
    hash: &str,
    plan: crate::workgroup::Plan,
) -> crate::workgroup::service::Start {
    crate::workgroup::service::Start {
        request_id: format!("profile-workflow-{}", &hash[..32]),
        plan,
        workers: None,
        admission: Default::default(),
    }
}
