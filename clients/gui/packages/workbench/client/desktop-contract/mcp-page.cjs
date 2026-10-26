// @ts-check
"use strict";
const { record, identifier } = require("./transport.cjs");

/** @param {unknown} value @param {number} maximum */
function pageBounded(value, maximum) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximum)
    throw new Error("Invalid page tool size");
}
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
function pageFields(value, keys) {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
/** @param {unknown} value */
function pageRevision(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
/** @param {unknown} value */
function pageOffset(value) {
  return pageRevision(value) && Number(value) <= 65536;
}
/** @param {unknown} value */
function validateMcpPageDeclaration(value) {
  if (
    !pageFields(value, ["version", "documentId", "tools"]) ||
    value.version !== 1 ||
    !identifier(value.documentId) ||
    value.documentId.length > 128 ||
    !Array.isArray(value.tools) ||
    value.tools.length < 1 ||
    value.tools.length > 2 ||
    new Set(value.tools).size !== value.tools.length ||
    value.tools.some((kind) => !["getSelection", "applyPatch"].includes(kind))
  )
    throw new Error("Invalid page tool declaration");
  pageBounded(value, 1024);
}
/** @param {unknown} value */
function validateMcpPageCall(value) {
  if (
    !pageFields(value, ["callId", "kind", "documentId", "arguments"]) ||
    !identifier(value.callId) ||
    !identifier(value.documentId)
  )
    throw new Error("Invalid page tool call");
  const args = value.arguments;
  if (value.kind === "getSelection" && pageFields(args, [])) return;
  if (
    value.kind !== "applyPatch" ||
    !pageFields(args, ["expectedDocumentRevision", "patch"]) ||
    !pageRevision(args.expectedDocumentRevision) ||
    !pageFields(args.patch, ["from", "to", "insert"]) ||
    !pageOffset(args.patch.from) ||
    !pageOffset(args.patch.to) ||
    Number(args.patch.from) > Number(args.patch.to) ||
    typeof args.patch.insert !== "string" ||
    args.patch.insert.length > 4096 ||
    args.patch.insert.includes("\r")
  )
    throw new Error("Invalid page tool arguments");
  pageBounded(args, 32768);
}
/** @param {unknown} value */
function validateMcpPageReply(value) {
  pageBounded(value, 32768);
  if (pageFields(value, ["status"]) && value.status === "unknown") return;
  if (
    pageFields(value, ["status", "reason"]) &&
    value.status === "noEffect" &&
    ["cancelled", "closed", "unavailable"].includes(String(value.reason))
  )
    return;
  if (
    !pageFields(value, ["status", "result"]) ||
    value.status !== "completed" ||
    !record(value.result)
  )
    throw new Error("Invalid page tool reply");
  const result = value.result;
  if (!identifier(result.documentId) || !pageRevision(result.documentRevision))
    throw new Error("Invalid page tool result");
  if (
    result.kind === "selection" &&
    pageFields(result, [
      "kind",
      "documentId",
      "documentRevision",
      "anchor",
      "head",
      "selectedText",
      "truncated",
      "dirty",
    ]) &&
    pageOffset(result.anchor) &&
    pageOffset(result.head) &&
    typeof result.selectedText === "string" &&
    result.selectedText.length <= 4096 &&
    typeof result.truncated === "boolean" &&
    typeof result.dirty === "boolean"
  )
    return;
  if (
    result.kind === "applied" &&
    pageFields(result, [
      "kind",
      "documentId",
      "previousDocumentRevision",
      "documentRevision",
      "from",
      "to",
      "insertedLength",
      "dirty",
    ]) &&
    pageRevision(result.previousDocumentRevision) &&
    pageOffset(result.from) &&
    pageOffset(result.to) &&
    pageOffset(result.insertedLength) &&
    Number(result.insertedLength) <= 4096 &&
    typeof result.dirty === "boolean"
  )
    return;
  if (
    result.kind === "conflict" &&
    pageFields(result, ["kind", "documentId", "expectedDocumentRevision", "documentRevision"]) &&
    pageRevision(result.expectedDocumentRevision)
  )
    return;
  if (
    result.kind === "rejected" &&
    pageFields(result, ["kind", "documentId", "documentRevision", "reason"]) &&
    ["invalidRange", "documentTooLarge", "noChange"].includes(String(result.reason))
  )
    return;
  throw new Error("Invalid page tool result");
}
module.exports = { validateMcpPageDeclaration, validateMcpPageCall, validateMcpPageReply };
