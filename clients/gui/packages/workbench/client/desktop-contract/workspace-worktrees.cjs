// @ts-check
"use strict";
const { modelRecord } = require("../core-model-contract.js");
/** @typedef {{default:string,macos?:string,linux?:string}} EnvironmentScript */
/** @typedef {{id:string,name:string,setup:EnvironmentScript,cleanup:EnvironmentScript,actions:Array<{id:string,name:string,script:EnvironmentScript}>}} EnvironmentDefinition */
/** @typedef {{worktreeRoot:string,branchPrefix:string,fetchBeforeCreate:boolean,autoCleanup:boolean,keepCount:number}} WorktreeSettings */
/** @typedef {Record<string,unknown> & {requestId?:string,projectId?:string,threadId?:string,sourceThreadId?:string,parentThreadId?:string,threadIds?:string[],logicalProjectId?:string,taskId?:string,executionProjectId?:string,operation?:string,source?:string,sourceRoot?:string,ref?:string,worktreeRoot?:string,branch?:string,branchPrefix?:string,worktree?:import('../desktop-contract.cjs').WorktreeSpec,environmentId?:string,environment?:EnvironmentDefinition,expectedRevision?:number,worktreeRequestId?:string,actionId?:string,automatic?:boolean,fetchBeforeCreate?:boolean,autoCleanup?:boolean,keepCount?:number}} WorktreeRequest */
/** @typedef {Record<string,unknown> & {directory:string,branch:string,base:string,target:string,cwd?:string,requestId?:string,sourceCwd?:string,relativeCwd?:string,sourceHead?:string,source?:string,sourceRef?:string|null,commonDir?:string,copied?:string[],createdAt?:string}} WorktreeRecord */
/** @typedef {'creating'|'created'|'binding'|'settingUp'|'ready'|'cancelled'|'failed'|'unknown'} WorktreeState */
/** @typedef {{requestId:string,kind:'setup'|'cleanup'|'action',script:string,status:'running'|'unknown'|'succeeded'|'failed'|'cancelled',startedAt?:string,timeoutMs?:number,output?:string,actionId?:string,processId?:string,receipt?:import('./generated/management-processes-protocol.cjs').ResponseMap['processStart'],message?:string,terminateRequestId?:string,closeRequestId?:string,cursor?:string|null,outputTruncated?:boolean,runtime?:import('./generated/management-processes-protocol.cjs').ResponseMap['process']['runtime'],managed?:import('./generated/management-processes-protocol.cjs').ResponseMap['process']['process'],finishedAt?:string,exitCode?:number|null}} EnvironmentAttempt */
/** @typedef {{requestId:string,status:'running'|'unknown'|'succeeded'|'blocked',blockers?:string[],stopRequestId?:string,stopReceipt?:import('./shared.cjs').LifecycleReceipt,result?:WorktreeRemoval}} DeletionAttempt */
/** @typedef {Record<string,unknown> & {kind:'thread'|'checkout',requestId:string,projectId:string,parameters:WorktreeRequest,state:WorktreeState,events?:Array<{id:string,state:WorktreeState,time:string,message?:string}>,record?:WorktreeRecord,executionProjectId?:string,threadId?:string,sourceRoot?:string,environment?:EnvironmentDefinition,environmentRevision?:number,settings?:WorktreeSettings,intent?:string,createdAt?:string,automatic?:boolean,usesSource?:boolean,message?:string,setup?:EnvironmentAttempt,cleanup?:EnvironmentAttempt,actions?:Record<string,EnvironmentAttempt>,deletion?:DeletionAttempt,deleted?:boolean,deletedAt?:string}} WorktreeOperation */
/** @typedef {{requestId:string,creationId:string,directory:string,branch:string,target:string,removed:boolean}} WorktreeRemoval */
/** @param {unknown} value @returns {value is EnvironmentScript} */
function environmentScript(value) {
  return (
    modelRecord(value) &&
    typeof value.default === "string" &&
    ["macos", "linux"].every((key) => value[key] === undefined || typeof value[key] === "string")
  );
}
/** @param {unknown} value @returns {value is EnvironmentDefinition} */
function environmentDefinition(value) {
  return (
    modelRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    environmentScript(value.setup) &&
    environmentScript(value.cleanup) &&
    Array.isArray(value.actions) &&
    value.actions.every(
      (action) =>
        modelRecord(action) &&
        typeof action.id === "string" &&
        typeof action.name === "string" &&
        environmentScript(action.script),
    )
  );
}
/** @param {unknown} value @returns {value is WorktreeSettings} */
function worktreeSettings(value) {
  return (
    modelRecord(value) &&
    typeof value.worktreeRoot === "string" &&
    typeof value.branchPrefix === "string" &&
    typeof value.fetchBeforeCreate === "boolean" &&
    typeof value.autoCleanup === "boolean" &&
    typeof value.keepCount === "number"
  );
}
/** @param {unknown} value @returns {value is WorktreeRecord} */
function isWorktreeRecord(value) {
  return (
    modelRecord(value) &&
    ["directory", "branch", "base", "target"].every((key) => typeof value[key] === "string") &&
    [
      "cwd",
      "requestId",
      "sourceCwd",
      "relativeCwd",
      "sourceHead",
      "source",
      "commonDir",
      "createdAt",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.sourceRef == null || typeof value.sourceRef === "string") &&
    (value.copied === undefined ||
      (Array.isArray(value.copied) && value.copied.every((item) => typeof item === "string")))
  );
}
/** @param {unknown} value @returns {WorktreeRequest} */
function readWorktreeRequest(value) {
  if (!isWorktreeRequest(value)) throw new Error("工作树请求字段无效");
  return value;
}
/** @param {unknown} value @returns {value is WorktreeRequest} */
function isWorktreeRequest(value) {
  const worktree = modelRecord(value) && modelRecord(value.worktree) ? value.worktree : {};
  return (
    modelRecord(value) &&
    [
      "requestId",
      "projectId",
      "threadId",
      "sourceThreadId",
      "parentThreadId",
      "logicalProjectId",
      "taskId",
      "executionProjectId",
      "operation",
      "source",
      "sourceRoot",
      "ref",
      "worktreeRoot",
      "branch",
      "branchPrefix",
      "environmentId",
      "worktreeRequestId",
      "actionId",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.expectedRevision === undefined || typeof value.expectedRevision === "number") &&
    ["automatic", "fetchBeforeCreate", "autoCleanup"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.keepCount === undefined || typeof value.keepCount === "number") &&
    (value.threadIds === undefined ||
      (Array.isArray(value.threadIds) && value.threadIds.every((id) => typeof id === "string"))) &&
    (value.environment === undefined || environmentDefinition(value.environment)) &&
    (value.worktree === undefined ||
      (modelRecord(value.worktree) &&
        ["sourceRoot", "ref", "worktreeRoot", "branch", "branchPrefix", "environmentId"].every(
          (key) => worktree[key] === undefined || typeof worktree[key] === "string",
        ) &&
        (value.worktree.environmentRevision === undefined ||
          typeof value.worktree.environmentRevision === "number") &&
        (value.worktree.mode === undefined ||
          value.worktree.mode === "source" ||
          value.worktree.mode === "worktree")))
  );
}
/** @param {unknown} value @returns {value is EnvironmentAttempt} */
function environmentAttempt(value) {
  return (
    modelRecord(value) &&
    ["requestId", "script"].every((key) => typeof value[key] === "string") &&
    typeof value.kind === "string" &&
    ["setup", "cleanup", "action"].includes(value.kind) &&
    typeof value.status === "string" &&
    ["running", "unknown", "succeeded", "failed", "cancelled"].includes(value.status) &&
    (value.timeoutMs === undefined || typeof value.timeoutMs === "number") &&
    [
      "actionId",
      "processId",
      "message",
      "terminateRequestId",
      "closeRequestId",
      "finishedAt",
      "startedAt",
      "output",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.cursor == null || typeof value.cursor === "string") &&
    (value.outputTruncated === undefined || typeof value.outputTruncated === "boolean") &&
    (value.exitCode == null || typeof value.exitCode === "number") &&
    (value.receipt === undefined ||
      require("./generated/management-processes-protocol.cjs").responses.processStart(
        value.receipt,
      )) &&
    (value.runtime === undefined ||
      value.runtime === null ||
      require("./generated/management-processes-protocol.cjs").responses.processWait({
        timedOut: false,
        runtime: value.runtime,
      })) &&
    (value.managed === undefined ||
      require("./generated/management-processes-protocol.cjs").responses.processes({
        data: [value.managed],
      }))
  );
}
/** @param {unknown} value @returns {value is DeletionAttempt} */
function deletionAttempt(value) {
  return (
    modelRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.status === "string" &&
    ["running", "unknown", "succeeded", "blocked"].includes(value.status) &&
    (value.blockers === undefined ||
      (Array.isArray(value.blockers) &&
        value.blockers.every((item) => typeof item === "string"))) &&
    (value.stopRequestId === undefined || typeof value.stopRequestId === "string") &&
    (value.stopReceipt === undefined ||
      require("./shared.cjs").isLifecycleReceipt(value.stopReceipt)) &&
    (value.result === undefined || isWorktreeRemoval(value.result))
  );
}
/** @param {unknown} value @returns {WorktreeOperation} */
function readOperation(value) {
  if (!isOperation(value)) throw new Error("工作树创建日志无效");
  return value;
}
/** @param {unknown} value @returns {value is WorktreeOperation} */
function isOperation(value) {
  return (
    modelRecord(value) &&
    ["requestId", "projectId"].every((key) => typeof value[key] === "string") &&
    (value.kind === "thread" || value.kind === "checkout") &&
    worktreeState(value.state) &&
    isWorktreeRequest(value.parameters) &&
    (value.events === undefined ||
      (Array.isArray(value.events) &&
        value.events.every(
          (event) =>
            modelRecord(event) &&
            ["id", "time"].every((key) => typeof event[key] === "string") &&
            worktreeState(event.state) &&
            (event.message === undefined || typeof event.message === "string"),
        ))) &&
    [
      "executionProjectId",
      "threadId",
      "sourceRoot",
      "intent",
      "createdAt",
      "message",
      "deletedAt",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    ["automatic", "usesSource", "deleted"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value.environmentRevision === undefined || typeof value.environmentRevision === "number") &&
    (value.record === undefined || isWorktreeRecord(value.record)) &&
    (value.settings === undefined || worktreeSettings(value.settings)) &&
    (value.environment === undefined || environmentDefinition(value.environment)) &&
    (value.setup === undefined || environmentAttempt(value.setup)) &&
    (value.cleanup === undefined || environmentAttempt(value.cleanup)) &&
    (value.actions === undefined ||
      (modelRecord(value.actions) && Object.values(value.actions).every(environmentAttempt))) &&
    (value.deletion === undefined || deletionAttempt(value.deletion))
  );
}

module.exports = {
  environmentDefinition,
  worktreeSettings,
  isWorktreeRecord,
  readWorktreeRequest,
  isWorktreeRequest,
  readOperation,
  isOperation,
  environmentAttempt,
  isWorktreeRemoval,
  readWorktreeRemoval,
  readEnvironmentProcess,
  readEnvironmentOutput,
};

/** @param {unknown} value @returns {value is WorktreeRemoval} */
function isWorktreeRemoval(value) {
  return (
    modelRecord(value) &&
    ["requestId", "creationId", "directory", "branch", "target"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.removed === "boolean"
  );
}
/** @param {unknown} value @returns {WorktreeRemoval} */
function readWorktreeRemoval(value) {
  if (!isWorktreeRemoval(value)) throw new Error("工作树删除回执结构无效");
  return value;
}
/** @param {unknown} value @returns {import('./generated/management-processes-protocol.cjs').ResponseMap['process']} */
function readEnvironmentProcess(value) {
  if (!require("./generated/management-processes-protocol.cjs").responses.process(value))
    throw new Error("环境脚本运行状态无效");
  return value;
}
/** @param {unknown} value @returns {import('./generated/management-processes-protocol.cjs').ResponseMap['processOutput']} */
function readEnvironmentOutput(value) {
  if (!require("./generated/management-processes-protocol.cjs").responses.processOutput(value))
    throw new Error("环境脚本输出页无效");
  return value;
}

/** @param {unknown} value @returns {value is WorktreeState} */
function worktreeState(value) {
  return (
    typeof value === "string" &&
    [
      "creating",
      "created",
      "binding",
      "settingUp",
      "ready",
      "cancelled",
      "failed",
      "unknown",
    ].includes(value)
  );
}
