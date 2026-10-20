import { useEffect, useState } from "react";
import type { Data } from "./services.js";
import { ActivityIcon } from "./ActivityIcon.js";

function durationText(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分钟 ${seconds % 60}秒`;
}

/** Terminal duration is a Core receipt, never a sum of tool execution times. */
export function completedTimeLabel(turn: Data): string | undefined {
  return turn.status !== "inProgress" && Number.isSafeInteger(turn.durationMs) && turn.durationMs >= 0
    ? `用时 ${durationText(turn.durationMs)}` : undefined;
}

/** Refresh only the display. History and reconnect retain Core's original start. */
export function TurnElapsed({ turn, connected, disclosure }: { turn: Data; connected: boolean; disclosure?: { expanded: boolean; controls: string; failures?: number; unfinished?: boolean; onToggle: () => void } }) {
  const [now, setNow] = useState(Date.now);
  const running = turn.status === "inProgress";
  const hasStart = Number.isSafeInteger(turn.startedAt) && turn.startedAt > 0;
  useEffect(() => {
    if (!running || !connected || !hasStart) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn.id, turn.startedAt, running, connected, hasStart]);
  const label = running
    ? !connected ? "连接已中断，耗时待同步" : hasStart && now >= turn.startedAt * 1000
      ? `已处理 ${durationText(now - turn.startedAt * 1000)}` : undefined
    : completedTimeLabel(turn);
  if (!label && !disclosure) return null;
  return <div className="turn-elapsed turn-progress-heading" data-testid="turn-elapsed">
    <div className="turn-progress-label">{disclosure ? <button type="button" className="turn-progress-summary" aria-label={`执行过程：${label ?? "本轮过程"}`} aria-expanded={disclosure.expanded} aria-controls={disclosure.controls} onClick={disclosure.onToggle}>
      <span>执行过程</span><span>{label ?? "本轮过程"}</span>{!!disclosure.failures && <span className="execution-failures">{disclosure.failures} 次工具失败</span>}{disclosure.unfinished && <span>结果待确认</span>}<span className="conversation-disclosure-action" aria-hidden="true">{disclosure.expanded ? "收起" : "展开"}</span><ActivityIcon kind="chevron" size={14} className={disclosure.expanded ? "open" : ""} />
    </button> : <span className="turn-progress-summary">{label}</span>}</div>
    <div className="turn-progress-divider" />
  </div>;
}
