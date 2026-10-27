// @ts-check
"use strict";
const { isDeepStrictEqual } = require("node:util");
const { readReceipts } = require("@areal/workbench/desktop-contract/shared");
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {import('./project-state.cjs').PendingSubmission} Pending */
/** @typedef {import('@areal/workbench/desktop-contract/shared').ReceiptError} ReceiptError */
/** @typedef {import('@areal/workbench/desktop-contract/shared').ReceiptResponse} ReceiptResponse */
/** @typedef {import('@areal/workbench/desktop-contract/shared').Receipt} Receipt */
const creationTargets = new Map([
  ["areal/thread/start", "thread"],
  ["areal/thread/fork", "thread"],
  ["areal/side/start", "thread"],
  ["areal/side/create", "thread"],
  ["areal/task/create", "task"],
]);
const processControls = new Set([
  "areal/process/write",
  "areal/process/closeStdin",
  "areal/process/resize",
  "areal/process/terminate",
]);
/** @param {string} method @param {import('./project-state.cjs').SubmissionParams} params @returns {import('@areal/runtime-client/core').OperationRef} */
const operationOf = (method, params) => ({
  method,
  requestId: params.requestId,
  target: creationTargets.has(method)
    ? { kind: "project" }
    : params.taskId
      ? { kind: "task", taskId: params.taskId }
      : params.threadId
        ? { kind: "thread", threadId: params.threadId }
        : { kind: "project" },
});
/** @param {unknown} error */
const explicitRejection = (error) =>
  modelRecord(error) &&
  modelRecord(error.outcome) &&
  ["rejected", "noMutation"].includes(String(error.outcome.kind));
/** @param {Pending} entry @param {Receipt[]} records @param {string} [scopedThreadId] */
function matchingReceipt(entry, records, scopedThreadId) {
  const operation = entry.operation ?? operationOf(entry.method, entry.params);
  const receiptMethod = processControls.has(entry.method) ? "areal/process/control" : entry.method;
  return records.find((receipt) => {
    const actual = receipt.operation;
    if (
      (actual?.requestId ?? receipt.requestId) !== operation.requestId ||
      (actual?.method ?? receipt.method) !== receiptMethod ||
      (entry.digest && receipt.digest !== entry.digest)
    )
      return false;
    const createdKind = creationTargets.get(entry.method);
    if (createdKind) {
      const result = modelRecord(receipt.result) ? receipt.result : undefined;
      const thread = modelRecord(result?.thread) ? result.thread : undefined;
      const id =
        createdKind === "task"
          ? (receipt.taskId ?? result?.id)
          : (receipt.threadId ?? result?.threadId ?? thread?.id);
      return (
        typeof id === "string" &&
        (!actual ||
          (actual.target.kind === "task" &&
            createdKind === "task" &&
            actual.target.taskId === id) ||
          (actual.target.kind === "thread" &&
            createdKind === "thread" &&
            actual.target.threadId === id))
      );
    }
    if (actual) return isDeepStrictEqual(actual.target, operation.target);
    if (operation.target.kind === "thread")
      return (receipt.threadId ?? scopedThreadId) === operation.target.threadId;
    if (operation.target.kind === "task") return receipt.taskId === operation.target.taskId;
    return !receipt.threadId && !receipt.taskId;
  });
}
/** @param {Receipt} receipt */
const receiptStatus = (receipt) =>
  receipt.status ??
  (receipt.response?.error
    ? "failed"
    : receipt.result !== undefined || receipt.response?.result !== undefined
      ? "completed"
      : "admitted");
/** @param {Receipt} receipt */
const receiptResult = (receipt) => receipt.result ?? receipt.response?.result;
/** @param {unknown} value @returns {string|undefined} */
function readReceiptIdentity(value) {
  if (value == null) return undefined;
  if (typeof value !== "string")
    throw Object.assign(new Error("Core 受理关联无效，原请求仍待核对"), {
      code: "RECEIPT_INVALID",
    });
  return value;
}
module.exports = {
  creationTargets,
  processControls,
  operationOf,
  explicitRejection,
  readReceipts,
  matchingReceipt,
  receiptStatus,
  receiptResult,
  readReceiptIdentity,
};
