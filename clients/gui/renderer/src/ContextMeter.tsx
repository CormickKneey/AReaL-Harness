import { useState } from "react";
import type { ContextPart } from "../../packages/runtime-client/core.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import { contextLabels, tokenCount, useContextUsage } from "./contextUsage.js";
import { CloseIcon } from "./interfaceIcons.js";
import type { Action, Data } from "./services.js";

function Category({ part, total }: { part: ContextPart; total: number }) {
  return <details className="context-category"><summary><span className="context-category-name"><i className={`context-category-dot context-color-${part.kind}`} />{contextLabels[part.kind]}</span><span className="context-category-value">≈{tokenCount(part.estimatedTokens)}</span><span className="context-category-percent">{total > 0 ? Math.round(part.estimatedTokens / total * 100) : 0}%</span></summary>
    {part.children?.map((child, index) => <div className="context-category-child" key={`${child.name}:${index}`}><span>{child.name}</span><span>≈{tokenCount(child.estimatedTokens)}</span></div>)}
  </details>;
}

export function ContextMeter({ project, thread, action, anchor }: { project: Data; thread?: Data; action: Action; anchor?: HTMLElement | null }) {
  const { result, busy, error, read } = useContextUsage(project, thread, action);
  const [open, setOpen] = useState(false);
  const reading = result?.contextUsage, budget = reading?.budget, estimate = reading?.kind === "ready" ? reading.estimate : null;
  const percent = estimate && budget && budget.windowTokens > 0 ? Math.min(100, estimate.tokens / budget.windowTokens * 100) : null;
  const reservePercent = percent !== null && budget ? Math.min(100 - percent, budget.outputReserveTokens / budget.windowTokens * 100) : 0;
  const available = estimate && budget && budget.windowTokens > 0 ? Math.max(0, budget.inputLimitTokens - estimate.tokens) : null;
  const capacitySource = budget ? {
    account: "账号报告", provider: "供应商报告", user: "生效容量", modelDefault: "参考默认值", fallback: "后备配置", model: "模型配置",
  }[budget.windowSource] : "";
  const reportOrigin = budget?.reportedWindowSource ?? budget?.windowSource;
  const reportedSource = reportOrigin === "account" ? "账号报告" : reportOrigin === "provider" ? "供应商报告" : "报告容量";
  const label = estimate && budget ? `上下文 ${tokenCount(estimate.tokens)} / ${budget.windowTokens > 0 ? tokenCount(budget.windowTokens) : "未设上限"} Token` : "查看上下文";
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (next) void read(); }}>
    <PopoverTrigger className="context-meter-trigger" aria-label="上下文占用" title={label} data-testid="context-meter">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle className="context-ring-track" cx="12" cy="12" r="8" /><circle className="context-ring-value" cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${percent ?? 0} 100`} /></svg>
    </PopoverTrigger>
    <PopoverContent anchor={anchor} side="top" sideOffset={10} align="end" className="context-usage-popover context-meter-popover" data-testid="context-popover">
      <div className="context-usage-header"><PopoverTitle>上下文</PopoverTitle><button type="button" className="context-usage-close" aria-label="关闭上下文详情" onClick={() => setOpen(false)}><CloseIcon size={16} /></button></div>
      <div className="context-usage-total"><strong>{percent !== null ? `${Math.round(percent)}%` : estimate ? `≈${tokenCount(estimate.tokens)}` : "—"}<small>{estimate ? percent !== null ? "已占用 · 估算" : "输入 · 估算" : "尚无估算"}</small></strong><span>{estimate ? `≈${tokenCount(estimate.tokens)} / ` : ""}{budget?.windowTokens ? tokenCount(budget.windowTokens) : budget ? "未设上限" : "—"} Token</span></div>
      {percent !== null && <div className="context-capacity" aria-label="上下文容量分配"><span className="context-capacity-input" style={{ width: `${percent}%` }} /><span className="context-capacity-reserve" style={{ width: `${reservePercent}%` }} /></div>}
      {budget && <>
        <div className="context-budget"><span>输入 {estimate ? `≈${tokenCount(estimate.tokens)}` : "—"}</span><span>输出预留 {tokenCount(budget.outputReserveTokens)}</span><span>可用 {available !== null ? `≈${tokenCount(available)}` : "—"}</span></div>
        <div className="context-budget" aria-label="上下文容量来源"><span>{budget.reportedWindowTokens != null ? reportedSource : capacitySource} {budget.reportedWindowTokens != null ? tokenCount(budget.reportedWindowTokens) : budget.windowTokens ? tokenCount(budget.windowTokens) : "未设上限"}</span><span>用户预算 {budget.userBudgetTokens != null ? tokenCount(budget.userBudgetTokens) : "未设置"}</span></div>
        <div className="context-model">{reading?.basis.model}</div>
        {budget.userBudgetTokens != null && budget.reportedWindowTokens != null && budget.userBudgetTokens > budget.reportedWindowTokens && <p className="context-model" role="status">用户预算超出报告容量，按报告容量计算。</p>}
      </>}
      {estimate && <><div className="context-composition-heading"><span>组成 · 占当前输入的比例</span><span>全部为估算</span></div><div className="context-composition" aria-label="上下文分类占比">{estimate.parts.map(part => <span key={part.kind} className={`context-color-${part.kind}`} style={{ flexGrow: part.estimatedTokens }} title={`${contextLabels[part.kind]} · ≈${tokenCount(part.estimatedTokens)}`} />)}</div><div className="context-categories">{estimate.parts.map(part => <Category part={part} total={estimate.tokens} key={part.kind} />)}</div></>}
      {reading?.kind === "unavailable" && <p role="status">{{ awaitingRequest: "正在组装上下文", instructionBasisChanged: "模型配置已变更，等待新的上下文", modelUnavailable: "模型当前不可用" }[reading.reason]}</p>}
      {!reading && !error && <p role="status">{busy ? "读取中…" : "暂无上下文数据"}</p>}
      {error && <p role="alert">{error}</p>}
    </PopoverContent>
  </Popover>;
}
