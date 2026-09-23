use super::*;

impl Engine {
    /// 嵌入式宿主应在完成模型与工具装配后启动；重复调用不产生多个调度器。
    pub fn start_task_scheduler(self: &Arc<Self>) {
        if self.task_modes.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        let cancel = self.shutdown.clone();
        let changed = self.task_modes.changed.clone();
        self.tasks.spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { biased;
                    _ = cancel.cancelled() => break,
                    _ = changed.notified() => {},
                    _ = timer.tick() => {},
                }
                let Some(engine) = weak.upgrade() else {
                    break;
                };
                let ids: Vec<_> = engine
                    .task_modes
                    .state
                    .lock()
                    .await
                    .tasks
                    .keys()
                    .cloned()
                    .collect();
                for id in ids {
                    if cancel.is_cancelled() {
                        break;
                    }
                    if let Err(error) = engine.advance_task(&id).await {
                        tracing::error!(task_id=%id,%error,"task dispatch failed");
                        if let Err(error) = engine
                            .edit_task(&id, |task| {
                                task.paused = true;
                                if let Some(run) = task.runs.last_mut() {
                                    run.status = RunStatus::Blocked;
                                    run.reason = Some(error.to_string());
                                }
                            })
                            .await
                        {
                            tracing::error!(%error,"task failure persistence failed");
                        }
                    }
                }
            }
        });
    }

    pub(crate) fn wake_tasks(&self) {
        self.task_modes.changed.notify_one();
    }

    pub(super) async fn edit_task(&self, id: &str, edit: impl FnOnce(&mut Task)) -> Result<()> {
        let mut state = self.task_modes.state.lock().await;
        let mut candidate = state.clone();
        let task = candidate.tasks.get_mut(id).ok_or(Error::NotFound)?;
        let previous = serde_json::to_value(&task).map_err(invalid)?;
        edit(task);
        if previous == serde_json::to_value(&task).map_err(invalid)? {
            return Ok(());
        }
        task.revision += 1;
        self.save_tasks(&mut state, candidate, id).await
    }

    async fn advance_task(self: &Arc<Self>, task_id: &str) -> Result<()> {
        self.edit_task(task_id, |task| {
            let current_run = task.runs.last().map(|r| r.id.as_str());
            let mut expired = false;
            for m in &mut task.messages {
                if m.status == "pending" && m.expires_at.is_some_and(|at| at <= now()) {
                    m.status = "expired".into();
                    task.channel_sequence += 1;
                    m.sequence = task.channel_sequence;
                    expired |= current_run == Some(m.run_id.as_str());
                }
            }
            if let Some(run) = task.runs.last_mut()
                && (expired
                    || (run.workers.iter().all(|w| w.settled)
                        && !task
                            .messages
                            .iter()
                            .any(|m| m.run_id == run.id && m.status == "pending")))
            {
                // 任一问题过期都交还模型判断，其他未回答问题不能掩盖该唤醒。
                run.wait_requested = false;
            }
        })
        .await?;
        let task = self.task_read(task_id).await?;
        self.settle_task_workers(&task).await?;
        let task = self.task_read(task_id).await?;
        if let Some(run) = task.runs.last() {
            if let (Some(thread), Some(goal_id)) = (&run.thread_id, &run.goal_id) {
                let view = self.goal_get(thread).await?;
                if view["goal"]["id"].as_str() == Some(goal_id) {
                    let goal: Goal =
                        serde_json::from_value(view["goal"].clone()).map_err(invalid)?;
                    if (task.paused || task.cancelled) && goal.status == GoalStatus::Active {
                        self.goal_control(
                            task.owner.clone(),
                            "pause".into(),
                            GoalControl {
                                request_id: format!("task-stop-{}-{}", run.id, task.revision),
                                thread_id: thread.clone(),
                                goal_id: goal_id.clone(),
                                expected_revision: view["revision"].as_u64().unwrap(),
                            },
                            None,
                        )
                        .await?;
                        return Ok(());
                    }
                    if run.reason.as_deref() == Some("resumeRequested")
                        && !task.paused
                        && !task.cancelled
                        && self.accepting_work()
                        && goal.active_turn_id.is_none()
                        && !goal.settling
                        && run.workers.iter().all(|w| w.settled)
                        && matches!(goal.status, GoalStatus::Paused | GoalStatus::Blocked)
                    {
                        self.goal_control(
                            task.owner.clone(),
                            "resume".into(),
                            GoalControl {
                                request_id: format!("task-resume-{}-{}", run.id, task.revision),
                                thread_id: thread.clone(),
                                goal_id: goal_id.clone(),
                                expected_revision: view["revision"].as_u64().unwrap(),
                            },
                            None,
                        )
                        .await?;
                        self.edit_task(task_id, |task| {
                            task.runs.last_mut().unwrap().reason = None;
                        })
                        .await?;
                        return Ok(());
                    }
                    self.edit_task(task_id, |task| {
                        let cancelled = task.cancelled;
                        let run = task.runs.last_mut().unwrap();
                        run.usage = goal.usage.clone();
                        if goal.active_turn_id.is_some()
                            || goal.settling
                            || (goal.status != GoalStatus::Active
                                && run.workers.iter().any(|w| !w.settled))
                        {
                            return;
                        }
                        run.status = if cancelled {
                            RunStatus::Cancelled
                        } else {
                            match goal.status {
                                GoalStatus::Active
                                    if run.wait_requested
                                        && run.workers.iter().any(|w| !w.settled) =>
                                {
                                    RunStatus::WaitingForAgents
                                }
                                GoalStatus::Active if run.wait_requested => {
                                    RunStatus::WaitingForInput
                                }
                                GoalStatus::Active => RunStatus::Running,
                                GoalStatus::Paused => RunStatus::Paused,
                                GoalStatus::Blocked | GoalStatus::BudgetLimited => {
                                    RunStatus::Blocked
                                }
                                GoalStatus::Completed => RunStatus::Completed,
                                GoalStatus::Failed => RunStatus::Failed,
                            }
                        };
                        run.reason = goal.reason.clone();
                        if run.status.terminal() && run.completed_at.is_none() {
                            run.completed_at = Some(now());
                            for m in &mut task.messages {
                                if m.run_id == run.id && m.status == "pending" {
                                    m.status = "cancelled".into();
                                    task.channel_sequence += 1;
                                    m.sequence = task.channel_sequence;
                                }
                            }
                            if task.messages.len() < MAX_MESSAGES {
                                task.channel_sequence += 1;
                                task.messages.push(ChannelMessage {
                                    id: id(),
                                    sequence: task.channel_sequence,
                                    run_id: run.id.clone(),
                                    author: "core".into(),
                                    kind: "report".into(),
                                    status: "published".into(),
                                    created_at: now(),
                                    expires_at: None,
                                    questions: vec![],
                                    required: false,
                                    in_reply_to: None,
                                    answers: None,
                                    text: goal
                                        .report
                                        .as_ref()
                                        .map(|r| r.summary.clone())
                                        .unwrap_or_else(|| {
                                            format!(
                                                "{:?}: {}",
                                                run.status,
                                                run.reason.as_deref().unwrap_or("")
                                            )
                                        }),
                                });
                            }
                        }
                    })
                    .await?;
                    if goal.status == GoalStatus::Active
                        && goal.active_turn_id.is_none()
                        && !run.wait_requested
                        && !task.paused
                        && !task.cancelled
                    {
                        self.goals.request(thread);
                    }
                } else if !run.status.terminal() {
                    self.edit_task(task_id, |task| {
                        let run = task.runs.last_mut().unwrap();
                        run.status = RunStatus::Blocked;
                        run.reason = Some("goalMissingOrReplaced".into());
                        task.paused = true;
                    })
                    .await?;
                }
            } else if task.cancelled {
                self.edit_task(task_id, |task| {
                    let run = task.runs.last_mut().unwrap();
                    run.status = RunStatus::Cancelled;
                    run.completed_at = Some(now());
                })
                .await?;
            }
        }
        let task = self.task_read(task_id).await?;
        if task.cancelled || task.paused || !self.accepting_work() {
            return Ok(());
        }
        if task.next_run_at.is_some_and(|at| at <= now()) {
            self.edit_task(task_id, |task| {
                let at = task.next_run_at.unwrap();
                let busy = task.runs.last().is_some_and(|r| !r.status.terminal());
                task.next_run_at =
                    task.schedule
                        .as_ref()
                        .and_then(|s| s.interval_seconds)
                        .map(|interval| {
                            let interval = interval as i64;
                            at.saturating_add(
                                ((now() - at) / interval + 1).saturating_mul(interval),
                            )
                        });
                // 周期任务合并错过的时间点；已有 Run 未结束时跳过本次触发。
                if !busy {
                    if task.runs.len() >= MAX_RUNS {
                        task.paused = true;
                    } else {
                        task.runs.push(new_run(task.thread_id.clone(), at));
                    }
                }
            })
            .await?;
        }
        let task = self.task_read(task_id).await?;
        let Some(run) = task
            .runs
            .last()
            .filter(|r| r.status == RunStatus::Queued)
            .cloned()
        else {
            return Ok(());
        };
        let thread = match &run.thread_id {
            Some(id) => id.clone(),
            None => {
                let created = self.create(self.default_cwd()).await?;
                self.edit_task(task_id, |t| {
                    t.runs.last_mut().unwrap().thread_id = Some(created.id.clone())
                })
                .await?;
                created.id
            }
        };
        let cell = self.cell(&thread).await?;
        {
            let state = cell.state.lock().await;
            if state.active.is_some()
                || state.compacting
                || state.thread.desktop.as_ref().is_some_and(|d| {
                    d.queue
                        .items
                        .iter()
                        .any(|i| matches!(i.status.as_str(), "pending" | "running"))
                })
            {
                return Ok(());
            }
        }
        let mut view = self.goal_get(&thread).await?;
        if let Some(goal_id) = view["goal"]["id"].as_str() {
            if view["goal"]["status"] == "active" {
                return Ok(());
            }
            if !task
                .runs
                .iter()
                .any(|r| r.goal_id.as_deref() == Some(goal_id))
            {
                return Ok(());
            }
            self.goal_control(
                task.owner.clone(),
                "clear".into(),
                GoalControl {
                    request_id: format!("task-clear-{}", run.id),
                    thread_id: thread.clone(),
                    goal_id: goal_id.into(),
                    expected_revision: view["revision"].as_u64().unwrap(),
                },
                None,
            )
            .await?;
            view = self.goal_get(&thread).await?;
        }
        let used: u64 = task
            .runs
            .iter()
            .map(|r| r.usage.tokens_used.saturating_add(r.usage.reserved_tokens))
            .fold(0, u64::saturating_add);
        let budget = task.token_budget.map(|n| n.saturating_sub(used));
        if budget == Some(0) {
            return Err(invalid("task token budget exhausted"));
        }
        let result = self
            .goal_create(
                task.owner.clone(),
                GoalCreate {
                    request_id: format!("task-run-{}", run.id),
                    thread_id: thread,
                    expected_revision: view["revision"].as_u64().unwrap(),
                    objective: task.objective,
                    token_budget: budget,
                    max_turns: task.max_turns,
                    max_active_seconds: task.max_active_seconds,
                    interaction_mode: Some(task.interaction_mode),
                },
            )
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(Error::Conflict) => Ok(()),
            Err(Error::Exhausted(ref reason)) if reason.starts_with("active Turn capacity") => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}
