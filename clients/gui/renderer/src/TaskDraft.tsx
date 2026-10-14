import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import type { Action, Data } from "./services.js";

export function taskFrequency(seconds?: number) {
  if (!seconds) return "仅一次";
  for (const [size, unit] of [[604800,"周"], [86400,"天"], [3600,"小时"], [60,"分钟"]] as const) {
    if (seconds % size === 0) return `每 ${seconds / size} ${unit}`;
  }
  return `每 ${seconds} 秒`;
}
export type TaskConversationRenderer = (project: Data, thread: Data, beforeTurns?: ReactNode) => ReactNode;
type SavedDraft = { draftId: string; ownerId?: string; threadId?: string; pending?: "start" | "confirm"; failedTurn?: string; text?: string };
const starts = new Map<string, Promise<{ projectId: string; threadId: string }>>();

/** Task management owns admission/recovery only. Messages and Composer belong to the normal conversation. */
export function TaskDraft({ projects, initialProjectId, task, action, disabled, onCreated, onClose, initialText = "", renderConversation, renderResources }: {
  projects: Data[]; initialProjectId?: string; task?: Data; action: Action; disabled: boolean;
  onCreated: (task: Data, projectId: string) => void; onClose: () => void; initialText?: string;
  renderConversation: TaskConversationRenderer; renderResources?: (project: Data, thread: Data) => ReactNode;
}) {
  const storageKey = task ? `areal-gui:task-edit:${initialProjectId}:${task.id}` : `areal-gui:task-draft:${initialProjectId ?? "global"}`;
  const [saved, setSaved] = useState<SavedDraft>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (typeof value?.draftId === "string") return value;
    } catch { /* Local drafts are not execution facts. */ }
    const value = { draftId: crypto.randomUUID(), ownerId: initialProjectId, text: initialText };
    localStorage.setItem(storageKey, JSON.stringify(value));
    return value;
  });
  const current = useRef(saved); current.current = saved;
  const [view, setView] = useState<Data>();
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [opening, setOpening] = useState(false), [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const callbacks = useRef({ onCreated }); callbacks.current = { onCreated };
  const notified = useRef("");
  const project = projects.find(p => p.id === saved.ownerId);
  const persist = (patch: Partial<SavedDraft>) => {
    const next = { ...current.current, ...patch };
    current.current = next; localStorage.setItem(storageKey, JSON.stringify(next)); setSaved(next);
  };
  useEffect(() => {
    if (disabled || saved.threadId || saved.pending === "start") return;
    let live = true;
    setOpening(true); setError("");
    const draft = current.current;
    let start = starts.get(draft.draftId);
    if (!start) {
      start = (async () => {
        const projectId = draft.ownerId ?? (await action("projectless", { operation: "prepare", requestId: draft.draftId })).projectId;
        const prepared = { ...draft, ownerId: projectId };
        localStorage.setItem(storageKey, JSON.stringify(prepared));
        const result = await action("manage", { projectId, operation: "taskDraftStart", draftId: draft.draftId,
          timeZone: task?.schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(task ? { taskId: task.id } : {}) });
        // Seed the ordinary Composer's own draft once. Never overwrite a retained input.
        const inputKey = `areal-gui:draft:${projectId}:${result.threadId}`;
        if (draft.text && localStorage.getItem(inputKey) == null) localStorage.setItem(inputKey, draft.text);
        const next = { ...draft, ownerId: projectId, threadId: result.threadId, pending: undefined, text: undefined };
        localStorage.setItem(storageKey, JSON.stringify(next));
        return { projectId, threadId: result.threadId };
      })();
      starts.set(draft.draftId, start);
    }
    void start.then(result => { if (live) persist({ ownerId: result.projectId, threadId: result.threadId, pending: undefined, text: undefined }); })
      .catch(cause => {
        starts.delete(draft.draftId);
        if (live) { setError(cause.message); if (cause.submissionUnknown) persist({ ownerId: JSON.parse(localStorage.getItem(storageKey)!).ownerId, pending: "start" }); }
      }).finally(() => { starts.delete(draft.draftId); if (live) setOpening(false); });
    return () => { live = false; };
  }, [action, disabled, saved.threadId, saved.ownerId, saved.pending, retry]);
  useEffect(() => {
    if (!saved.threadId || !project?.state?.connected) return;
    let live = true, reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        let result = await action("manage", { projectId: project.id, operation: "taskDraftRead", threadId: saved.threadId });
        if (!live) return;
        setReadError(""); setView(result);
        if (current.current.failedTurn && current.current.failedTurn !== result.turnId) setError("");
        // Read-only recovery never replays an unknown or failed save.
        if (result.proposal && !result.running && !result.error && !current.current.pending && current.current.failedTurn !== result.turnId && !disabled) {
          setSaving(true); persist({ pending: "confirm" });
          try {
            await action("manage", { projectId: project.id, operation: "taskDraftConfirm", threadId: saved.threadId,
              turnId: result.turnId, digest: result.digest });
            const next = await action("manage", { projectId: project.id, operation: "taskDraftRead", threadId: saved.threadId });
            if (!live) return;
            result = next; persist({ pending: undefined, failedTurn: undefined }); setError(""); setView(result);
          } catch (cause) {
            if (!live) return;
            const failure = cause as Error & { submissionUnknown?: boolean };
            persist({ pending: failure.submissionUnknown ? "confirm" : undefined, failedTurn: result.turnId }); setError(failure.message);
          } finally { if (live) setSaving(false); }
        }
        if (result.task) {
          setSaving(false);
          if (current.current.pending === "confirm") persist({ pending: undefined });
          const stamp = `${result.task.id}:${result.task.revision}`;
          if (notified.current !== stamp) {
            notified.current = stamp;
            if (!task) localStorage.removeItem(storageKey);
            callbacks.current.onCreated(result.task, project.id);
          }
        }
      } catch (cause) { if (live) setReadError((cause as Error).message); }
      finally { reading = false; }
    };
    void read(); const timer = window.setInterval(() => void read(), 1000);
    return () => { live = false; clearInterval(timer); };
  }, [action, saved.threadId, project?.id, project?.state?.connected, disabled, retry]);
  const thread = view?.thread;
  const empty = thread && !thread.turns?.length;
  const welcome = <div className="task-create-welcome"><CalendarClock size={36}/><h2>让 Agent 定时帮你完成任务</h2><p>告诉我需要做什么、什么时候执行。</p><div className="task-examples">{[
    ["项目进展日报", "每天上午 9 点，整理项目提交、PR 和需要我关注的事项。"],
    ["跟踪产品更新", "每周一上午 9 点，汇总关注项目的新变化并附上来源。"],
  ].map(([title, text]) => <button key={title} onClick={() => {
    const key = `areal-gui:draft:${project!.id}:${thread.id}`;
    localStorage.setItem(key, text); window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
  }}><h3>{title}</h3><p>{text}</p></button>)}</div></div>;
  // Keep all message/history/attachment rendering in the existing components.
  const owner = project && { ...project, state: { ...project.state, connected: project.state?.connected && !disabled && !saving && !task?.cancelled && !readError && !current.current.pending } };
  return <main className="task-conversation" aria-label={task ? "定时任务会话" : "新建定时任务"}>
    <header><h2>{task?.objective ?? "新建任务"}</h2>{task && project && thread && renderResources?.(project, thread)}
      <Button size="icon-sm" variant="ghost" aria-label={task ? "关闭任务详情" : "关闭创建对话"} onClick={onClose}><X size={16}/></Button></header>
    {!task && !saved.threadId && <div className="task-plan-summary"><Select value={saved.ownerId ?? "independent"} disabled={opening || !!saved.pending} onValueChange={value => persist({ ownerId: value === "independent" ? undefined : value! })}><SelectTrigger aria-label="任务归属"><SelectValue>{project?.name ?? "独立任务"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="independent">独立任务</SelectItem>{projects.filter(p => !p.projectless).map(p => <SelectItem key={p.id} value={p.id}>{p.name ?? p.root}</SelectItem>)}</SelectContent></Select></div>}
    {(error || readError || view?.error) && <p role="alert" className="task-plan-note task-draft-error">{error || readError || view?.error}</p>}
    {saved.pending && <p role="status" className="task-plan-note">{saving ? "正在保存任务安排…" : "提交结果尚未确认，请核对当前任务；不会自动重复提交。"}{!saving && <Button variant="ghost" disabled={!project?.state?.connected} onClick={() => {void action("reconcile", {projectId: project!.id}).then(result => {if (saved.pending === "start" && result.outcomes?.[saved.draftId]?.accepted) {persist({pending:undefined});setRetry(n => n + 1);}}).catch(cause => setError(cause.message));}}>核对受理状态</Button>}</p>}
    {!thread && <div className="task-conversation-pending" role="status">{opening ? "正在打开会话…" : "会话尚未打开。"}<Button variant="ghost" disabled={opening || disabled || !!saved.pending} onClick={() => setRetry(n => n + 1)}>重新读取</Button></div>}
    {owner && thread && <div className="task-conversation-body"><section className="task-chat-pane">{renderConversation(owner, thread, empty ? welcome : undefined)}</section>
    </div>}
  </main>;
}
