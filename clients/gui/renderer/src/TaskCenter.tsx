import { scheduleZone, runZone } from "./TaskRunConversations.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import { Plus, Search, ListFilter, ArrowRight, CalendarClock, GitPullRequest, FileSearch, ListChecks, Newspaper, BookOpen, Activity } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem } from "./components/ui/dropdown-menu.js";
import { SidebarToggleIcon } from "./homeChromeIcons.js";
import { TaskDraft, triggerExplanation, type TaskConversationRenderer } from "./TaskDraft.js";
import "./TaskCenter.css";
import type { Action, Data } from "./services.js";
import { GoalUsageSummary } from "./GoalUsage.js";
import { goalBudgetMessage } from "./conversationPresentation.js";

type HistoryReadMode = "head" | "more" | "refresh";
type RunHistory = { owner: string; enabled: boolean | null; runNow: boolean; data: Data[]; nextCursor: string | null; runCount: number; headRunCount: number; pending: boolean; error: string; retryMode: HistoryReadMode; needsRefresh: boolean };
const emptyRunHistory = (owner = ""): RunHistory => ({ owner, enabled: null, runNow: false, data: [], nextCursor: null, runCount: 0, headRunCount: 0, pending: false, error: "", retryMode: "head", needsRefresh: false });
const mergeRuns = (previous: Data[], next: Data[]) => [...new Map([...previous, ...next].map(run => [run.id, run])).values()];

type CatalogIdentity = { requestId: string; viewEpoch: number };
type OwnerRows = { data: Data[]; hasMore: boolean; readAt: number; connectionGeneration: number };
type OwnerRead =
  | { status: "pending"; identity: CatalogIdentity; previous?: OwnerRows }
  | { status: "ready"; identity: CatalogIdentity; value: OwnerRows }
  | { status: "error"; identity: CatalogIdentity; message: string; previous?: OwnerRows };
const ownerRows = (read?: OwnerRead) => read?.status === "ready" ? read.value : read?.previous;
const catalogTrace = (kind: "begin" | "response_received" | "epoch_discarded" | "owner_committed" | "end" | "abandoned", identity: CatalogIdentity, projectId?: string, rows?: number) => {
  console.info(`[task-catalog] ${JSON.stringify({ kind, ...identity, ...(projectId ? { projectId } : {}), ...(rows === undefined ? {} : { rows }), at: performance.now() })}`);
};

const statusLabels: Record<string, string> = { queued: "已受理，等待开始", running: "运行中", waitingForInput: "等待回答", waitingForAgents: "等待 worker", paused: "已暂停", blocked: "受阻", completed: "已完成", failed: "失败", cancelled: "已取消" };
const terminal = (run?: Data) => !!run && ["completed", "failed", "cancelled"].includes(run.status);
const missedOnce = (task: Data) => task.lastTriggerDecision?.outcome?.kind === "missedWindow" && task.nextRunAt == null && !task.runs?.some((run: Data) => !terminal(run));
const finished = (task: Data) => (terminal(task.runs?.at(-1)) || missedOnce(task)) && task.nextRunAt == null;
// Task flags acknowledge durable control intent. Run and worker facts describe
// whether execution has actually stopped; a receipt alone cannot settle it.
const stopping = (task: Data) => task.cancelled && task.runs.some((run: Data) =>
  run.workers?.some((worker: Data) => !worker.settled) || !terminal(run) && (task.cancelled || run.status !== "paused"));
const date = (seconds: number | null, zone?: string) => {
  if (seconds == null) return "—";
  try { return new Date(seconds * 1000).toLocaleString(undefined, zone ? {timeZone: zone} : undefined); }
  catch { return new Date(seconds * 1000).toLocaleString(undefined, {timeZone: "UTC"}); }
};
// Shutdown can retain a paused flag on finished tasks. Preserve the outcome;
// a recurring schedule with another run still has a meaningful paused state.
const taskStatus = (task: Data) => stopping(task) ? task.cancelled ? "正在取消，等待执行结算" : "正在暂停，等待执行结算" : task.cancelled ? "已取消" : missedOnce(task) ? "已错过" : finished(task) ? statusLabels[task.runs.at(-1).status] : task.paused ? "已暂停" : statusLabels[task.runs?.at(-1)?.status] ?? "等待计划时间";
const runReasons: Record<string, string> = {
  "task token budget exhausted": "任务总 Token 预算已用完。本次运行不能增加额度；如需更多预算，请创建新任务。",
  approvalExpired: "审批已过期，执行已受阻。继续本次运行将重新检查并申请批准。",
  hostUnavailable: "桌面 Host 已断开，需要明确继续本次运行。",
  stopRequested: "正在停止本次运行，等待资源结算。",
  resumeRequested: "正在准备继续本次运行。",
  usageUnknown: "用量尚未确认，运行已受阻。",
  goalBudget: "已达到运行预算，请在执行会话中调整目标后恢复。",
  // Core 打开持久化任务时，把未结束 Run 记为 serverRestarted。这是重启事实，不能把内部代码直接给用户。
  serverRestarted: "Core 重启后这次运行已暂停。需要明确恢复后才会继续。",
};
const scheduledTokenLimit = (task: Data, reason: string) => task.mode === "scheduled" && reason === "GOAL_TOKEN_BUDGET";
const runReason = (reason: string, task: Data) => scheduledTokenLimit(task, reason)
  ? "周期任务剩余 Token 预算不足。单次运行不能突破任务总预算；如需更多额度，请创建新的周期任务。"
  : goalBudgetMessage(reason) ?? runReasons[reason] ?? reason;
type Props = { projects: Data[]; connected: boolean; initialProjectId?: string; defaultProjectId?: string; action: Action; onOpenThread: (projectId: string, id: string) => void; onOpenModelSettings: () => void };
const taskKey = (task: Data) => `${task.projectId}:${task.id}`;
const projectLabel = (project: Data) => project.name ?? project.root?.split(/[\\/]/).pop() ?? "项目";

const pendingReplyPrefix = "areal-gui:channel-pending:";
const channelStatus: Record<string, string> = { pending: "待回答", answered: "已回答", expired: "已过期", cancelled: "已取消", published: "已发布" };
const channelKind: Record<string, string> = { question: "问题", reply: "回答", report: "运行报告", workerReport: "worker 报告" };
// Settlement is the Core pair status/settled. A failed worker stays failed;
// pause or cancel while unsettled is still settling, not success.
function workerSettlement(task: Data, run: Data, worker: Data) {
  if (!worker.settled && (task.cancelled || ["stopRequested","hostUnavailable"].includes(run.reason))) return "结算中";
  if (!worker.settled) return "运行中";
  if (worker.status === "failed") return "失败";
  if (worker.status === "cancelled") return "已取消";
  if (worker.status === "completed") return "成功";
  return String(worker.status ?? "");
}
function WorkerParticipant({ task, run, worker, messages, project, onOpenThread }: { task: Data; run: Data; worker: Data; messages: Data[]; project: Data; onOpenThread: (projectId: string, id: string) => void }) {
  const report = messages.filter(message => message.kind === "workerReport" && message.runId === run.id && message.author === worker.threadId).reduce<Data | undefined>((best, item) => !best || item.sequence > best.sequence ? item : best, undefined);
  return <section aria-label={`worker ${worker.threadId}`} data-worker-thread={worker.threadId} data-worker-turn={worker.turnId} className="grid gap-2 border-t border-border pt-2">
    <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-medium">worker</h5><span role="status" className="text-foreground-subtle">{workerSettlement(task, run, worker)}</span></div>
    <p className="break-all text-foreground-subtle">{worker.threadId}</p>
    <p className="break-all text-foreground-subtle">{worker.turnId}</p>
    <Button className="justify-self-start" size="sm" variant="ghost" disabled={!project.state?.connected} onClick={() => onOpenThread(project.id, worker.threadId)}>打开 worker 会话</Button>
    <div className="grid gap-1"><p className="text-foreground-subtle">工作记录</p>{report?.text ? <p className="whitespace-pre-wrap break-words">{report.text}</p> : <p className="text-foreground-subtle">工作记录尚未发布</p>}</div>
  </section>;
}

function ChannelRecord({ message, task, projectId, action, disabled, onReplied }: { message: Data; task: Data; projectId: string; action: Action; disabled: boolean; onReplied: () => void }) {
  if (message.kind === "question" && message.status === "pending") {
    return <ChannelQuestion row={{ taskId: task.id, objective: task.objective, message }} projectId={projectId} action={action} disabled={disabled} showTitle={false} onReplied={onReplied} />;
  }
  return <article data-channel-message-id={message.id} data-question-id={message.kind === "question" ? message.id : undefined} className="grid gap-1 border-t border-border pt-2">
    <p className="text-foreground-subtle">{channelKind[message.kind] ?? message.kind} · {channelStatus[message.status] ?? message.status}</p>
    {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
    {message.questions?.map((question: Data) => <p key={question.id}>{question.title}{message.answers?.[question.id] && `：${message.answers[question.id]}`}</p>)}
    {message.kind === "reply" && Object.entries(message.answers ?? {}).map(([id, answer]) => <p key={id}>{String(answer)}</p>)}
  </article>;
}

// Pending markers describe a GUI submission, not a Core execution fact. Only
// registered projects may contribute retained drafts to the global Inbox.
export function pendingChannelQuestions(projects: Data[]): Data[] {
  const allowed = new Set(projects.map(project => project.id));
  const rows: Data[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(pendingReplyPrefix)) continue;
    try {
      const { row } = JSON.parse(localStorage.getItem(key) ?? "null");
      if (allowed.has(row?.projectId) && typeof row.taskId === "string" && typeof row.message?.id === "string" && typeof row.message.runId === "string" && Array.isArray(row.message.questions)) rows.push(row);
    } catch { /* An unreadable draft cannot become an execution record. */ }
  }
  return rows;
}

export function ChannelQuestion({ row, projectId, action, disabled, onReplied, showTitle = true, freshness }: { freshness?: "live" | "cached"; row: Data; projectId: string; action: Action; disabled: boolean; onReplied: () => void; showTitle?: boolean }) {
  const message = row.message;
  const owner = `${projectId}:${row.taskId}:${message.runId}:${message.id}`;
  const key = `areal-gui:channel-reply:${owner}`, pendingKey = `${pendingReplyPrefix}${owner}`;
  // Existing channel drafts predate the explicit Run segment. The question ID
  // already identifies that original Run; consume the old draft on first edit.
  const legacyKey = `areal-gui:channel-reply:${projectId}:${row.taskId}:${message.id}`;
  const [answers, setAnswers] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(key) ?? localStorage.getItem(legacyKey) ?? "{}"); } catch { return {}; } });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [submitted, setSubmitted] = useState(false);
  const [unknown, setUnknown] = useState(() => localStorage.getItem(pendingKey) !== null);
  const locked = useRef(false);
  const inactive = message.status !== "pending";
  const expired = message.expiresAt != null && message.expiresAt * 1000 <= Date.now();
  const change = (id: string, text: string) => { const next = { ...answers, [id]: text }; setAnswers(next); localStorage.setItem(key, JSON.stringify(next)); localStorage.removeItem(legacyKey); };
  const confirmed = () => { localStorage.removeItem(key); localStorage.removeItem(legacyKey); localStorage.removeItem(pendingKey); setUnknown(false); setSubmitted(true); onReplied(); };
  const submit = async () => {
    if (locked.current || submitted || unknown || disabled || expired || inactive) return;
    locked.current = true; setBusy(true); setError("");
    try {
      localStorage.setItem(pendingKey, JSON.stringify({ row: { ...row, projectId }, answers }));
      const result = await action("manage", { projectId, operation: "taskReply", taskId: row.taskId, runId: message.runId, questionId: message.id, answers });
      if (result?.accepted !== true || result.taskId !== row.taskId || result.runId !== message.runId || result.questionId !== message.id) throw Object.assign(new Error("回答回执与原任务运行不符，请核对原频道。"), { submissionUnknown: true });
      confirmed();
    } catch (cause) {
      if ((cause as Error & { submissionUnknown?: boolean }).submissionUnknown) setUnknown(true);
      else localStorage.removeItem(pendingKey);
      setError((cause as Error).message); onReplied();
    } finally { locked.current = false; setBusy(false); }
  };
  const reconcile = async () => {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const pending = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
      if (!pending) throw new Error("待核对记录已变化，请刷新 Inbox。");
      let afterSequence = 0; const messages: Data[] = [];
      for (;;) {
        const page = await action("manage", { projectId, operation: "taskChannel", taskId: row.taskId, afterSequence, limit: 100 });
        messages.push(...page.data);
        if (!page.hasMore) break;
        if (page.nextSequence <= afterSequence) throw new Error("频道读取未前进，请刷新后重试");
        afterSequence = page.nextSequence;
      }
      const question = messages.find(item => item.id === message.id && item.runId === message.runId && item.kind === "question");
      const matches = (value: Data) => value && Object.keys(value).length === Object.keys(pending.answers).length && Object.entries(pending.answers).every(([id, answer]) => value[id] === answer);
      const reply = messages.find(item => item.kind === "reply" && item.runId === message.runId && item.inReplyTo === message.id && matches(item.answers));
      if (question?.status === "answered" && matches(question.answers) && reply) confirmed();
      else setError("原频道尚未确认这份回答。已保留输入，不会自动重发。");
    } catch (cause) { setError((cause as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  return <article data-question-id={message.id} data-channel-message-id={message.id} className="grid gap-2 rounded-control border border-border p-3">
    {showTitle && <h3 className="font-medium">{row.objective}</h3>}{row.projectName && <p className="text-foreground-subtle">{row.projectName}</p>}<p className="text-foreground-subtle">{message.required ? "需要回答" : "可补充回答"} · {message.expiresAt ? `截止 ${date(message.expiresAt)}` : "无截止时间"}</p>
    {freshness && <p className="text-foreground-subtle">{freshness === "live" ? "实时问题" : "缓存问题，尚未重新确认"}</p>}
    {(inactive || expired) && <p>{expired && message.status === "pending" ? "已过期" : ({ answered: "已回答", cancelled: "已取消", expired: "已过期" } as Record<string, string>)[message.status] ?? "问题已结束"}</p>}
    {message.status === "answered" && message.answers && <p>已接受的回答：{Object.values(message.answers).join("；")}</p>}
    {message.questions.map((q: Data) => <label key={q.id} className="grid gap-1">{q.title}{q.allowFreeText ? <Textarea aria-label={q.title} value={answers[q.id] ?? ""} disabled={busy || submitted || unknown || disabled || expired || inactive} onChange={e => change(q.id, e.target.value)} placeholder={q.options?.join(" / ")} /> : <Select value={answers[q.id] ?? ""} disabled={busy || submitted || unknown || disabled || expired || inactive} onValueChange={v => { if (v) change(q.id, v); }}><SelectTrigger aria-label={q.title}><SelectValue placeholder="请选择" /></SelectTrigger><SelectContent>{q.options.map((v: string) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select>}</label>)}
    {unknown && <p role="alert">回答提交结果尚未确认，不会重复发送。</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex gap-2"><Button size="sm" disabled={busy || submitted || unknown || disabled || expired || inactive || message.questions.some((q: Data) => !answers[q.id]?.trim() || new TextEncoder().encode(answers[q.id]).length > 4096)} onClick={() => void submit()}>{submitted ? "已提交" : busy ? "提交中…" : "提交回答"}</Button>
      {unknown && <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => void reconcile()}>核对回答</Button>}
    </div>
  </article>;
}

export function TaskCenter({ projects, connected, initialProjectId, defaultProjectId, action, onOpenThread, onOpenModelSettings, navigation, target, renderConversation, renderResources }: Props & { navigation: ReactNode; renderConversation: TaskConversationRenderer; renderResources: (project: Data, thread: Data, task: Data, history: ReactNode, revealKey?: string) => ReactNode; target?: { projectId: string; taskId: string; runId?: string; questionId?: string; eventId?: string } }) {
  const { t } = useI18n();
  const layout = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!layout.current) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 760));
    observer.observe(layout.current); return () => observer.disconnect();
  }, []);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searching, setSearching] = useState(false), [search, setSearch] = useState("");
  const [filters, setFilters] = useState(["已开启","已暂停","已完成"]);
  const [draftProjectId, setDraftProjectId] = useState<string>();
  const [initialText, setInitialText] = useState("");
  const [catalog, setCatalog] = useState<Record<string, OwnerRead>>({});
  const committedOwners = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    for (const [projectId, read] of Object.entries(catalog)) {
      if (read.status === "pending") continue;
      const identity = `${read.identity.viewEpoch}:${read.identity.requestId}`;
      if (committedOwners.current.get(projectId) === identity) continue;
      committedOwners.current.set(projectId, identity);
      catalogTrace("owner_committed", read.identity, projectId, ownerRows(read)?.data.length ?? 0);
    }
  }, [catalog]);
  const [messages, setMessages] = useState<Data[]>([]);
  const [history, setHistory] = useState<RunHistory>(() => emptyRunHistory());
  const historyEpoch = useRef(0);
  const readRuns = useRef<(mode?: HistoryReadMode) => Promise<void>>(async () => {});
  const rows = Object.values(catalog).flatMap(read => ownerRows(read)?.data ?? []);
  const failedProjects = projects.filter(project => catalog[project.id]?.status === "error").map(project => project.id);
  const loading = connected && projects.some(project => !catalog[project.id] || catalog[project.id].status === "pending");
  const initialLoading = connected && projects.some(project => !catalog[project.id] || catalog[project.id].status === "pending" && !ownerRows(catalog[project.id]));
  const fresh = connected && projects.every(project => catalog[project.id]?.status === "ready");
  const hasMore = Object.values(catalog).some(read => ownerRows(read)?.hasMore);
  const [selected, setSelected] = useState(() => sessionStorage.getItem("areal-gui:selected-global-task") ?? ""), [creating, setCreating] = useState(false);
  const selection = useRef({ selected, projects, target });
  selection.current = { selected, projects, target };
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [viewId] = useState(() => {
    const key = "areal-gui:global-task-view";
    const id = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, id); return id;
  });
  useEffect(() => {
    if (!target) return;
    setCreating(false); setSelected(`${target.projectId}:${target.taskId}`); setDetailsOpen(true);
  }, [target]);
  const focusedTarget = useRef<string | undefined>(undefined);
  const sequence = useRef(0), mutation = useRef(false);
  const refreshRead = useRef<(more?: boolean, retryProjectId?: string) => Promise<void>>(async () => {});
  const pages = useRef(1);
  const [controlView, setControlView] = useState<Data | null>(null);
  const [channelError, setChannelError] = useState("");
  const [confirmedWatch, setConfirmedWatch] = useState<{ owner: string; generation: number } | null>(null);
  const listed: Data[] = [];
  let projectedHasMore = false;
  for (const owner of projects) {
    const byId = new Map<string, Data>(rows.filter(row => row.projectId === owner.id).map(row => [row.id, row]));
    for (const live of Object.values<Data>(owner.state?.tasks ?? {})) {
      if (live.mode !== "scheduled") continue;
      const previous = byId.get(live.id);
      if (!previous && ownerRows(catalog[owner.id]) && `${owner.id}:${live.id}` !== selected) continue;
      if (previous && (live.revision < previous.revision || (live.channelSequence ?? 0) < (previous.channelSequence ?? 0))) continue;
      byId.set(live.id, { ...live, projectId: owner.id, projectName: previous?.projectName ?? projectLabel(owner), scope: owner.projectless ? "independent" : "project" });
    }
    const ordered = [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const limit = Math.min(1024, 30 * pages.current);
    projectedHasMore ||= ordered.length > limit;
    listed.push(...ordered.filter((row, index) => index < limit || taskKey(row) === selected));
  }
  const moreAvailable = hasMore || projectedHasMore;
  const listedTask: Data | undefined = listed.find(t => taskKey(t) === selected);
  // The control receipt is the Core response for this pause or cancel. Keep it
  // visible until the following read returns, including when a newer snapshot
  // has already settled the same workers.
  const task = controlView && taskKey(controlView) === selected ? controlView : listedTask;
  const project = projects.find(p => p.id === task?.projectId);
  useEffect(() => {
    const epoch = ++historyEpoch.current;
    const owner = task && project ? `${project.id}:${task.id}` : "";
    setHistory(emptyRunHistory(owner));
    readRuns.current = async () => {};
    if (!task || !project?.state?.connected || !connected) return;
    const projectId = project.id, taskId = task.id;
    let enabled: boolean | null = null, loading = false;
    let cursor: string | null = null, headRunCount: number | null = null;
    const seenCursors = new Set<string>();
    const current = () => historyEpoch.current === epoch && selection.current.selected === owner;
    const read = async (mode: HistoryReadMode = "head") => {
      const more = mode === "more";
      if (!current() || loading || more && !cursor) return;
      loading = true;
      setHistory(previous => ({ ...previous, pending: true, error: "", retryMode: mode }));
      try {
        if (enabled === null) {
          const capabilities = await action("manage", { projectId, operation: "taskHistoryCapabilities" });
          if (!current()) return;
          enabled = capabilities.enabled === true;
          setHistory(previous => ({ ...previous, enabled, runNow: capabilities.runNow === true }));
        }
        if (!enabled) return;
        const page = await action("manage", { projectId, operation: "taskRuns", taskId, ...(more ? { cursor } : {}), limit: 100 });
        if (!current()) return;
        if (!Array.isArray(page.data) || !Number.isSafeInteger(page.runCount) || page.runCount < 0
          || typeof page.hasMore !== "boolean" || page.hasMore && (typeof page.nextCursor !== "string" || !page.nextCursor || more && (page.nextCursor === cursor || seenCursors.has(page.nextCursor)))) throw new Error("运行记录分页未前进，请重试读取。");
        const reset = mode === "refresh" || headRunCount === null;
        const gap = !more && !reset && headRunCount !== null && page.runCount - headRunCount > page.data.length;
        if (more && cursor) seenCursors.add(cursor);
        if (reset) seenCursors.clear();
        if (more || reset) cursor = page.hasMore ? page.nextCursor : null;
        if (!more) headRunCount = page.runCount;
        setHistory(previous => ({ ...previous, data: mode === "refresh" ? page.data : mergeRuns(previous.data, page.data), nextCursor: cursor, runCount: Math.max(previous.runCount, page.runCount), headRunCount: more ? previous.headRunCount : page.runCount, needsRefresh: reset ? false : previous.needsRefresh || gap }));
      } catch (cause) {
        if (current()) setHistory(previous => ({ ...previous, error: (cause as Error).message }));
      } finally {
        loading = false;
        if (current()) setHistory(previous => ({ ...previous, pending: false }));
      }
    };
    readRuns.current = read;
    void read();
    return () => { historyEpoch.current++; };
  }, [action, connected, project?.id, project?.state?.connected, project?.core?.connectionGeneration, task?.id]);
  useEffect(() => {
    if (history.owner === selected && history.enabled && !history.pending && !history.error && task?.runCount > history.headRunCount) void readRuns.current();
  }, [history.owner, history.enabled, history.pending, history.error, history.headRunCount, selected, task?.runCount]);
  const historyRuns = history.owner === selected ? history.data : [];
  const displayedRuns = mergeRuns(historyRuns, task?.runs ?? []).sort((a, b) => b.scheduledAt - a.scheduledAt || String(b.id).localeCompare(String(a.id)));
  const [targetRead, setTargetRead] = useState<{ target: typeof target; epoch: number; status: "pending" | "ready" | "error"; error: string } | null>(null);
  useEffect(() => {
    if (!target?.runId || targetRead?.target === target && targetRead.epoch === historyEpoch.current || !history.enabled || history.owner !== selected
      || selected !== `${target.projectId}:${target.taskId}` || displayedRuns.some(run => run.id === target.runId)) return;
    const epoch = historyEpoch.current;
    setTargetRead({ target, epoch, status: "pending", error: "" });
    void action("manage", { projectId: target.projectId, operation: "taskRun", taskId: target.taskId, runId: target.runId }).then(run => {
      if (epoch !== historyEpoch.current || selection.current.selected !== history.owner || selection.current.target !== target) return;
      if (run.id !== target.runId) throw new Error("运行记录与通知目标不匹配。");
      setHistory(previous => ({ ...previous, data: mergeRuns(previous.data, [run]) }));
      setTargetRead({ target, epoch, status: "ready", error: "" });
    }).catch(cause => {
      if (epoch === historyEpoch.current && selection.current.selected === history.owner && selection.current.target === target) setTargetRead({ target, epoch, status: "error", error: cause.message });
    });
  }, [action, target, targetRead, selected, history.enabled, history.owner, displayedRuns]);
  const pending = project?.pending?.filter((p: Data) => p.method.startsWith("areal/task/") || p.method === "areal/channel/reply") ?? [];
  const ownerFailed = !!project && failedProjects.includes(project.id);
  const watchConfirmed = confirmedWatch?.owner === selected && confirmedWatch?.generation === (project?.core?.connectionGeneration ?? 0);
  const disabled = !watchConfirmed || !connected || !project?.state?.connected || busy || pending.length > 0 || ownerFailed;
  useEffect(() => { sessionStorage.setItem("areal-gui:selected-global-task", selected); }, [selected]);
  const channelEpoch = useRef(0);
  const loadedChannelOwner = useRef("");
  // 失败或迟到的读取不能替换已经显示的频道记录。
  // 只有这次分页完整结束、且该任务仍是当前选择时，才用新结果替换。
  const readChannel = useCallback(async (projectId: string, taskId: string) => {
    const epoch = ++channelEpoch.current;
    const owner = `${projectId}:${taskId}`;
    try {
      let afterSequence = 0;
      const byId = new Map<string, Data>();
      for (;;) {
        const page = await action("manage", { projectId, operation: "taskChannel", taskId, afterSequence, limit: 100 });
        if (epoch !== channelEpoch.current || selection.current.selected !== owner) return;
        for (const message of page.data) {
          const previous = byId.get(message.id);
          if (!previous || previous.sequence < message.sequence) byId.set(message.id, message);
        }
        if (!page.hasMore) break;
        if (page.nextSequence <= afterSequence) throw new Error("频道读取未前进，请刷新后重试");
        afterSequence = page.nextSequence;
      }
      if (epoch !== channelEpoch.current || selection.current.selected !== owner) return;
      setMessages([...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence));
      setChannelError("");
    } catch (cause) {
      if (epoch !== channelEpoch.current || selection.current.selected !== owner) return;
      setChannelError((cause as Error).message);
    }
  }, [action]);
  const refresh = useCallback((more = false, retryProjectId?: string) => refreshRead.current(more, retryProjectId), []);
  const projectIds = projects.map(project => `${project.id}:${!!project.state?.connected}:${project.core?.connectionGeneration ?? 0}`).join(":");
  useEffect(() => {
    const viewEpoch = ++sequence.current;
    const inFlight = new Set<string>(), failed = new Set<string>();
    const batches = new Set<CatalogIdentity>();
    let active = true;
    const owners = selection.current.projects;
    setCatalog(previous => Object.fromEntries(owners.flatMap(owner => previous[owner.id] ? [[owner.id, previous[owner.id]]] : [])));
    const read = async (more = false, retryProjectId?: string) => {
      if (!active || !connected || more && inFlight.size > 0) return;
      if (more) pages.current++;
      if (retryProjectId) failed.delete(retryProjectId);
      const available = owners.filter(owner => !inFlight.has(owner.id) && !failed.has(owner.id) && (!retryProjectId || owner.id === retryProjectId));
      if (!available.length) return;
      const identity = { requestId: crypto.randomUUID(), viewEpoch };
      batches.add(identity); catalogTrace("begin", identity);
      await Promise.all(available.map(async owner => {
        inFlight.add(owner.id);
        setCatalog(previous => ({ ...previous, [owner.id]: { status: "pending", identity, previous: ownerRows(previous[owner.id]) } }));
        try {
          const result = await action("tasks", { operation: "list", projectId: owner.id, limit: Math.min(1024, 30 * pages.current), ...identity });
          catalogTrace("response_received", identity, owner.id, result.data.length);
          if (!active) { catalogTrace("epoch_discarded", identity, owner.id); return; }
          if (result.projectId !== owner.id || result.requestId !== identity.requestId || result.viewEpoch !== viewEpoch) throw new Error("后台任务目录响应身份不匹配，请更新后台后重试。");
          if (result.errors.length) throw new Error(result.errors.map((error: Data) => error.message).join("\n"));
          const value = { data: result.data, hasMore: result.hasMore, readAt: Date.now(), connectionGeneration: result.owners[0].connectionGeneration };
          setCatalog(previous => ({ ...previous, [owner.id]: { status: "ready", identity, value } }));
        } catch (cause) {
          if (!active) { catalogTrace("epoch_discarded", identity, owner.id); return; }
          failed.add(owner.id);
          setCatalog(previous => ({ ...previous, [owner.id]: { status: "error", identity, message: (cause as Error).message, previous: ownerRows(previous[owner.id]) } }));
        } finally { inFlight.delete(owner.id); }
      }));
      if (batches.delete(identity)) catalogTrace("end", identity);
    };
    refreshRead.current = read;
    void read();
    const timer = window.setInterval(() => { if (!mutation.current) void read(); }, 3000);
    return () => {
      active = false; clearInterval(timer);
      for (const identity of batches) catalogTrace("abandoned", identity);
      batches.clear();
    };
  }, [action, connected, projectIds]);
  useEffect(() => {
    setConfirmedWatch(null);
    if (!task || !connected || !project?.state?.connected || ownerFailed) return;
    let live = true;
    const confirmation = { owner: taskKey(task), generation: project.core?.connectionGeneration ?? 0 };
    void action("manage", { projectId: project.id, operation: "taskWatch", taskId: task.id, viewId })
      .then(() => { if (live) setConfirmedWatch(confirmation); })
      .catch(cause => { if (live) { setConfirmedWatch(null); setError(cause.message); } });
    return () => { live = false; setConfirmedWatch(null); void action("manage", { projectId: project.id, operation: "taskUnwatch", viewId }).catch(() => {}); };
  }, [action, connected, ownerFailed, project?.id, project?.state?.connected, project?.core?.connectionGeneration, task?.id, viewId]);
  useLayoutEffect(() => {
    const owner = task && project ? `${project.id}:${task.id}` : "";
    if (loadedChannelOwner.current === owner) return;
    loadedChannelOwner.current = owner;
    channelEpoch.current++;
    setMessages([]);
    setChannelError("");
  }, [project?.id, task?.id]);
  useEffect(() => {
    if (!task || !project?.state?.connected) return;
    void readChannel(project.id, task.id);
    return () => { channelEpoch.current++; };
  }, [project?.id, project?.state?.connected, readChannel, task?.channelSequence, task?.id]);
  const revealKey = target && selected === `${target.projectId}:${target.taskId}` ? target.eventId : undefined;
  useEffect(() => {
    if (!target || !revealKey || !target.runId && !target.questionId || focusedTarget.current === revealKey) return;
    const notification = target;
    let observedRoot = false;
    const observer = new MutationObserver(focus);
    const deadline = window.setTimeout(() => observer.disconnect(), 15000);
    function settle() {
      focusedTarget.current = revealKey;
      observer.disconnect();
      clearTimeout(deadline);
    }
    function focus() {
      const historyRoot = [...document.querySelectorAll<HTMLElement>("[data-task-history-owner]")].find(element => element.dataset.taskHistoryOwner === selected);
      if (!historyRoot) { if (observedRoot) settle(); return; }
      observedRoot = true;
      const attribute = notification.questionId ? "data-question-id" : "data-run-id";
      const id = notification.questionId ?? notification.runId;
      const element = [...historyRoot.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(candidate => candidate.getAttribute(attribute) === id);
      if (!element) return;
      element.scrollIntoView({ block: "nearest" });
      element.querySelector<HTMLElement>('textarea, button, [role="combobox"]')?.focus({ preventScroll: true });
      settle();
    }
    observer.observe(document.body, { childList: true, subtree: true });
    focus();
    return () => { observer.disconnect(); clearTimeout(deadline); };
  }, [target, selected, revealKey, targetRead?.status]);
  const control = async (operation: string, runId?: string) => {
    if (!task || !project || disabled || mutation.current) return;
    const owner = selected;
    const current = () => selection.current.selected === owner;
    mutation.current = true; setBusy(true); setError("");
    try {
      const receipt = await action("manage", { projectId: project.id, operation, taskId: task.id, expectedRevision: task.revision, ...(runId ? {expectedRunId:runId} : {}) });
      if (current() && receipt?.id) {
        const view = { ...task, ...receipt, projectId: project.id, projectName: task.projectName, scope: task.scope };
        flushSync(() => { setControlView(view); });
        // A following read can settle in the same turn. Leave the receipt on
        // screen for one frame so that pause/cancel settling is visible.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      await refresh(); setControlView(null);
    }
    catch (cause) { setControlView(null); if (current()) setError((cause as Error).message); await action("manage", { projectId: project.id, operation: "task", taskId: task.id }).catch(() => {}); }
    finally { mutation.current = false; setBusy(false); }
  };
  const beginCreate = (text = "") => {
    if (creating) return;
    setInitialText(text); setDraftProjectId(initialProjectId ?? defaultProjectId); setCreating(true);
  };
  const activeRun = task?.runs?.find((run: Data) => !terminal(run));
  const detailOpen = creating || !!task && !!project;
  const createdTask = useCallback((created: Data, projectId: string) => { setCreating(false); setSelected(`${projectId}:${created.id}`);  void refresh(); }, [refresh]);
  const updatedTask = useCallback(() => { void refresh(); }, [refresh]);
  const closeDetails = () => { setCreating(false); setSelected(""); requestAnimationFrame(() => layout.current?.querySelector<HTMLButtonElement>('[aria-label="新建自动化"]')?.focus()); };
  const visibleRows = listed.filter(row => (row.mode === "scheduled") && row.objective.toLowerCase().includes(search.toLowerCase()) && filters.includes(row.cancelled || finished(row) ? "已完成" : row.paused ? "已暂停" : "已开启"));
  const runHistory = task && project && <><div className="flex flex-wrap items-center gap-2">
    <Button size="sm" disabled={disabled || task.cancelled || !!activeRun || history.owner !== selected || !history.runNow} onClick={() => void control("taskRunNow")}>{t("operations.runNow")}</Button>
    {activeRun && <Button size="sm" variant="ghost" disabled={!connected || !project.state?.connected} onClick={() => activeRun.threadId ? onOpenThread(project.id, activeRun.threadId) : setDetailsOpen(true)}>{t("operations.viewCurrentRun")}</Button>}
    {history.owner === selected && history.enabled !== null && !history.runNow && <p className="text-foreground-subtle">{t("operations.runNowUnsupported")}</p>}
  </div><details className="task-resource-history" data-task-history-owner={selected} open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>运行记录</summary><div className="grid gap-3">
    {channelError && <p role="alert">{channelError}</p>}
    {typeof task.runCount === "number" && <p className="text-foreground-subtle">{t("operations.recentWindow")}{task.runs.length} {t("operations.runsOf")}{Math.max(task.runCount, history.owner === selected ? history.runCount : 0)} {t("operations.runsLoaded")}{displayedRuns.length} {t("operations.runs")}</p>}
    {task.runsComplete === false && history.enabled === false && <p role="status">{t("operations.recentOnly")}</p>}
    {targetRead && targetRead.target === target && targetRead.epoch === historyEpoch.current && targetRead.status === "pending" && <p role="status">{t("operations.loadingNotification")}</p>}
    {targetRead && targetRead.target === target && targetRead.epoch === historyEpoch.current && targetRead.status === "error" && <div><p role="alert">{targetRead.error}</p><Button size="sm" variant="ghost" disabled={!connected || !project.state?.connected} onClick={() => setTargetRead(null)}>{t("operations.retryNotification")}</Button></div>}
    {history.owner === selected && history.error && <div><p role="alert">{history.error}</p><Button size="sm" variant="ghost" disabled={history.pending || !connected} onClick={() => void readRuns.current(history.retryMode)}>{t("operations.retryHistory")}</Button></div>}
    {history.owner === selected && history.needsRefresh && <div><p role="status">{t("operations.historyChanged")}</p><Button size="sm" variant="ghost" disabled={history.pending || !connected || !project.state?.connected} onClick={() => void readRuns.current("refresh")}>{t("operations.refreshHistory")}</Button></div>}
    {task.lastTriggerDecision && <p>{triggerExplanation(task.lastTriggerDecision)}</p>}
    {!!task.skippedRuns && <p>前次运行未结束，已跳过 {task.skippedRuns} 次触发。</p>}
          {!displayedRuns.length && !task.runCount && <p className="text-foreground-subtle">尚未运行</p>}
          {[...displayedRuns].sort((a: Data,b: Data) => Number(["blocked","waitingForInput","paused"].includes(b.status)) - Number(["blocked","waitingForInput","paused"].includes(a.status))).map((run: Data) => <article key={run.id} data-run-id={run.id} className="grid gap-1 rounded-control border border-border p-2"><div className="flex flex-wrap justify-between gap-1"><span>{statusLabels[run.status] ?? run.status}</span><span className="text-foreground-subtle">{run.trigger === "manual" ? t("operations.manual") : t("operations.scheduled")}：{date(run.scheduledAt, runZone(run, task))} · 开始：{date(run.startedAt, runZone(run, task))}</span></div>{run.objective && run.objective !== task.objective && <p className="whitespace-pre-wrap">任务内容：{run.objective}</p>}<p className="break-words text-foreground-subtle">运行原因：{run.reason ? <span>{runReason(run.reason, task)}</span> : "—"}</p>{goalBudgetMessage(run.reason) && !scheduledTokenLimit(task, run.reason) && <p className="text-foreground-subtle">打开执行会话，在“编辑目标”中调整预算后恢复。</p>}<p className="text-foreground-subtle">{run.usage.tokensUsed.toLocaleString()} Token · {run.usage.turnsStarted} 轮 · {run.usage.timeUsedSeconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} 秒{!run.usage.accountingComplete && " · 用量尚未结算完整"}</p><GoalUsageSummary usage={run.usage} label="运行用量" />{messages.filter(message => message.runId === run.id && message.kind === "report").at(-1)?.text && <p>{messages.filter(message => message.runId === run.id && message.kind === "report").at(-1)?.text}</p>}{!terminal(run) && task.runs.some((live: Data) => live.id === run.id) && <div className="flex gap-1">{["blocked","paused"].includes(run.status) && <Button size="sm" disabled={disabled || ["stopRequested","resumeRequested"].includes(run.reason)} onClick={() => void control("taskResumeRun", run.id)}>继续本次运行</Button>}<Button size="sm" variant="outline" disabled={disabled || run.reason === "stopRequested"} onClick={() => void control("taskStopRun", run.id)}>停止本次运行</Button></div>}{run.threadId && <Button className="justify-self-start" size="sm" variant="ghost" onClick={() => onOpenThread(project.id, run.threadId)}>打开执行会话</Button>}{messages.filter(message => message.runId === run.id).map(message => <ChannelRecord key={message.id} message={message} task={task} projectId={project.id} action={action} disabled={disabled || !!channelError} onReplied={() => void refresh()} />)}{run.workers?.map((worker: Data) => <WorkerParticipant key={`${worker.threadId}:${worker.turnId}`} task={task} run={run} worker={worker} messages={messages} project={project} onOpenThread={onOpenThread} />)}</article>)}
          {history.owner === selected && history.pending && <p role="status">{t("operations.loadingHistory")}</p>}
          {history.owner === selected && history.enabled && history.nextCursor && <Button size="sm" variant="ghost" disabled={history.pending || !connected || !project.state?.connected} onClick={() => void readRuns.current("more")}>{t("operations.loadEarlier")}</Button>}
          {messages.filter(message => !displayedRuns.some((run: Data) => run.id === message.runId)).map(message => <ChannelRecord key={message.id} message={message} task={task} projectId={project.id} action={action} disabled={disabled || !!channelError} onReplied={() => void refresh()} />)}
  </div></details></>;
  return <section ref={layout} aria-label="自动化中心" className={`task-center text-ui-base ${detailOpen ? "has-detail" : ""} ${narrow ? "is-narrow" : ""}`}>
    <div className="task-center-toolbar">{navigation}<button className="icon-button" aria-label="前进" disabled><ArrowRight size={16}/></button><button className="icon-button" aria-label="切换任务侧栏" aria-expanded={!navCollapsed} onClick={() => setNavCollapsed(!navCollapsed)}><SidebarToggleIcon/></button></div>
    <div className="task-center-body">
    <div data-testid="task-center-list" className="task-center-list" hidden={navCollapsed || (narrow && detailOpen)}>
      <header className="task-list-heading"><h1>定时任务</h1><button aria-label="搜索定时任务" onClick={() => setSearching(!searching)}><Search size={16}/></button></header>
      {searching && <input autoFocus className="task-search" aria-label="搜索定时任务" placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => {if(e.key === "Escape") {setSearching(false);setSearch("");}}}/>}
      <button className="task-new" aria-label="新建自动化" aria-pressed={creating} disabled={!connected} onClick={() => beginCreate()}><Plus size={18}/>新建任务</button>

      <div className="task-list-subheading"><span>任务目录</span><DropdownMenu><DropdownMenuTrigger aria-label="筛选任务"><ListFilter size={16}/></DropdownMenuTrigger><DropdownMenuContent align="end">{["已开启","已暂停","已完成"].map(label => <DropdownMenuCheckboxItem key={label} checked={filters.includes(label)} onCheckedChange={checked => setFilters(values => checked ? [...values,label] : values.filter(v => v !== label))}>{label}</DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu></div>
      <div className="task-list-scroll">
        {pending.length > 0 && <div><p role="alert">{t("operations.admissionUnknown")}</p>{pending.some((entry: Data) => entry.method === "areal/task/runNow") && <Button size="sm" variant="ghost" disabled={!connected || busy} onClick={() => { setError(""); void action("reconcile", { projectId: project?.id }).catch(cause => setError(cause.message)); }}>{t("operations.checkAdmission")}</Button>}</div>}
        {error && <p role="alert">{error}</p>}
        {projects.map(owner => {
          const read = catalog[owner.id];
          return read?.status === "error" && <div key={owner.id}><p role="alert">{projectLabel(owner)}：{read.message}{read.previous && " 当前显示上次读取的任务。"}</p><Button variant="ghost" onClick={() => void refresh(false, owner.id)} disabled={!connected} aria-label={`重试读取 ${projectLabel(owner)}`}>重试读取</Button></div>;
        })}
        {!connected && <p role="status">尚未确认最新状态，当前显示上次读取的任务。请连接后台后重试。</p>}
        {initialLoading && <p role="status">{listed.length ? "其余任务仍在读取…" : "正在读取任务…"}</p>}
        <div className="task-list-rows">{visibleRows.map(row => {
          const failed = failedProjects.includes(row.projectId);
          const disconnected = !connected || !projects.find(owner => owner.id === row.projectId)?.state?.connected;
          return <button key={`${row.projectId}:${row.id}`} type="button" aria-label={`打开自动化 ${row.objective}`} aria-pressed={`${row.projectId}:${row.id}` === selected} disabled={disconnected || failed} className={`task-list-row ${`${row.projectId}:${row.id}` === selected ? "bg-selected" : ""}`} onClick={() => {setCreating(false);setSelected(`${row.projectId}:${row.id}`);setError("");}}><span>{row.objective}</span><small>{row.scope === "independent" ? "独立任务" : row.projectName} · 定时任务</small><small>{row.paused || row.cancelled || finished(row) ? taskStatus(row) : row.nextRunAt != null ? date(row.nextRunAt, scheduleZone(row)) : taskStatus(row)}</small>{failed && <small>读取失败 · 上次读取</small>}</button>;
        })}</div>
        {fresh && !visibleRows.length && <p>{moreAvailable ? "已加载任务中没有匹配项，可展开显示更多。" : "没有符合筛选条件的定时任务。"}</p>}
        {moreAvailable && <Button variant="ghost" disabled={!connected || loading} onClick={() => void refresh(true)}>展开显示</Button>}
      </div>
    </div>
    {creating && <TaskDraft key={`new:${draftProjectId ?? "global"}`} projects={projects} initialProjectId={draftProjectId} action={action} initialText={initialText} disabled={!connected} onClose={() => setCreating(false)} onCreated={createdTask} onOpenModelSettings={onOpenModelSettings} renderConversation={renderConversation} />}
    {!detailOpen && <main className="task-welcome"><div className="task-welcome-intro"><span className="task-clock"><CalendarClock size={44}/></span><h2>安排任务</h2><p>AReaL 可以帮你处理持续性任务，让你无需亲力亲为。</p></div><div className="task-examples">{([
      [GitPullRequest,"检查仓库进展","检查我指定仓库的公开提交与 PR，整理进展和待处理事项。"],
      [ListChecks,"整理每日计划","回顾我提供的计划，整理当天待办和需要关注的事项。"],
      [Newspaper,"跟踪行业动态","整理最近的 AI 行业动态，附上原始来源。"],
      [FileSearch,"整理研究线索","回顾研究资料，整理关键发现和待验证的问题。"],
      [BookOpen,"每周知识回顾","回顾我提供的本周记录，总结结论与下一步。"],
      [Activity,"跟踪产品变化","检查我指定产品的公开更新，列出需要关注的变化。"],
    ] as const).map(([Icon,title,description]) => <button key={title} onClick={() => beginCreate(description)} disabled={!connected}><span><Icon size={24}/></span><div><h3>{title}</h3><p>{description}</p></div></button>)}</div></main>}

    {task && project && !creating && <TaskDraft key={selected} projects={projects} initialProjectId={project.id} task={task} action={action} disabled={disabled} onClose={closeDetails} onCreated={updatedTask} onOpenModelSettings={onOpenModelSettings} renderConversation={renderConversation} renderResources={(owner, thread) => renderResources(owner, thread, {...task, displayStatus: task.paused || task.cancelled || finished(task) ? taskStatus(task) : "已开启"}, runHistory, revealKey)} />}

    </div>


  </section>;
}
