import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextBasis, ContextBudget, ContextPart, ContextPartKind, ContextUsage, ContextUsageResponse, GenerationStats, ModelUsage, SessionUsage } from "../../packages/runtime-client/core.js";
import type { Action, Data } from "./services.js";

export const contextLabels: Record<ContextPartKind, string> = { systemPrompt: "System prompt", rules: "项目与用户规则", skills: "Skills", toolDefinitions: "工具定义", conversation: "对话", summary: "压缩摘要", attachments: "引用文件与附件", toolResults: "工具返回内容", other: "其他" };
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("上下文数据格式无效"); return value as Record<string, unknown>; };
const count = (value: unknown): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("上下文计量无效"); return value; };
const text = (value: unknown): string => { if (typeof value !== "string") throw new Error("上下文标识无效"); return value; };
const nullableText = (value: unknown) => value === null ? null : text(value);
function kind(value: unknown): ContextPartKind {
  switch (value) { case "systemPrompt": case "rules": case "skills": case "toolDefinitions": case "conversation": case "summary": case "attachments": case "toolResults": case "other": return value; default: throw new Error("未知上下文类别"); }
}
function part(value: unknown): ContextPart {
  const p = object(value);
  if (p.children !== undefined && !Array.isArray(p.children)) throw new Error("上下文分类无效");
  return { kind: kind(p.kind), name: text(p.name), estimatedTokens: count(p.estimatedTokens), children: p.children?.map(part) };
}
function budget(value: unknown): ContextBudget {
  const b = object(value);
  const windowSource = b.windowSource;
  if (windowSource !== "account" && windowSource !== "provider" && windowSource !== "user" && windowSource !== "modelDefault" && windowSource !== "fallback" && windowSource !== "model") throw new Error("上下文容量来源无效");
  const reportedWindowSource = b.reportedWindowSource;
  if (reportedWindowSource != null && reportedWindowSource !== "account" && reportedWindowSource !== "provider") throw new Error("上下文报告来源无效");
  return {
    windowTokens: count(b.windowTokens), outputReserveTokens: count(b.outputReserveTokens), inputLimitTokens: count(b.inputLimitTokens), windowSource,
    ...(b.reportedWindowTokens == null ? {} : { reportedWindowTokens: count(b.reportedWindowTokens) }),
    ...(reportedWindowSource == null ? {} : { reportedWindowSource }),
    ...(b.userBudgetTokens == null ? {} : { userBudgetTokens: count(b.userBudgetTokens) }),
  };
}
function basis(value: unknown): ContextBasis {
  const b = object(value);
  return { provider: text(b.provider), model: text(b.model), configurationRevision: count(b.configurationRevision), defaultModelRevision: nullableText(b.defaultModelRevision), turnId: nullableText(b.turnId) };
}
export function modelUsage(value: unknown): ModelUsage | null {
  if (value == null) return null;
  const u = object(value);
  return { inputTokens: count(u.inputTokens), outputTokens: count(u.outputTokens), cachedInputTokens: count(u.cachedInputTokens) };
}
export function generationStats(value: unknown): GenerationStats | null {
  if (value == null) return null;
  const g = object(value);
  return { outputTokens: count(g.outputTokens), durationMs: count(g.durationMs), measuredRequests: count(g.measuredRequests), unmeasuredRequests: count(g.unmeasuredRequests), usageRequests: count(g.usageRequests), missingUsageRequests: count(g.missingUsageRequests) };
}
function reading(value: unknown): ContextUsage {
  const r = object(value), identity = basis(r.basis);
  if (r.kind === "unavailable") {
    if (r.reason !== "awaitingRequest" && r.reason !== "modelUnavailable" && r.reason !== "instructionBasisChanged") throw new Error("未知上下文状态");
    return { kind: r.kind, basis: identity, budget: r.budget === null ? null : budget(r.budget), reason: r.reason };
  }
  if (r.kind !== "ready") throw new Error("上下文尚不可用");
  const e = object(r.estimate), scope = object(r.scope);
  if (!Array.isArray(e.parts)) throw new Error("上下文分类缺失");
  const estimate = { tokens: count(e.tokens), parts: e.parts.map(part) };
  if (estimate.parts.reduce((sum, part) => sum + part.estimatedTokens, 0) !== estimate.tokens) throw new Error("上下文分类与总量不一致");
  if (scope.kind !== "assembledRequest" && scope.kind !== "recordedHistory") throw new Error("未知上下文范围");
  return { kind: "ready", basis: identity, budget: budget(r.budget), estimate, scope: scope.kind === "assembledRequest" ? { kind: scope.kind, sequence: count(scope.sequence) } : { kind: scope.kind } };
}
function response(value: unknown): ContextUsageResponse {
  const r = object(value), s = object(r.sessionUsage), generation = generationStats(s.generation);
  if (!generation || s.scope !== "ownTurns") throw new Error("会话用量范围无效");
  const sessionUsage: SessionUsage = { usage: modelUsage(s.usage), generation, knownTurns: count(s.knownTurns), unknownTurns: count(s.unknownTurns), partialTurns: count(s.partialTurns), scope: s.scope };
  return { threadId: text(r.threadId), contextUsage: reading(r.contextUsage), sessionUsage };
}

export function useContextUsage(project: Data, thread: Data | undefined, action: Action, enabled = true) {
  const [result, setResult] = useState<ContextUsageResponse | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const acceptedVersion = useRef<string | null>(null);
  const sequence = useRef(0), inFlight = useRef<{ version: string; request: number } | null>(null);
  const last = thread?.turns?.at(-1), config = project.configurations?.[thread?.id ?? ""] ?? thread?.desktop?.configuration;
  const active = last?.status === "inProgress";
  const selectedModel = project.models?.find((model: Data) => config?.model
    ? model.providerId === config.model.providerId && model.modelId === config.model.modelId
    : !model.providerId);
  const modelCapacity = selectedModel && [selectedModel.providerRevision, selectedModel.contextWindowTokens, selectedModel.effectiveContextWindowTokens, selectedModel.reportedWindowTokens, selectedModel.reportedWindowSource, selectedModel.userBudgetTokens, selectedModel.windowSource];
  const version = JSON.stringify([project.id, project.state?.connected, project.core?.instanceId, thread?.id, config?.revision, config?.model, config?.resolvedParameters, modelCapacity, thread?.updatedAt, last?.id, last?.status, last?.items?.length, thread?.contextCheckpoint?.compactions, thread?.toolsetRevision, project.core?.connectionGeneration]);
  const current = useRef(version); current.current = version;
  const read = useCallback(async () => {
    if (!thread?.id || !project.state?.connected) return;
    const requestedVersion = current.current;
    if (inFlight.current?.version === requestedVersion) return;
    const request = ++sequence.current;
    inFlight.current = { version: requestedVersion, request };
    setBusy(true); setError("");
    try {
      const value = response(await action("manage", { projectId: project.id, threadId: thread.id, operation: "context", offset: 0, limit: 1 }));
      if (request !== sequence.current || requestedVersion !== current.current || value.threadId !== thread.id) return;
      if (!active && typeof config?.revision === "number" && value.contextUsage.basis.configurationRevision !== config.revision) return;
      acceptedVersion.current = requestedVersion; setResult(value);
    } catch (cause) { if (request === sequence.current && requestedVersion === current.current) setError(cause instanceof Error ? cause.message : "读取上下文失败"); }
    finally { if (inFlight.current?.request === request) inFlight.current = null; if (request === sequence.current) setBusy(false); }
  }, [action, project.id, project.state?.connected, thread?.id, active, config?.revision]);
  useEffect(() => {
    sequence.current++; inFlight.current = null; setBusy(false); setResult(null); setError("");
    if (!enabled) return;
    void read();
    const timer = active ? window.setInterval(() => { void read(); }, 1500) : undefined;
    return () => { sequence.current++; window.clearInterval(timer); };
  }, [read, version, enabled, active]);
  return { result: acceptedVersion.current === version ? result : null, error, busy, read };
}

export const tokenCount = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
export const generationRate = (value: GenerationStats | null | undefined) => value && value.measuredRequests > 0 && value.durationMs > 0 ? value.outputTokens * 1000 / value.durationMs : null;
