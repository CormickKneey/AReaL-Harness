// @ts-check
"use strict";
const { modelRecord } = require("../core-model-contract.js");
const { protocolFor } = require("./generated/management-protocol.cjs");
/** @typedef {'pluginArchiveImport'|'marketplaceAdd'|'marketplaceAddGit'|'marketplaceRemove'|'marketplaceUpdate'|'pluginResolve'|'pluginConnection'|'pluginHooksConfigure'|'hookAcknowledge'|'pluginAuthConfigure'|'connectorConfigure'|'pluginInstall'|'pluginConfigure'|'pluginComponentConfigure'|'pluginUninstall'|'pluginSetup'} PluginMutation */
/** @typedef {import('./generated/management-protocol.cjs').RequestMap} ProtocolRequestMap */
/** @typedef {import('./generated/management-protocol.cjs').ResponseMap} ProtocolResponseMap */
/** @typedef {{projectId:string,operation:'workgroupArtifactStatus'|'workgroupApplyArtifact',id:string,path:string,head:string}} ArtifactRequest */
/** @typedef {{
 * workgroupArtifactStatus:ArtifactRequest&{operation:'workgroupArtifactStatus'},workgroupApplyArtifact:ArtifactRequest&{operation:'workgroupApplyArtifact'},
 * workgroupCapabilities:{projectId:string,operation:'workgroupCapabilities'},pluginCapabilities:{projectId:string,operation:'pluginCapabilities'},
 * workgroupSubmission:{projectId:string,operation:'workgroupSubmission',requestId:string},
 * pluginReadiness:{projectId:string,operation:'pluginReadiness',id:string,expectedDigest:string},
 * pluginSubmission:{projectId:string,operation:'pluginSubmission',requestId:string,mutation:PluginMutation,threadId?:string},
 * processSubmission:{projectId:string,operation:'processSubmission',threadId:string,requestId:string,guiOwned?:boolean},
 * agentSubmission:{projectId:string,operation:'agentSubmission',parentThreadId:string,requestId:string},
 * mcpFormResourceSubmission:{projectId:string,operation:'mcpFormResourceSubmission',requestId:string},
 * pluginArchivePick:{projectId:string,operation:'pluginArchivePick'}
 * }} LocalRequestMap */
/** @template T @typedef {{confirmed:false,state?:string}|{confirmed:true,accepted:true,status:'completed'|'failed',operation?:import('../../../runtime-client/core.js').OperationRef,warning?:string}&({result:T,error?:never,message?:never}|{error:import('../desktop-contract.cjs').DesktopError,message:string,result?:never})} SubmissionRead */
/** @typedef {{shell:string,fontFamily:string,fontFamilySource:'custom'|'system'|'fallback',fontSize?:number,theme?:Record<string,string>}} TerminalPresentation */
/** @typedef {{path:string,head:string,state:'matches'|'ready'|'conflict'}} ArtifactState */
/** @typedef {{pluginId:string,installedDigest:string|null|undefined,requiredTools:string[],missingTools:string[],available:boolean}} PluginReadiness */
/** @typedef {{
 * workgroupArtifactStatus:ArtifactState,workgroupApplyArtifact:ArtifactState,workgroupCapabilities:{enabled:boolean},pluginCapabilities:{enabled:boolean},
 * workgroupSubmission:{confirmed:false}|({confirmed:true,accepted:true,method:string,workgroupId:string,planRevision:number}&import('./shared.cjs').SubmissionOutcome),
 * pluginReadiness:PluginReadiness,pluginSubmission:SubmissionRead<ProtocolResponseMap[PluginMutation]>,
 * processSubmission:{confirmed:false}|{confirmed:true,result:ProtocolResponseMap['processStart']&TerminalPresentation&{argv:string[],closed:boolean,controls:number}},
 * agentSubmission:{confirmed:false}|({confirmed:true,accepted:true,method:'areal/agent/spawn',parentThreadId:string,threadId:string,turnId:string}&import('./shared.cjs').SubmissionOutcome),
 * mcpFormResourceSubmission:SubmissionRead<ProtocolResponseMap['mcpFormResourceStage']>,
 * pluginArchivePick:{canceled:true}|{selectionToken:string,fileName:string}
 * }} LocalResponseMap */
/** @typedef {ProtocolRequestMap&LocalRequestMap&import('./management-tasks.cjs').LocalTaskRequestMap} ManagementRequestMap */
/** @typedef {ProtocolResponseMap&LocalResponseMap&import('./management-tasks.cjs').LocalTaskResponseMap} ManagementResponseMap */
/** @typedef {ManagementRequestMap[keyof ManagementRequestMap]} ManagementRequest */
/** @template {ManagementRequest} P @typedef {P extends {operation:'processStart',terminal:true} ? ProtocolResponseMap['processStart']&TerminalPresentation : P extends {operation:'pluginSubmission',mutation:infer M extends PluginMutation} ? SubmissionRead<ProtocolResponseMap[M]> : ManagementResponseMap[P['operation']]} ManagementResponse */
/** @param {unknown} value @returns {value is string[]} */
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** @param {unknown} value @returns {value is PluginMutation} */
function pluginMutation(value) {
  return (
    typeof value === "string" &&
    [
      "pluginArchiveImport",
      "marketplaceAdd",
      "marketplaceAddGit",
      "marketplaceRemove",
      "marketplaceUpdate",
      "pluginResolve",
      "pluginConnection",
      "pluginHooksConfigure",
      "hookAcknowledge",
      "pluginAuthConfigure",
      "connectorConfigure",
      "pluginInstall",
      "pluginConfigure",
      "pluginComponentConfigure",
      "pluginUninstall",
      "pluginSetup",
    ].includes(value)
  );
}
/** @param {unknown} value @returns {value is ManagementRequest} */
function isManagementRequest(value) {
  if (
    !modelRecord(value) ||
    typeof value.operation !== "string" ||
    typeof value.projectId !== "string"
  )
    return false;
  const protocol = protocolFor(value.operation);
  if (protocol)
    return (
      Object.entries(protocol.requests).find(([operation]) => operation === value.operation)?.[1](
        value,
      ) === true
    );
  if (value.operation.startsWith("task"))
    return require("./management-tasks.cjs").localTaskRequest(value);
  switch (value.operation) {
    case "workgroupArtifactStatus":
    case "workgroupApplyArtifact":
      return ["id", "path", "head"].every((key) => typeof value[key] === "string");
    case "workgroupCapabilities":
    case "pluginCapabilities":
    case "pluginArchivePick":
      return true;
    case "workgroupSubmission":
    case "mcpFormResourceSubmission":
      return typeof value.requestId === "string";
    case "pluginReadiness":
      return (
        typeof value.id === "string" &&
        value.id.trim().length > 0 &&
        typeof value.expectedDigest === "string" &&
        value.expectedDigest.trim().length > 0
      );
    case "pluginSubmission":
      return (
        typeof value.requestId === "string" &&
        pluginMutation(value.mutation) &&
        (value.threadId === undefined || typeof value.threadId === "string")
      );
    case "processSubmission":
      return (
        typeof value.requestId === "string" &&
        typeof value.threadId === "string" &&
        (value.guiOwned === undefined || typeof value.guiOwned === "boolean")
      );
    case "agentSubmission":
      return typeof value.requestId === "string" && typeof value.parentThreadId === "string";
    default:
      return false;
  }
}
/** @param {unknown} value @returns {ManagementRequest} */
function readManagementRequest(value) {
  if (!isManagementRequest(value))
    throw new Error(
      modelRecord(value) && value.operation === "pluginReadiness"
        ? "Missing installed plugin snapshot"
        : "管理请求结构无效",
    );
  return value;
}
/** @param {string} operation @param {unknown} value */
function protocolResponse(operation, value) {
  const protocol = protocolFor(operation);
  return (
    !!protocol &&
    Object.entries(protocol.responses).find(([name]) => name === operation)?.[1](value) === true
  );
}
/** @param {unknown} value @param {string} operation */
function submissionRead(value, operation) {
  if (
    !modelRecord(value) ||
    typeof value.confirmed !== "boolean" ||
    (value.warning !== undefined && typeof value.warning !== "string")
  )
    return false;
  if (!value.confirmed) return value.state === undefined || typeof value.state === "string";
  if (
    value.accepted !== true ||
    !(typeof value.status === "string" && ["completed", "failed"].includes(value.status)) ||
    (value.operation !== undefined && !require("./shared.cjs").isOperationRef(value.operation))
  )
    return false;
  if (value.error !== undefined)
    return (
      modelRecord(value.error) &&
      typeof value.error.message === "string" &&
      typeof value.message === "string" &&
      (value.error.code === undefined ||
        typeof value.error.code === "string" ||
        typeof value.error.code === "number")
    );
  return protocolResponse(operation, value.result);
}
/** @param {ManagementRequest} request @param {unknown} value */
function validateManagementResponse(request, value) {
  const operation = request.operation;
  if (protocolFor(operation)) {
    if (
      !protocolResponse(operation, value) ||
      (request.operation === "processStart" &&
        request.terminal === true &&
        !terminalPresentation(value))
    )
      throw new Error("Core 管理响应结构无效");
    return;
  }
  if (operation.startsWith("task")) {
    if (!require("./management-tasks.cjs").localTaskResponse(operation, value))
      throw new Error("任务管理响应结构无效");
    return;
  }
  if (!modelRecord(value)) throw new Error("管理响应结构无效");
  const valid = (() => {
    switch (operation) {
      case "workgroupArtifactStatus":
      case "workgroupApplyArtifact":
        return (
          typeof value.path === "string" &&
          typeof value.head === "string" &&
          typeof value.state === "string" &&
          ["matches", "ready", "conflict"].includes(value.state)
        );
      case "workgroupCapabilities":
      case "pluginCapabilities":
        return typeof value.enabled === "boolean";
      case "pluginArchivePick":
        return (
          value.canceled === true ||
          (typeof value.selectionToken === "string" && typeof value.fileName === "string")
        );
      case "pluginReadiness":
        return (
          typeof value.pluginId === "string" &&
          (value.installedDigest == null || typeof value.installedDigest === "string") &&
          strings(value.requiredTools) &&
          strings(value.missingTools) &&
          typeof value.available === "boolean"
        );
      case "pluginSubmission":
        return "mutation" in request && submissionRead(value, request.mutation);
      case "mcpFormResourceSubmission":
        return submissionRead(value, "mcpFormResourceStage");
      case "processSubmission":
        return (
          value.confirmed === false ||
          (value.confirmed === true &&
            protocolResponse("processStart", value.result) &&
            terminalPresentation(value.result) &&
            modelRecord(value.result) &&
            strings(value.result.argv) &&
            typeof value.result.closed === "boolean" &&
            typeof value.result.controls === "number" &&
            Number.isSafeInteger(value.result.controls))
        );
      case "agentSubmission":
        return (
          value.confirmed === false ||
          (value.confirmed === true &&
            value.accepted === true &&
            value.method === "areal/agent/spawn" &&
            ["parentThreadId", "threadId", "turnId"].every(
              (key) => typeof value[key] === "string",
            ) &&
            require("./shared.cjs").isSubmissionOutcomes({ receipt: value }))
        );
      case "workgroupSubmission":
        return (
          value.confirmed === false ||
          (value.confirmed === true &&
            value.accepted === true &&
            typeof value.method === "string" &&
            typeof value.workgroupId === "string" &&
            typeof value.planRevision === "number" &&
            Number.isSafeInteger(value.planRevision) &&
            require("./shared.cjs").isSubmissionOutcomes({ receipt: value }))
        );
      default:
        return false;
    }
  })();
  if (!valid) throw new Error("管理响应结构无效");
}
/** @param {unknown} value @returns {import('./generated/management-plugins-protocol.cjs').ResponseMap['plugin']} */
function readPluginReadiness(value) {
  if (!require("./generated/management-plugins-protocol.cjs").responses.plugin(value))
    throw new Error("插件就绪记录结构无效");
  return value;
}
module.exports = {
  isManagementRequest,
  readManagementRequest,
  validateManagementResponse,
  readPluginReadiness,
  protocolResponse,
};

/** @param {unknown} value @returns {value is TerminalPresentation & Record<string,unknown>} */
function terminalPresentation(value) {
  return (
    modelRecord(value) &&
    typeof value.shell === "string" &&
    typeof value.fontFamily === "string" &&
    typeof value.fontFamilySource === "string" &&
    ["custom", "system", "fallback"].includes(value.fontFamilySource) &&
    (value.fontSize === undefined ||
      (typeof value.fontSize === "number" && Number.isFinite(value.fontSize))) &&
    (value.theme === undefined ||
      (modelRecord(value.theme) &&
        Object.values(value.theme).every((item) => typeof item === "string")))
  );
}
