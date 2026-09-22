use super::*;

impl Engine {
    pub(crate) async fn spawn_task_worker(
        self: &Arc<Self>,
        parent: &Cell,
        args: &Value,
    ) -> Result<Value> {
        let prompt = args["prompt"]
            .as_str()
            .ok_or_else(|| invalid("prompt required"))?
            .to_owned();
        if prompt.trim().is_empty() || prompt.len() > 32000 {
            return Err(invalid("prompt must contain 1..32000 bytes"));
        }
        let parent_id = parent.id.clone();
        let requested_rounds = args["maxModelRounds"].as_u64();
        self.mutate(move |engine| async move {
            let _gate=engine.desktop.lifecycle.gate.lock().await;
            let parent=engine.cell(&parent_id).await?;
            let state=parent.state.lock().await;
            let active=state.active.as_ref().filter(|a|!a.cancel.is_cancelled()&&!a.sealed).ok_or(Error::Conflict)?;
            if parent.research || parent.depth!=0 || state.thread.goal_owner.is_some() || engine.limits.max_agent_depth==0 {
                return Err(invalid("only the TaskRun coordinator may create task workers"));
            }
            let goal=state.thread.goals.goal.as_ref().filter(|g|g.status==GoalStatus::Active).ok_or(Error::Conflict)?;
            let mut configuration=engine.child_configuration(&state.thread,None)?.unwrap_or_default();
            let rounds=requested_rounds.map(|n|n as usize).unwrap_or(configuration.options.max_model_rounds.unwrap_or(16).min(16));
            if rounds==0 || rounds>1024 || configuration.options.max_model_rounds.is_some_and(|n|rounds>n) {
                return Err(invalid("worker model rounds exceed parent limit"));
            }
            if !state.thread.dynamic_tools.is_empty() {return Err(invalid("task workers require server-owned tools; client callbacks cannot be detached"));}
            let (task_id,run_id)={
                let tasks=engine.task_modes.state.lock().await;
                let (task,run)=tasks.tasks.values().find_map(|t|t.runs.iter().find(|r|r.goal_id.as_deref()==Some(&goal.id)).map(|r|(t,r))).ok_or(Error::NotFound)?;
                if task.paused || task.cancelled {return Err(Error::Conflict);}
                if run.workers.len()>=engine.limits.max_children_per_turn {return Err(Error::Exhausted("TaskRun worker capacity reached".into()));}
                (task.id.clone(),run.id.clone())
            };
            configuration.options.max_model_rounds=Some(rounds);
            if configuration.options.interaction_mode == InteractionMode::Interactive { configuration.options.interaction_mode=InteractionMode::Asynchronous; }
            let definitions=engine.visible_tools(&parent,&configuration,true).await;
            configuration.tool_allowlist=Some(definitions.iter().filter_map(|d|d["function"]["name"].as_str())
                .filter(|n|!matches!(*n,"task_spawn"|"task_wait"|"goal_update"|"agent_spawn"|"agent_spawn_configured"|"delegate_tasks"))
                .map(str::to_owned).collect());
            configuration.instructions.push_str("\nYou are a TaskRun worker. Perform only the assigned work and return evidence. Your lifetime is owned by the TaskRun, independent of its coordinator's current Turn. Do not delegate, change the root goal, or suspend the coordinator. Task channel replies are available for inspection.");
            let permit=engine.reserve_active_turn()?;
            let (thread,_)=engine.create_inner(state.thread.cwd.clone(),None,None,vec![],None,Some(areal_protocol::desktop::DesktopState{configuration,..Default::default()})).await?;
            let worker=engine.raw_cell(&thread.id).await?;
            let mut worker_state=worker.state.lock().await;
            let mut source=worker_state.thread.clone();
            source.source="nativeTaskAgent".into();
            source.goal_owner=Some(GoalOwner{thread_id:parent_id.clone(),goal_id:goal.id.clone()});
            let (candidate,turn)=engine.prepare_turn(&source,vec![Input::text(prompt)])?;
            engine.persist(&candidate).await?;
            let mut tasks=engine.task_modes.state.lock().await;
            let mut next=tasks.clone();
            let task=next.tasks.get_mut(&task_id).ok_or(Error::NotFound)?;
            if task.paused || task.cancelled || active.cancel.is_cancelled() {return Err(Error::Conflict);}
            task.runs.iter_mut().find(|r|r.id==run_id).ok_or(Error::NotFound)?.workers.push(TaskWorker{
                thread_id:thread.id.clone(),turn_id:turn.id.clone(),status:"running".into(),settled:false,
            });
            task.revision+=1;
            engine.save_tasks(&mut tasks,next,&task_id).await?;
            drop(tasks);
            worker_state.thread=candidate;
            engine.activate(&worker,&mut worker_state,&turn,engine.shutdown.child_token(),permit);
            Ok(json!({"taskId":task_id,"runId":run_id,"threadId":thread.id,"turnId":turn.id,"status":"running","lifetime":"taskRun"}))
        })
        .await
    }

    pub(crate) async fn task_workers_ready(&self, cell: &Cell, successful: bool) -> Result<()> {
        let thread = cell.state.lock().await.thread.clone();
        self.task_workers_settled(&thread, successful).await
    }

    pub(crate) async fn task_workers_settled(
        &self,
        thread: &Thread,
        successful: bool,
    ) -> Result<()> {
        let Some(goal) = thread.goals.goal.as_ref() else {
            return Ok(());
        };
        let workers = self
            .task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .find_map(|t| {
                t.runs
                    .iter()
                    .find(|r| r.goal_id.as_deref() == Some(&goal.id))
                    .map(|r| r.workers.clone())
            })
            .unwrap_or_default();
        for worker in &workers {
            let cell = self.raw_cell(&worker.thread_id).await?;
            let state = cell.state.lock().await;
            if !worker.settled
                || state.active.is_some()
                || state.poisoned
                || (successful
                    && state
                        .thread
                        .turns
                        .last()
                        .is_none_or(|t| t.status != TurnStatus::Completed))
            {
                return Err(invalid(
                    "TaskRun workers must settle successfully before completion",
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn settle_task_workers(&self, task: &Task) -> Result<()> {
        let Some(run) = task.runs.last() else {
            return Ok(());
        };
        let goal = if let Some(thread) = &run.thread_id {
            self.goal_get(thread).await?
        } else {
            Value::Null
        };
        let stop = task.paused || task.cancelled || goal["goal"]["status"] != "active";
        for worker in &run.workers {
            if worker.settled {
                continue;
            }
            let cell = self.raw_cell(&worker.thread_id).await?;
            let state = cell.state.lock().await;
            if let Some(active) = &state.active {
                if stop {
                    active.cancel.cancel();
                }
                continue;
            }
            if state.poisoned {
                return Err(invalid("TaskRun worker cleanup is unconfirmed"));
            }
            let turn = state.thread.turns.last().ok_or(Error::Conflict)?;
            let status = match turn.status {
                TurnStatus::Completed => "completed",
                TurnStatus::Interrupted => "cancelled",
                _ => "failed",
            }
            .to_owned();
            let report = turn
                .items
                .iter()
                .rev()
                .find_map(|i| match i {
                    Item::AgentMessage { text, .. } => Some(tools::prefix(text, 4096).to_owned()),
                    _ => None,
                })
                .unwrap_or_default();
            drop(state);
            self.edit_task(&task.id, |task| {
                let run = task.runs.last_mut().unwrap();
                let w = run
                    .workers
                    .iter_mut()
                    .find(|w| w.thread_id == worker.thread_id)
                    .unwrap();
                w.status = status.clone();
                w.settled = true;
                run.wait_requested = false;
                if task.messages.len() < MAX_MESSAGES {
                    task.channel_sequence += 1;
                    task.messages.push(ChannelMessage {
                        id: id(),
                        sequence: task.channel_sequence,
                        run_id: run.id.clone(),
                        author: worker.thread_id.clone(),
                        kind: "workerReport".into(),
                        status: "published".into(),
                        created_at: now(),
                        expires_at: None,
                        questions: vec![],
                        required: false,
                        in_reply_to: None,
                        answers: None,
                        text: format!("Worker {status}: {report}"),
                    });
                }
            })
            .await?;
        }
        Ok(())
    }
}
