import { useId, useState, type ReactNode } from "react";
import { spawnedAgent } from "./AgentIdentity.js";
import { ActivityIcon } from "./ActivityIcon.js";
import { ReasoningGroup } from "./ReasoningGroup.js";
import { activityLabel, executionOutcome, executionSummary, timelineItems, toolPresentation } from "./conversationPresentation.js";
import type { Data } from "./services.js";

/** Core work items are disclosed in order between visible conversation messages. */
export function TurnExecution({ items, turn, project, threadId, renderItem, active = true, hasTurnSummary = false }: {
  active?: boolean; hasTurnSummary?: boolean; items: Data[]; turn: Data; project: Data; threadId: string; renderItem: (item: Data, disclosure: { animate: boolean; onDisclosureChange: (open: boolean) => void }) => ReactNode;
}) {
  const { failures, unfinished } = executionOutcome(items);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const running = active && turn.status === "inProgress";
  const awaitingInput = project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending");
  const tools = items.filter(item => item.type === "dynamicToolCall");
  const currentTool = tools.findLast(item => toolPresentation(item).running);
  const currentDetail = running && project.state?.connected && !awaitingInput && !turn.modelRetry && currentTool
    ? toolPresentation(currentTool).detail : undefined;
  const unconfirmed = tools.some(item => toolPresentation(item).status === "结果待确认");
  const rows = timelineItems(items);
  const reasoningCount = items.filter(item => item.type === "reasoning").length;
  const counts = [reasoningCount && `${reasoningCount} 段思考`, tools.length && `${tools.length} 项活动`].filter(Boolean).join(" · ");
  const hasDetails = rows.length > 0;
  const summary = executionSummary(items);
  const label = running ? activityLabel(project, threadId, items.length ? { ...turn, items } : turn) :
    `${summary}${turn.status === "failed" ? " · 回合失败" : ""}`;
  const singleTool = rows.length === 1 && rows[0].type === "dynamicToolCall";
  const singleReasoning = rows.length === 1 && rows[0].type === "reasoningGroup";
  const onlyAgentEntries = rows.length > 0 && rows.every(item => !!spawnedAgent(item));
  const direct = singleTool || singleReasoning || onlyAgentEntries;
  const expanded = direct || open;
  const canAnimate = turn.status === "inProgress" && !!project.state?.connected && !awaitingInput && !turn.modelRetry;
  const animateSummary = canAnimate && (running || unfinished) && !(expanded && tools.some(item => toolPresentation(item).running));
  const iconKind = toolPresentation(tools.find(item => toolPresentation(item).running) ?? tools[0] ?? {}).kind;
  const statusLabel = <span className={animateSummary ? "execution-label turn-thinking" : "execution-label"} role={running ? "status" : undefined} aria-live={running ? "polite" : undefined} data-testid={running ? "turn-activity" : undefined}><span>{label}</span>{currentDetail && <> {currentDetail}</>}</span>;
  const heading = !direct && (hasDetails ? <button type="button" className="execution-summary" aria-label="执行过程" aria-expanded={open} aria-controls={detailsId} title={counts || undefined} onClick={() => setOpen(!open)}>
      {tools.length > 0 && <ActivityIcon kind={iconKind} />}
      {statusLabel}
      {!!failures && !(hasTurnSummary && turn.status === "completed") && <span className="execution-failures">{failures} 次工具失败</span>}
      {unconfirmed ? <span className="execution-label">结果待确认</span> : unfinished && !running && <span className="execution-label">仍在运行</span>}
      <ActivityIcon kind="chevron" size={14} className={open ? "execution-chevron open" : "execution-chevron"} />
    </button> : running ? <div className="execution-summary">{statusLabel}</div> : null);
  return <div className="turn-execution" data-testid="turn-execution">
    {heading}
    <div id={detailsId} className={direct ? "execution-details execution-single" : "execution-details"} data-expanded={expanded} data-activity-list={rows.length > 1}
      role={rows.length > 1 ? "region" : undefined} aria-label={rows.length > 1 ? "工具活动" : undefined} tabIndex={rows.length > 1 ? 0 : undefined}>
      {rows.map(item => <div key={item.id} className="execution-row">{item.type === "reasoningGroup"
        ? <ReasoningGroup items={item.items} activity={singleReasoning && running ? label : undefined} animate={singleReasoning && running && canAnimate} />
        : renderItem(item, { animate: canAnimate && expanded, onDisclosureChange: next => { if (next) setOpen(true); } })}</div>)}
    </div>
    {singleTool && running && (!toolPresentation(rows[0]).running || !project.state?.connected || awaitingInput || turn.modelRetry) && <p className={canAnimate ? "execution-label turn-thinking" : "execution-label"} role="status">{activityLabel(project, threadId, turn)}</p>}
  </div>;
}
