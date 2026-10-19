import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "../components/ui/action-button.js";
import { Button } from "../components/ui/button.js";
import { SettingsGroupCard, SettingsRow, SettingsSection, SettingsSwitch } from "./SettingsPageParts.js";
import { SpaceReclamation } from "./SpaceReclamation.js";
import type { Action, Snapshot } from "../services.js";

type Resource = { id: string; threadId: string; executable: string; state: string; stale: boolean };
type Project = { projectId: string; root: string; started: boolean; restartSafe?: boolean; resources?: Resource[];
  activeThreads?: { threadId: string; turnId: string }[]; goalThreads?: string[]; activeTasks?: number;
  goals?: { threadId: string; status: string; objective: string }[];
  tasks?: { id: string; threadId: string; mode: string; objective: string; paused: boolean; nextRunAt?: number; running: boolean }[];
  unresolvedTools?: number; compactions?: number; workgroups?: number;
  queues?: { threadId: string; paused: boolean; pending: number; running: number }[];
  pendingRequests?: { threadId?: string; awaitingResponse: boolean }[] };
type Status = { canStop?: boolean; connected: boolean; clients: number; busy: boolean; activeCommands: number; starting: number; providerUpdating: boolean; projects: Project[] };

export function ServiceStatusSettings({ connected, runningState, recovery, action, onConnect, onOpen, onTask }: {
  connected: boolean; runningState?: "running" | "stopped" | "unknown"; action: Action; onConnect: () => Promise<void>;
  recovery?: NonNullable<Snapshot["lifecycle"]>["recovery"];
  onTask: (projectId: string, taskId: string) => void;
  onOpen: (projectId: string, threadId: string, panel?: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(""), [actionError, setActionError] = useState(""), [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0), locked = useRef(false), inflight = useRef<Promise<void> | null>(null);
  const read = useCallback(() => {
    if (!connected) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const ticket = generation.current; setReading(true);
    const pending = (async () => {
      try {
        const result: Status = await action("serviceStatus");
        if (ticket === generation.current) { setStatus(result); setReadError(""); }
      } catch (cause) { if (ticket === generation.current) setReadError(`后台状态读取失败，请重试。${(cause as Error).message}`); }
      finally { if (ticket === generation.current) setReading(false); inflight.current = null; }
    })();
    inflight.current = pending; return pending;
  }, [action, connected]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (!locked.current) await read(); if (live) timer = setTimeout(poll, 2000); };
    void poll();
    return () => { live = false; generation.current++; clearTimeout(timer); };
  }, [read]);
  const run = async (operation: "stopService" | "recoverResources" | "connect" | "quitInterface" | "stopAndQuit") => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setActionError(""); setNotice("");
    let stopped = false;
    try {
      await inflight.current; // Finish this page's read before the native stop fence.
      if (operation === "connect") await onConnect();
      else {
        const result = operation === "quitInterface" || operation === "stopAndQuit"
          ? await action("serviceLifecycle", { operation }) : await action(operation);
        if (operation === "quitInterface" || operation === "stopAndQuit") stopped = !!result.quitting || !!result.stopped;
        if (operation === "stopService") { stopped = result.stopped === true; setNotice(stopped ? "后台已关闭" : result.canceled ? "已取消关闭" : "关闭结果待确认"); }
        if (operation === "recoverResources" && result.recovered) { await onConnect(); setNotice("后台已恢复，配置和历史已保留。"); }
      }
    } catch (cause) { setActionError((cause as Error).message); }
    finally {
      locked.current = false; setBusy(false);
      // A successful stop must stay stopped. Reads never call connectService.
      if (!stopped) await read();
    }
  };
  return <div className="settings-sections" aria-label="后台服务管理">
    <SettingsSection title="共享后台"
      action={<ActionButton pending={refreshing} disabled={busy || !connected} onClick={async () => { setRefreshing(true); try { await read(); } finally { setRefreshing(false); } }}>刷新后台状态</ActionButton>}>
      <SettingsGroupCard>
        <SettingsRow label="后台服务" description={connected ? status ? `已连接 · ${status.clients} 个窗口 · ${status.activeCommands} 个处理中请求` : "已连接" : "未连接"}
          control={<SettingsSwitch aria-label="后台服务" checked={connected} disabled={busy || (connected && !!readError)} onCheckedChange={enabled => void run(enabled ? "connect" : "stopService")} />} />
        <SettingsRow control={null} label="关闭窗口" description="仅隐藏界面，后台继续运行；再次启动可回到已有窗口。" />
        <SettingsRow label="退出方式" description="退出界面保留后台任务；停止后台须确认受影响任务并等待清理完成。"
          control={<div className="flex flex-wrap gap-2"><ActionButton disabled={busy} onClick={() => void run("quitInterface")}>退出界面，后台继续</ActionButton><ActionButton disabled={busy} onClick={() => void run("stopAndQuit")}>停止后台并退出…</ActionButton></div>} />
        <SettingsRow control={null} label="退出条件" description={!connected ? runningState === "stopped" ? "后台已确认停止。" : "当前未连接，后台是否仍在运行需要检查。" : status?.clients && status.clients > 1 ? "请先退出其他连接同一后台的界面。" : status?.canStop ? "当前检查允许安全停止。" : "阻塞事项列在下方；打开对应对话、任务或进程处理后再检查。"} />
        <SettingsRow label="资源检查与恢复"
          control={<ActionButton disabled={busy} onClick={() => void run("recoverResources")}>检查与恢复</ActionButton>} />
      </SettingsGroupCard>
      {(busy || (reading && refreshing)) && <p role="status" className="settings-section-desc">正在处理…</p>}
      {notice && <p role="status">{notice}</p>}
      {readError && <p role="alert" className="text-destructive">{readError}</p>}
      {actionError && <p role="alert" className="text-destructive">{actionError}</p>}
      {status?.providerUpdating && <p role="status">模型配置正在更新。</p>}
      {!!status?.starting && <p role="status">{status.starting} 个工作区正在启动。</p>}
    </SettingsSection>
    {recovery?.projects.map(project => <SettingsSection key={`recovery-${project.projectId}`} title={project.root.split(/[\\/]/).filter(Boolean).at(-1)}>
      <SettingsGroupCard><SettingsRow label="原后台核查结果" description={project.message}
        control={<span className="text-foreground-subtle">{project.state === "clean" ? "清理已确认" : project.state === "idle" ? "可安全停止" : "待核查"}</span>} /></SettingsGroupCard>
    </SettingsSection>)}
    {status?.projects.slice().sort((a, b) => Number(b.started && !b.restartSafe) - Number(a.started && !a.restartSafe)).map(project => <SettingsSection key={project.projectId} title={project.root.split(/[\\/]/).filter(Boolean).at(-1)}>
      <div data-testid={`service-project-${project.projectId}`}>
        <SettingsGroupCard>
          <SettingsRow label={!project.started ? "工作区尚未启动" : project.restartSafe ? "工作区资源检查通过" : "有事项阻止后台退出"}
            description={!project.started ? "本页不会为读取状态而启动工作区。" : `活动轮次 ${project.activeThreads?.length ?? 0} · 持续目标 ${project.goalThreads?.length ?? 0} · 任务 ${project.activeTasks ?? 0}`}
            control={<span className="text-foreground-subtle">{project.resources?.length ?? 0} 个未清理资源</span>} />
          {project.activeThreads?.map(turn => <div key={turn.turnId} data-testid={`service-active-${turn.threadId}`}><SettingsRow label="正在执行" description={`会话 ${turn.threadId}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, turn.threadId)}>打开对话</Button>} /></div>)}
          {(project.goals ?? project.goalThreads?.map(threadId => ({ threadId, status: "active", objective: "持续目标" })))?.map(goal => <div key={goal.threadId} data-testid={`service-goal-${goal.threadId}`}><SettingsRow label={goal.objective} description={`持续目标 · ${{ active: "活动中", paused: "已暂停", budgetLimited: "已达预算限制", blocked: "受阻" }[goal.status] ?? goal.status}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, goal.threadId, "编辑目标")}>查看目标</Button>} /></div>)}
          {project.tasks?.map(task => <div key={task.id} data-testid={`service-task-${task.id}`}><SettingsRow label={task.objective} description={`${task.mode === "scheduled" ? "定时任务" : "后台任务"} · ${task.paused ? "已暂停，需要手动恢复" : task.running ? "执行中" : task.nextRunAt ? `下次运行 ${new Date(task.nextRunAt * 1000).toLocaleString()}` : "当前未执行"}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onTask(project.projectId, task.id)}>查看任务</Button>} /></div>)}
          {project.queues?.map(queue => <SettingsRow key={queue.threadId} label={queue.paused ? "队列已暂停" : "队列可执行"} description={`待发送 ${queue.pending} · 执行中 ${queue.running}`} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, queue.threadId, "队列")}>查看队列</Button>} />)}
          {project.pendingRequests?.map((request, index) => <SettingsRow key={index} label={request.awaitingResponse ? "请求等待回应" : "操作结果待确认"} description="不会自动重发；请在所属对话检查发送状态。" control={request.threadId ? <Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, request.threadId!)}>打开对话</Button> : <span>项目操作</span>} />)}
          {project.resources?.map(resource => <div key={resource.id} data-testid={`service-resource-${resource.id}`}><SettingsRow label={resource.executable || "受管进程"} description={resource.stale ? "属于旧 Runtime，需要核实清理状态" : "资源尚未确认清理"} control={<Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => onOpen(project.projectId, resource.threadId, "进程")}>查看进程</Button>} /></div>)}
          {project.started && <SpaceReclamation key={project.projectId} projectId={project.projectId} projectName={project.root.split(/[\\/]/).filter(Boolean).at(-1) || "工作区"} action={action} disabled={busy || !connected} onChange={read} />}
        </SettingsGroupCard>
        {!!project.unresolvedTools && <p role="status">{project.unresolvedTools} 项工具执行结果待确认。</p>}
        {!!project.compactions && <p role="status">{project.compactions} 项上下文压缩进行中。</p>}
        {!!project.workgroups && <p role="status">{project.workgroups} 个子任务组尚未结算。</p>}
      </div>
    </SettingsSection>)}
    {status && !status.projects.length && <p className="settings-section-desc">尚未添加工作区。</p>}
  </div>;
}
