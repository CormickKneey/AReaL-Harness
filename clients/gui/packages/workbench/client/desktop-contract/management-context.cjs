// @ts-check
"use strict";
const { modelRecord } = require("../core-model-contract.js");
/** @typedef {import('../../../runtime-client/core.js').ContextUsage} ContextUsage */
/** @typedef {import('../../../runtime-client/core.js').SessionUsage} SessionUsage */
/** @typedef {import('../../../runtime-client/core.js').ContextBasis} ContextBasis */
/** @typedef {import('../../../runtime-client/core.js').ContextBudget} ContextBudget */
/** @typedef {import('../../../runtime-client/core.js').ContextPart} ContextPart */
/** @typedef {import('../../../runtime-client/core.js').ModelUsage} ModelUsage */
/** @typedef {import('../../../runtime-client/core.js').GenerationStats} GenerationStats */

/** @param {unknown} value @returns {value is number} */
const count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** @param {unknown} value @returns {value is ContextPart} */
function part(value) {
  return (
    modelRecord(value) &&
    typeof value.name === "string" &&
    count(value.estimatedTokens) &&
    typeof value.kind === "string" &&
    [
      "systemPrompt",
      "rules",
      "skills",
      "toolDefinitions",
      "conversation",
      "summary",
      "attachments",
      "toolResults",
      "other",
    ].includes(value.kind) &&
    (value.children === undefined || (Array.isArray(value.children) && value.children.every(part)))
  );
}
/** @param {unknown} value @returns {value is ContextBudget} */
function budget(value) {
  return (
    modelRecord(value) &&
    count(value.windowTokens) &&
    count(value.outputReserveTokens) &&
    count(value.inputLimitTokens) &&
    typeof value.windowSource === "string" &&
    ["account", "provider", "user", "modelDefault", "fallback", "model"].includes(
      value.windowSource,
    ) &&
    (value.reportedWindowTokens === undefined || count(value.reportedWindowTokens)) &&
    (value.reportedWindowSource === undefined ||
      value.reportedWindowSource === "account" ||
      value.reportedWindowSource === "provider") &&
    (value.userBudgetTokens === undefined || count(value.userBudgetTokens))
  );
}
/** @param {unknown} value @returns {value is ContextBasis} */
function basis(value) {
  return (
    modelRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    count(value.configurationRevision) &&
    (value.defaultModelRevision === null || typeof value.defaultModelRevision === "string") &&
    (value.turnId === null || typeof value.turnId === "string")
  );
}
/** @param {unknown} value @returns {value is ModelUsage} */
function isModelUsage(value) {
  return (
    modelRecord(value) &&
    count(value.inputTokens) &&
    count(value.outputTokens) &&
    count(value.cachedInputTokens)
  );
}
/** @param {unknown} value @returns {ModelUsage|null} */
function modelUsage(value) {
  if (value == null) return null;
  if (!isModelUsage(value)) throw new Error("上下文计量无效");
  return value;
}
/** @param {unknown} value @returns {value is GenerationStats} */
function isGenerationStats(value) {
  return (
    modelRecord(value) &&
    [
      "outputTokens",
      "durationMs",
      "measuredRequests",
      "unmeasuredRequests",
      "usageRequests",
      "missingUsageRequests",
    ].every((key) => count(value[key]))
  );
}
/** @param {unknown} value @returns {GenerationStats|null} */
function generationStats(value) {
  if (value == null) return null;
  if (!isGenerationStats(value)) throw new Error("上下文计量无效");
  return value;
}
/** @param {unknown} value @returns {value is ContextUsage} */
function isContextUsage(value) {
  if (!modelRecord(value) || !basis(value.basis)) return false;
  if (value.kind === "unavailable")
    return (
      (value.budget === null || budget(value.budget)) &&
      typeof value.reason === "string" &&
      ["awaitingRequest", "modelUnavailable", "instructionBasisChanged"].includes(value.reason)
    );
  if (
    value.kind !== "ready" ||
    !budget(value.budget) ||
    !modelRecord(value.estimate) ||
    !modelRecord(value.scope)
  )
    return false;
  const estimate = value.estimate;
  return (
    count(estimate.tokens) &&
    Array.isArray(estimate.parts) &&
    estimate.parts.every(part) &&
    estimate.parts.reduce((sum, part) => sum + part.estimatedTokens, 0) === estimate.tokens &&
    (value.scope.kind === "recordedHistory" ||
      (value.scope.kind === "assembledRequest" && count(value.scope.sequence)))
  );
}
/** @param {unknown} value @returns {value is SessionUsage} */
function isSessionUsage(value) {
  return (
    modelRecord(value) &&
    value.scope === "ownTurns" &&
    (value.usage === null || isModelUsage(value.usage)) &&
    isGenerationStats(value.generation) &&
    count(value.knownTurns) &&
    count(value.unknownTurns) &&
    count(value.partialTurns)
  );
}
/** @param {unknown} value @returns {import('../../../runtime-client/core.js').ContextUsageResponse} */
function readContextUsageResponse(value) {
  if (
    !modelRecord(value) ||
    typeof value.threadId !== "string" ||
    !isContextUsage(value.contextUsage) ||
    !isSessionUsage(value.sessionUsage)
  )
    throw new Error("上下文数据格式无效");
  return {
    threadId: value.threadId,
    contextUsage: value.contextUsage,
    sessionUsage: value.sessionUsage,
  };
}
module.exports = {
  isContextUsage,
  isSessionUsage,
  readContextUsageResponse,
  modelUsage,
  generationStats,
};
