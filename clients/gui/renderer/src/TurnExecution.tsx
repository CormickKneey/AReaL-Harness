import { useId, useState, type ReactNode } from "react";
import { spawnedAgent } from "./AgentIdentity.js";
import { ActivityIcon } from "./ActivityIcon.js";
import { ReasoningGroup } from "./ReasoningGroup.js";
import { activityLabel, executionOutcome, executionSummary, processItems, timelineItems, toolPresentation } from "./conversationPresentation.js";
import type { Data } from "./services.js";

function canAnimateTurn(project: Data, threadId: string, turn: Data) {
  return turn.status === "inProgress" && !!project.state?.connected && !turn.modelRetry
    && !project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending");
}

export function TurnActivity({ turn, project, threadId }: { turn: Data; project: Data; threadId: string }) {
  if (turn.status !== "inProgress") return null;
  const animate = canAnimateTurn(project, threadId, turn);
  const currentTool = animate && processItems(turn.items ?? [], turn.status).findLast(item => item.type === "dynamicToolCall" && toolPresentation(item).running);
  const detail = currentTool ? toolPresentation(currentTool).detail : undefined;
  return <p className={animate ? "execution-label turn-thinking" : "execution-label"} role="status" aria-live="polite" data-testid="turn-activity">
    <span>{activityLabel(project, threadId, turn)}</span>{detail && <> {detail}</>}
  </p>;
}

/** Core work items are disclosed in order between visible conversation messages. */
export function TurnExecution({ items, turn, project, threadId, renderItem, hasTurnSummary = false }: {
  hasTurnSummary?: boolean; items: Data[]; turn: Data; project: Data; threadId: string; renderItem: (item: Data, disclosure: { animate: boolean; onDisclosureChange: (open: boolean) => void }) => ReactNode;
}) {
  const { failures, unfinished } = executionOutcome(items);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const tools = items.filter(item => item.type === "dynamicToolCall");
  const unconfirmed = tools.some(item => toolPresentation(item).status === "结果待确认");
  const rows = timelineItems(items);
  const reasoningCount = items.filter(item => item.type === "reasoning").length;
  const counts = [reasoningCount && `${reasoningCount} 段思考`, tools.length && `${tools.length} 项活动`].filter(Boolean).join(" · ");
  const label = `${executionSummary(items)}${turn.status === "failed" ? " · 回合失败" : ""}`;
  const singleTool = rows.length === 1 && rows[0].type === "dynamicToolCall";
  const singleReasoning = rows.length === 1 && rows[0].type === "reasoningGroup";
  const onlyAgentEntries = rows.length > 0 && rows.every(item => !!spawnedAgent(item));
  const direct = singleTool || singleReasoning || onlyAgentEntries;
  const expanded = direct || open;
  const canAnimate = canAnimateTurn(project, threadId, turn);
  const iconKind = toolPresentation(tools.find(item => toolPresentation(item).running) ?? tools[0] ?? {}).kind;
  if (!rows.length) return null;
  const heading = !direct && <button type="button" className="execution-summary" aria-label="执行过程" aria-expanded={open} aria-controls={detailsId} title={counts || undefined} onClick={() => setOpen(!open)}>
      {tools.length > 0 && <ActivityIcon kind={iconKind} />}
      <span className="execution-label">{label}</span>
      {!!failures && !(hasTurnSummary && turn.status === "completed") && <span className="execution-failures">{failures} 次工具失败</span>}
      {unconfirmed ? <span className="execution-label">结果待确认</span> : unfinished && turn.status !== "inProgress" && <span className="execution-label">仍在运行</span>}
      <ActivityIcon kind="chevron" size={14} className={open ? "execution-chevron open" : "execution-chevron"} />
    </button>;
  return <div className="turn-execution" data-testid="turn-execution">
    {heading}
    <div id={detailsId} className={direct ? "execution-details execution-single" : "execution-details"} data-expanded={expanded} data-activity-list={rows.length > 1}
      role={rows.length > 1 ? "region" : undefined} aria-label={rows.length > 1 ? "工具活动" : undefined} tabIndex={rows.length > 1 ? 0 : undefined}>
      {rows.map(item => <div key={item.id} className="execution-row">{item.type === "reasoningGroup"
        ? <ReasoningGroup items={item.items} />
        : renderItem(item, { animate: canAnimate && expanded, onDisclosureChange: next => { if (next) setOpen(true); } })}</div>)}
    </div>
  </div>;
}
