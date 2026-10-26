// @ts-check
"use strict";
const { record, integer } = require("./provider.cjs");
/** @typedef {{enabled:boolean,connected:boolean,installation:string|null,account:string|null,destination:string|null,opted_in:boolean}} FeedbackStatus */
/** @typedef {Record<string,unknown>&{feedback_id:string,rating:'up'|'down'}} FeedbackReceipt */
/** @typedef {{id:string,projectId:string,threadId:string,turnId:string,itemId:string,rating:'up'|'down',reason:string,analysis:string,context:Record<string,unknown>,contextSha256:string,expectedDestination:string|null,expectedOwner:string|null,expectedInstallation:string|null,state:'draft'|'submitted',createdAt:number,analysisItemId?:string,sideThreadId?:string,refineRequestId?:string,refineInput?:string,refinementUnknown?:boolean,closed?:boolean,submission?:Record<string,unknown>,receipt?:FeedbackReceipt}} FeedbackDraft */
/** @typedef {Omit<FeedbackDraft,'context'|'expectedDestination'|'expectedOwner'|'expectedInstallation'|'submission'|'refineInput'> & {submissionUnknown:boolean}} PublicFeedback */
/** @typedef {{rating?:'up'|'down',reason?:string,analysis?:string,analysisItemId?:string}} FeedbackEdits */
/** @typedef {{operation:'status'}|{operation:'preference',enabled:boolean}|{operation:'prepare',projectId:string,threadId:string,turnId:string,itemId:string,rating:'up'|'down'}|({id:string,projectId:string,threadId:string} & ({operation:'read'|'close'}|({operation:'draft'|'submit'}&FeedbackEdits)|({operation:'refine',text?:string}&FeedbackEdits)))} FeedbackRequest */
/** @template {string} N @typedef {N extends 'feedback' ? FeedbackRequest : never} Request */
/** @template {string} N @template P @typedef {N extends 'feedback' ? P extends {operation:'status'|'preference'} ? FeedbackStatus : P extends {operation:'prepare'|'read'|'draft'|'refine'|'submit'|'close'} ? PublicFeedback : never : never} Response */
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string";
}
/** @param {unknown} value @returns {value is string} */
function identifier(value) {
  return text(value) && value.trim().length > 0 && value.length <= 256;
}
/** @param {unknown} value @returns {value is FeedbackReceipt} */
function feedbackReceipt(value) {
  return (
    record(value) && text(value.feedback_id) && (value.rating === "up" || value.rating === "down")
  );
}
/** @template {string} N @param {N} name @param {unknown} value @returns {value is Request<N>} */
function isRequest(name, value) {
  if (name !== "feedback" || !record(value)) return false;
  const operation = String(value.operation);
  const fields = [
    "operation",
    ...(operation === "preference"
      ? ["enabled"]
      : operation === "status"
        ? []
        : [
            "projectId",
            "threadId",
            ...(operation === "prepare" ? ["turnId", "itemId", "rating"] : ["id"]),
            ...(["draft", "refine", "submit"].includes(operation)
              ? ["rating", "reason", "analysis", "analysisItemId"]
              : []),
            ...(operation === "refine" ? ["text"] : []),
          ]),
  ];
  if (Object.keys(value).some((key) => !fields.includes(key))) return false;
  if (
    value.analysisItemId !== undefined &&
    (!text(value.analysisItemId) || value.analysisItemId.length > 256)
  )
    return false;
  if (
    Object.entries({ reason: 32768, analysis: 65536, text: 16384 }).some(([key, max]) => {
      const content = value[key];
      return (
        content !== undefined && (!text(content) || new TextEncoder().encode(content).length > max)
      );
    })
  )
    return false;
  if (value.operation === "status") return true;
  if (value.operation === "preference") return typeof value.enabled === "boolean";
  if (!identifier(value.projectId) || !identifier(value.threadId)) return false;
  if (value.operation === "prepare")
    return (
      text(value.turnId) && text(value.itemId) && (value.rating === "up" || value.rating === "down")
    );
  if (!identifier(value.id)) return false;
  if (value.operation === "read" || value.operation === "close") return true;
  return (
    ["draft", "refine", "submit"].includes(String(value.operation)) &&
    (value.rating === undefined || value.rating === "up" || value.rating === "down") &&
    ["reason", "analysis", "analysisItemId", "text"].every(
      (key) => value[key] === undefined || text(value[key]),
    )
  );
}
/** @param {unknown} value @returns {value is Omit<PublicFeedback,'submissionUnknown'>} */
function publicFields(value) {
  return (
    record(value) &&
    [
      "id",
      "projectId",
      "threadId",
      "turnId",
      "itemId",
      "reason",
      "analysis",
      "contextSha256",
    ].every((key) => text(value[key])) &&
    (value.state === "draft" || value.state === "submitted") &&
    (value.rating === "up" || value.rating === "down") &&
    integer(value.createdAt) &&
    ["analysisItemId", "sideThreadId", "refineRequestId"].every(
      (key) => value[key] === undefined || text(value[key]),
    ) &&
    ["refinementUnknown", "closed"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.receipt === undefined || feedbackReceipt(value.receipt))
  );
}
/** @param {unknown} value @returns {value is FeedbackDraft} */
function feedbackDraft(value) {
  return (
    record(value) &&
    record(value.context) &&
    ["expectedDestination", "expectedOwner", "expectedInstallation"].every(
      (key) => value[key] === null || text(value[key]),
    ) &&
    (value.refineInput === undefined || text(value.refineInput)) &&
    (value.submission === undefined || record(value.submission)) &&
    publicFields(value)
  );
}
/** @template {string} N @template P @param {N} name @param {P} request @param {unknown} value @returns {value is Response<N,P>} */
function isResponse(name, request, value) {
  if (name !== "feedback" || !record(request) || !record(value)) return false;
  if (request.operation === "status" || request.operation === "preference")
    return (
      ["enabled", "connected", "opted_in"].every((key) => typeof value[key] === "boolean") &&
      ["installation", "account", "destination"].every(
        (key) => value[key] === null || text(value[key]),
      )
    );
  return (
    ["prepare", "read", "draft", "refine", "submit", "close"].includes(String(request.operation)) &&
    typeof value.submissionUnknown === "boolean" &&
    (request.id === undefined || request.id === value.id) &&
    (request.projectId === undefined || request.projectId === value.projectId) &&
    (request.threadId === undefined || request.threadId === value.threadId) &&
    publicFields(value)
  );
}
module.exports = { isRequest, isResponse, feedbackDraft, feedbackReceipt };
