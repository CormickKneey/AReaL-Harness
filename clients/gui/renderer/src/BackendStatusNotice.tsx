import { Button } from "./components/ui/button.js";
import type { Snapshot } from "./services.js";

export const BACKEND_STATUS_ID = "backend-status";
export type BackendStatusAction = "update" | "check" | "reconnect" | "recover" | "status";

export function BackendStatusNotice({ connection, update, lifecycle, summary, currentCommands, pending, error, onAction }: {
  connection: Snapshot["connection"];
  update: Snapshot["backendUpdate"];
  lifecycle?: Snapshot["lifecycle"];
  summary?: Snapshot["serviceSummary"];
  currentCommands?: boolean;
  pending: boolean;
  error: string;
  onAction: (action: BackendStatusAction) => void;
}) {
  let message: string;
  let action: BackendStatusAction | undefined;
  if (lifecycle?.error) {
    message = error || lifecycle.error;
    action = "check";
  } else if (lifecycle?.recovery) {
    message = error || lifecycle.recovery.message;
    action = 'check';
  } else if (lifecycle?.phase === "completed" && lifecycle.desktopExit === "requested"
    && ["updateDesktop", "stopDesktop"].includes(lifecycle.kind ?? "")) {
    const updateCompleted = lifecycle.kind === "updateDesktop";
    message = updateCompleted ? "原后台已确认退出，可以沿原请求完成更新。" : "原后台已确认停止，可以按需重新连接或退出界面。";
    action = updateCompleted ? "update" : "reconnect";
  } else if (lifecycle?.phase && ["acceptedPending", "admissionUnconfirmed", "partial", "settlementIncomplete"].includes(lifecycle.phase)) {
    message = error || lifecycle.message || (lifecycle.phase === "acceptedPending" ? "正在确认后台操作的完成状态。" : "部分后台操作尚未完成，请检查原请求。现有历史和草稿已保留。");
    action = "check";
  } else if (connection?.recovery === "check") {
    message = error || connection.message || "后台状态尚未确认，请检查后台。";
    action = "check";
  } else if (update?.state === "applying") {
    message = "正在更新后台…";
    action = "update";
  } else if (connection?.state === "connecting") {
    message = "正在连接后台…";
  } else if (connection?.state === "unavailable") {
    message = error || connection.message || update?.message || "后台尚未连接";
    action = "reconnect";
  } else if (connection?.state === "ready" && update?.state === "failed") {
    message = error || update.message || "后台更新失败，请检查后台服务。";
    action = "update";
  } else if (connection?.state === "ready" && currentCommands === false) {
    message = error || "原后台不支持新版提交；可检查原任务，安全更新后继续发送。草稿已保留。";
    action = "update";
  } else if (connection?.state === "ready" && update?.state === "pending") {
    message = error || "已连接原后台，当前部署更新尚未应用。现有任务继续运行。";
    action = "update";
  } else if (connection?.state === "ready") {
    return null;
  } else {
    message = summary?.state === "stopped" ? "后台已停止" : "后台连接与运行状态待检查";
    action = "status";
  }
  const retryUpdate = action === "check" && lifecycle?.kind === "updateDesktop"
    && lifecycle.desktopExit !== "requested" && lifecycle.targets !== undefined
    && lifecycle.targets.every(target => ["completed", "blocked", "settlementIncomplete"].includes(target.phase))
    && ["partial", "settlementIncomplete", "acceptedPending"].includes(lifecycle.phase ?? "");
  const applying = action === "update" && (pending || update?.state === "applying");
  return <div id={BACKEND_STATUS_ID} role="status" aria-live="polite" aria-atomic="true"
    className="pointer-events-auto mx-2 mb-2 flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-3 py-2 text-ui-caption text-foreground-subtle">
    <span className="min-w-0 flex-1 basis-64 break-words">{applying ? "正在更新后台…" : message}</span>
    {lifecycle?.recovery && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onAction("recover")}>
      恢复后台…
    </Button>}
    {retryUpdate && <Button type="button" variant="outline" size="sm" disabled={pending || update?.state === "applying"} onClick={() => onAction("update")}>
      更新后台…
    </Button>}
    {action !== "status" && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => onAction("status")}>后台详情</Button>}
    {action && <Button type="button" variant="outline" size="sm" disabled={pending || update?.state === "applying"} onClick={() => onAction(action)}>
      {applying ? "正在更新…" : action === "update" ? "更新后台…" : action === "check" ? "检查后台" : action === "status" ? "后台详情" : "重新连接后台"}
    </Button>}
  </div>;
}
