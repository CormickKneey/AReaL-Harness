import { Button } from "./components/ui/button.js";
import type { Snapshot } from "./services.js";

export const BACKEND_STATUS_ID = "backend-status";
export type BackendStatusAction = "update" | "check" | "reconnect";

export function BackendStatusNotice({ connection, update, lifecycle, currentCommands, pending, error, onAction }: {
  connection: Snapshot["connection"];
  update: Snapshot["backendUpdate"];
  lifecycle?: Snapshot["lifecycle"];
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
    message = error || "更新后台后可发送消息。草稿已保留，现有任务可继续管理。";
    action = "update";
  } else if (connection?.state === "ready" && update?.state === "pending") {
    message = error || "后台有更新待应用。现有任务继续运行。";
    action = "update";
  } else {
    return null;
  }
  const retryUpdate = action === "check" && lifecycle?.kind === "updateDesktop"
    && lifecycle.desktopExit !== "requested" && lifecycle.targets !== undefined
    && lifecycle.targets.every(target => ["completed", "blocked", "settlementIncomplete"].includes(target.phase))
    && ["partial", "settlementIncomplete", "acceptedPending"].includes(lifecycle.phase ?? "");
  const applying = action === "update" && (pending || update?.state === "applying");
  return <div id={BACKEND_STATUS_ID} role="status" aria-live="polite" aria-atomic="true"
    className="pointer-events-auto mx-2 mb-2 flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-3 py-2 text-ui-caption text-foreground-subtle">
    <span className="min-w-0 flex-1 basis-64 break-words">{applying ? "正在更新后台…" : message}</span>
    {retryUpdate && <Button type="button" variant="outline" size="sm" disabled={pending || update?.state === "applying"} onClick={() => onAction("update")}>
      更新后台…
    </Button>}
    {action && <Button type="button" variant="outline" size="sm" disabled={pending || update?.state === "applying"} onClick={() => onAction(action)}>
      {applying ? "正在更新…" : action === "update" ? "更新后台…" : action === "check" ? "检查后台" : "重新连接后台"}
    </Button>}
  </div>;
}
