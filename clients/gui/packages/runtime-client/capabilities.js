// @ts-check

/** @typedef {{effect:'read'|'subscription'|'mutation',receipt?:'thread'|'task'|'management'}} MethodSemantics */
/** @typedef {{workspaceModes?:string[],sideWorkspaceAccess?:string[],[key:string]:unknown}} ConversationDerivation */
/** @typedef {{conversationDerivationV1?:ConversationDerivation|null,[key:string]:unknown}} CoreFeatures */
/** @typedef {{bundleId:string,[key:string]:unknown}} ToolBundle */
/** @typedef {{methods:string[],apiVersion?:string,methodSemantics?:Record<string,MethodSemantics>,features?:CoreFeatures,runtime?:{epoch?:string,[key:string]:unknown}|null,browserToolBundles?:ToolBundle[],desktopToolBundles?:ToolBundle[],[key:string]:unknown}} CoreCapabilities */

/** @param {unknown} value @returns {CoreCapabilities} */
export function parseCoreCapabilities(value) {
  if (!isCoreCapabilities(value)) throw new Error("Invalid Core capabilities response");
  return value;
}

/** @param {unknown} value @returns {value is CoreCapabilities} */
function isCoreCapabilities(value) {
  return (
    record(value) &&
    strings(value.methods) &&
    (value.apiVersion === undefined || typeof value.apiVersion === "string") &&
    (value.methodSemantics === undefined ||
      (record(value.methodSemantics) && Object.values(value.methodSemantics).every(semantics))) &&
    (value.features === undefined || features(value.features)) &&
    (value.runtime == null ||
      (record(value.runtime) &&
        (value.runtime.epoch === undefined || typeof value.runtime.epoch === "string"))) &&
    (value.browserToolBundles === undefined || bundles(value.browserToolBundles)) &&
    (value.desktopToolBundles === undefined || bundles(value.desktopToolBundles))
  );
}
/** @param {unknown} value @returns {value is MethodSemantics} */
function semantics(value) {
  return (
    record(value) &&
    (value.effect === "read" || value.effect === "subscription" || value.effect === "mutation") &&
    (value.receipt === undefined ||
      value.receipt === "thread" ||
      value.receipt === "task" ||
      value.receipt === "management")
  );
}
/** @param {unknown} value @returns {value is CoreFeatures} */
function features(value) {
  if (!record(value)) return false;
  const derivation = value.conversationDerivationV1;
  return (
    derivation == null ||
    (record(derivation) &&
      (derivation.workspaceModes === undefined || strings(derivation.workspaceModes)) &&
      (derivation.sideWorkspaceAccess === undefined || strings(derivation.sideWorkspaceAccess)))
  );
}
/** @param {unknown} value @returns {value is ToolBundle[]} */
function bundles(value) {
  return (
    Array.isArray(value) &&
    value.every((bundle) => record(bundle) && typeof bundle.bundleId === "string")
  );
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
