// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { validToolInput } = require("./browser-tool.cjs");
/** @typedef {import('./preview-native/model.js').HostRequest|import('./preview-native/model.js').DiscoveryRequest} BrowserHostRequest */
/** The Desktop service adds authenticated identity to the already validated Core browser tool input. */
/** @param {unknown} value @returns {BrowserHostRequest} */
function readBrowserHostRequest(value) {
  if (!browserHostRequest(value)) throw new Error("Invalid browser host request");
  return value;
}
/** @param {unknown} value @returns {value is BrowserHostRequest} */
function browserHostRequest(value) {
  if (
    !modelRecord(value) ||
    !["coreInstanceId", "coreGeneration", "projectId", "threadId", "turnId", "callId"].every(
      (key) => typeof value[key] === "string",
    ) ||
    typeof value.requestId !== "number" ||
    !Number.isSafeInteger(value.requestId) ||
    (value.phase !== "prepare" && value.phase !== "execute") ||
    (value.browserApproval !== undefined && !modelRecord(value.browserApproval))
  )
    return false;
  if (value.operation === "describe") return true;
  return (
    ["pageId", "browserHostId"].every((key) => typeof value[key] === "string") &&
    ["hostGeneration", "pageGeneration", "controlEpoch"].every(
      (key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]),
    ) &&
    (value.batchDeadline === undefined || typeof value.batchDeadline === "number") &&
    value.batchGuard === undefined &&
    (value.workspacePath === undefined || typeof value.workspacePath === "string") &&
    validToolInput({ operation: value.operation, parameters: value.parameters })
  );
}
module.exports = { readBrowserHostRequest };
