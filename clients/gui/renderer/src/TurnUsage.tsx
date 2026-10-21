import { useState } from "react";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import { generationRate, generationStats, modelUsage, tokenCount, useContextUsage } from "./contextUsage.js";
import type { Action, Data } from "./services.js";

export function TurnUsage({ project, thread, turn, action, inherited = false }: { project: Data; thread: Data; turn: Data; action: Action; inherited?: boolean }) {
  const [open, setOpen] = useState(false), [scope, setScope] = useState<"session" | "turn">("session");
  const { result, busy, error } = useContextUsage(project, thread, action, open && !inherited);
  const usage = modelUsage(turn.usage), generation = generationStats(turn.generation), rate = generationRate(generation);
  if (turn.status === "inProgress") return null;
  const session = !inherited && scope === "session";
  const shownUsage = session ? result?.sessionUsage.usage : usage, shownGeneration = session ? result?.sessionUsage.generation : generation;
  const shownRate = generationRate(shownGeneration);
  const incomplete = session ? !result || result.sessionUsage.unknownTurns > 0 || result.sessionUsage.partialTurns > 0 : !usage || !generation || generation.missingUsageRequests > 0;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger className="turn-usage-trigger" aria-label="查看 Token 用量" data-testid="turn-usage">{usage ? tokenCount(usage.inputTokens + usage.outputTokens) : "—"} Token{rate !== null && ` · ${rate.toFixed(1)} tok/s`}</PopoverTrigger>
    <PopoverContent side="top" align="start" className="context-usage-popover" data-testid="turn-usage-popover">
      <PopoverTitle>用量详情</PopoverTitle>
      {!inherited && <div className="usage-scope" role="group" aria-label="用量范围"><Button type="button" variant="ghost" size="sm" aria-pressed={scope === "session"} onClick={() => setScope("session")}>本会话</Button><Button type="button" variant="ghost" size="sm" aria-pressed={scope === "turn"} onClick={() => setScope("turn")}>本轮</Button></div>}
      {inherited && <p>来源会话的本轮用量</p>}
      <dl className="usage-details">
        <div><dt>{incomplete ? "已确认 Token" : "Token 总量"}</dt><dd>{shownUsage ? (shownUsage.inputTokens + shownUsage.outputTokens).toLocaleString() : "—"}</dd></div>
        <div><dt>输入</dt><dd>{shownUsage?.inputTokens.toLocaleString() ?? "—"}</dd></div>
        <div><dt>缓存读取 · 输入子集</dt><dd>{shownUsage?.cachedInputTokens.toLocaleString() ?? "—"}</dd></div>
        <div><dt>输出</dt><dd>{shownUsage?.outputTokens.toLocaleString() ?? "—"}</dd></div>
        <div><dt>生成速率</dt><dd>{shownRate === null ? "—" : `${shownRate.toFixed(1)} tok/s`}</dd></div>
        {shownGeneration && <div><dt>速率覆盖</dt><dd>{shownGeneration.measuredRequests} / {shownGeneration.measuredRequests + shownGeneration.unmeasuredRequests} 次请求</dd></div>}
      </dl>
      {incomplete && <p className="usage-status">{session && busy ? "读取中…" : "部分用量未确认"}</p>}
      {session && error && <p role="alert">{error}</p>}
    </PopoverContent>
  </Popover>;
}
