import { useRef, useState } from "react";
import type { ContextPart } from "../../packages/runtime-client/core.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import { Button } from "./components/ui/button.js";
import { contextLabels, tokenCount, useContextUsage } from "./contextUsage.js";
import type { Action, Data } from "./services.js";

function Category({ part, total }: { part: ContextPart; total: number }) {
  return <details className="context-category"><summary><span><i className={`context-category-dot context-color-${part.kind}`} />{contextLabels[part.kind]}</span><span>{tokenCount(part.estimatedTokens)} <small>{total > 0 ? Math.round(part.estimatedTokens / total * 100) : 0}%</small></span></summary>
    {part.children?.map((child, index) => <div className="context-category-child" key={`${child.name}:${index}`}><span>{child.name}</span><span>{tokenCount(child.estimatedTokens)}</span></div>)}
  </details>;
}

export function ContextMeter({ project, thread, action }: { project: Data; thread?: Data; action: Action }) {
  const { result, busy, error, read } = useContextUsage(project, thread, action);
  const [compacting, setCompacting] = useState(false), [notice, setNotice] = useState("");
  const lock = useRef(false), owner = `${project.id}:${thread?.id ?? ""}`, currentOwner = useRef(owner); currentOwner.current = owner;
  const reading = result?.contextUsage, budget = reading?.budget, estimate = reading?.kind === "ready" ? reading.estimate : null;
  const percent = estimate && budget && budget.windowTokens > 0 ? Math.min(100, estimate.tokens / budget.windowTokens * 100) : null;
  const active = thread?.turns?.some((turn: Data) => turn.status === "inProgress") || thread?.goals?.goal?.status === "active";
  const disabled = !thread || !project.state?.connected || active || busy || compacting || thread.desktop?.archived || thread.conversation?.kind === "side" || project.pending?.some((pending: Data) => pending.params?.threadId === thread.id);
  const compact = async () => {
    if (disabled || lock.current) return;
    const startedOwner = currentOwner.current; lock.current = true; setCompacting(true); setNotice("");
    try {
      await action("manage", { projectId: project.id, threadId: thread.id, operation: "contextCompact" });
      if (startedOwner === currentOwner.current) { setNotice("压缩已完成"); await read(); }
    } catch (cause) { if (startedOwner === currentOwner.current) setNotice(`压缩未确认，请刷新检查。${cause instanceof Error ? cause.message : ""}`); }
    finally { lock.current = false; if (startedOwner === currentOwner.current) setCompacting(false); }
  };
  const label = estimate && budget ? `上下文 ${tokenCount(estimate.tokens)} / ${budget.windowTokens > 0 ? tokenCount(budget.windowTokens) : "未设上限"} Token` : "查看上下文";
  return <Popover onOpenChange={open => { if (open) void read(); }}>
    <PopoverTrigger className="context-meter-trigger" aria-label="上下文占用" title={label} data-testid="context-meter">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle className="context-ring-track" cx="12" cy="12" r="8" /><circle className="context-ring-value" cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${percent ?? 0} 100`} /></svg>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="context-usage-popover" data-testid="context-popover">
      <PopoverTitle>上下文</PopoverTitle>
      <div className="context-usage-total"><strong>{estimate ? `≈${tokenCount(estimate.tokens)}` : "—"}</strong><span> / {budget?.windowTokens ? tokenCount(budget.windowTokens) : "—"} Token</span>{percent !== null && <span>{Math.round(percent)}%</span>}</div>
      {budget && <div className="context-budget"><span>{budget.windowSource === "fallback" ? "配置容量" : reading?.basis.model}</span><span>输出预留 {tokenCount(budget.outputReserveTokens)}</span></div>}
      {estimate && <><div className="context-composition" aria-label="上下文分类占比">{estimate.parts.map(part => <span key={part.kind} className={`context-color-${part.kind}`} style={{ flexGrow: part.estimatedTokens }} title={`${contextLabels[part.kind]} · ${tokenCount(part.estimatedTokens)}`} />)}</div><div className="context-categories">{estimate.parts.map(part => <Category part={part} total={estimate.tokens} key={part.kind} />)}</div></>}
      {reading?.kind === "unavailable" && <p role="status">{{ awaitingRequest: "正在组装上下文", instructionBasisChanged: "模型配置已变更，等待新的上下文", modelUnavailable: "模型当前不可用" }[reading.reason]}</p>}
      {!reading && !error && <p role="status">{busy ? "读取中…" : "暂无上下文数据"}</p>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <div className="context-usage-actions"><Button variant="ghost" size="sm" disabled={busy || !thread || !project.state?.connected} onClick={() => void read()}>刷新</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={() => void compact()}>{compacting ? "压缩中…" : "压缩上下文"}</Button></div>
    </PopoverContent>
  </Popover>;
}
