import { useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Feedback } from "./components/ui/feedback.js";
import type { Action, Data } from "./services.js";

/** Acknowledgement locks this request; only a Core projection removes it or advances execution. */
export function ApprovalRequest({ item, projectId, action }: { item: Data; projectId: string; action: Action }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const canRemember = item.effectivePermissions?.rememberAllowed === true;
  const browserPlan = item.tool === "browser_v1" ? item.effectiveArguments?.plan : null;
  const respond = async (decision: "deny" | "allowOnce" | "allowSession" | "allowProject") => {
    if (inFlight.current || submitted || unknown) return;
    if ((decision === "allowSession" || decision === "allowProject") && !canRemember) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await action("respond", { projectId, threadId: item.threadId, requestId: item.requestId, decision });
      setSubmitted(true);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (failure.submissionUnknown) setUnknown(true);
      setError(failure.submissionUnknown ? "审批结果未确认。请先读取 Core 当前待处理状态，不会自动重复提交。" : failure.message || "审批提交失败，请重试。");
    } finally { inFlight.current = false; setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await action("manage", { projectId, threadId: item.threadId, operation: "interactions" });
      setUnknown(false); setError("");
    } catch (cause) { setError(`无法核对审批状态。${(cause as Error).message}`); }
    finally { setBusy(false); }
  };
  return <section className="interaction" data-interaction="approval" aria-label="工具审批" aria-busy={busy}>
    <strong>允许执行 {item.tool}？</strong>
    {browserPlan ? <div>
      <p>页面：{browserPlan.url}（{browserPlan.origin}）</p>
      <p>操作：{browserPlan.action?.kind ?? browserPlan.operation}{browserPlan.target ? ` · ${browserPlan.target.role} ${browserPlan.target.name} [${browserPlan.target.ref}]` : ""}</p>
      {Array.isArray(browserPlan.steps) && <ol aria-label="本次批准的浏览步骤" className="list-decimal pl-5">
        {browserPlan.steps.map((step: Data, index: number) => <li key={index}>
          {step.action?.kind ?? step.operation}
          {step.target?.ref ? ` · ${step.target.role} ${step.target.name} [${step.target.ref}]` : ""}
          {step.action?.kind === "wait" ? ` · ${step.action.timeoutMs} 毫秒 · ${step.action.condition ? JSON.stringify(step.action.condition) : "固定延时"}` : ""}
          {step.action?.kind === "fill" ? ` · 填写：${step.action.value}` : ""}
          {["press", "pressAt"].includes(step.action?.kind) ? ` · 按键：${step.action.key}` : ""}
          {["clickAt", "pressAt"].includes(step.action?.kind) ? ` · 截图坐标：${step.action.x}, ${step.action.y}` : ""}
          {step.action?.kind === "drag" ? ` · 截图拖动：${step.action.fromX}, ${step.action.fromY} → ${step.action.toX}, ${step.action.toY}` : ""}
        </li>)}
      </ol>}
      {browserPlan.targetUrl && <p>目标地址：{browserPlan.targetUrl}（{browserPlan.targetOrigin}）</p>}
      {browserPlan.action?.kind === "wait" && <p>等待：{browserPlan.action.timeoutMs} 毫秒 · {browserPlan.action.condition ? JSON.stringify(browserPlan.action.condition) : "固定延时"}</p>}
      {browserPlan.action?.kind === "fill" && <p>填写：{browserPlan.action.value}</p>}
      {browserPlan.action?.kind === "press" && <p>按键：{browserPlan.action.key}</p>}
      {browserPlan.target?.semantics?.kind === "public_search" && <div>
        <p>搜索内容：{browserPlan.target.semantics.query}</p>
        <details><summary>本次提交的表单字段</summary><pre>{JSON.stringify(browserPlan.target.semantics.submittedFields, null, 2)}</pre></details>
      </div>}
      <p>目标页面或控件变化后，本次批准会失效。</p>
    </div> : <pre>{JSON.stringify(item.effectiveArguments, null, 2)}</pre>}
    <Feedback error={error} message={submitted ? "已提交，等待执行状态更新。" : undefined} />
    {unknown && <Button variant="outline" disabled={busy} onClick={() => void refresh()}>核对待审批状态</Button>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy || submitted || unknown} onClick={() => void respond("deny")}>拒绝</Button>
      <Button disabled={busy || submitted || unknown} onClick={() => void respond("allowOnce")}>{busy ? "提交中…" : "允许一次"}</Button>
      {canRemember && <Button variant="outline" disabled={busy || submitted || unknown} onClick={() => void respond("allowSession")}>本任务允许此操作</Button>}
      {canRemember && <Button variant="outline" disabled={busy || submitted || unknown} onClick={() => void respond("allowProject")}>本项目允许此操作</Button>}
    </div>
    {canRemember && <p className="mt-2 text-ui-caption text-foreground-subtle">{browserPlan
      ? browserPlan.targetOrigin
        ? "记住的授权绑定当前页面、控制代次、目标和具体内容；人工接管或内容变化后重新审批。"
        : "记住的授权绑定当前页面、控制代次和具体操作；人工接管后重新审批。"
      : "记住的授权只适用于相同参数及权限条件，可在任务菜单的“已保存授权”中撤销。"}</p>}
  </section>;
}
