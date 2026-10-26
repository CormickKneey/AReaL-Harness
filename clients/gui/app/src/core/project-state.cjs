// @ts-check
"use strict";
const {
  isPendingSubmission,
  isSubmissionParams,
  isSubmissionOutcomes,
  isOperationRef,
  isRemoteAssociation,
} = require("../../../packages/workbench/client/desktop-contract/shared.cjs");

/** @typedef {{id?:string,projectId?:string,threadId?:string,connectionGeneration?:number,code:unknown,reason?:unknown,message:string,retryable:boolean,refreshPending?:boolean,recovery?:import('@areal/runtime-client/core').Recovery}} ObservationError */
/** @typedef {{id:string,projectId:string,connectionGeneration?:number,operation?:import('@areal/runtime-client/core').OperationRef,scope?:string,message:string,refreshPending:boolean}} RefreshError */
/** @typedef {{client:import('@areal/runtime-client/core').CoreClient|null|undefined,generation?:number,id:string,promise:Promise<void>}} ObservationRead */
/** @typedef {PendingSubmission & {operationId:string,remote:RemoteAssociation}} RemotePending */
/** @typedef {(PendingSubmission|SubmissionOutcome) & {method:string,operationId:string,remote:RemoteAssociation}} RemoteRecord */
/** @typedef {{client:import('@areal/runtime-client/core').CoreClient,generation?:number,deadline:number,attempt:number,running:boolean,timer?:NodeJS.Timeout|null}} Reconciliation */
/** The mutable Desktop projection; durable execution facts stay in Core. */
/** @typedef {import("../../../packages/workbench/client/desktop-contract/shared.cjs").SubmissionParams} SubmissionParams */
/** @typedef {import("../../../packages/workbench/client/desktop-contract/shared.cjs").RemoteAssociation} RemoteAssociation */
/** @typedef {import("../../../packages/workbench/client/desktop-contract/shared.cjs").PendingSubmission} PendingSubmission */
/** @typedef {import("../../../packages/workbench/client/desktop-contract/shared.cjs").SubmissionOutcome} SubmissionOutcome */
/** @typedef {import('./project-index.cjs').SavedProject & {
 * model:import('@areal/workbench/core-model').CoreTaskModel,
 * pending:PendingSubmission[],pendingWrite?:Promise<unknown>,outcomeWrite?:Promise<void>,reconciliation?:Reconciliation|null,reconciliationRead?:{client:import('@areal/runtime-client/core').CoreClient|null|undefined,generation?:number,promise:Promise<void>}|null,outcomes:Record<string,SubmissionOutcome>,
 * configurations:Record<string,import("./thread-configuration.cjs").Configuration|undefined>,configurationChanges:Map<string,string>,taskDraftWrites?:Map<string,Promise<unknown>>,taskCreateWrites?:Map<string,Promise<unknown>>,taskViewWrite?:Promise<unknown>,
 * models?:import('./provider-contract.cjs').ModelCatalogEntry[],profiles?:unknown,resourceProfile?:import('@areal/workbench/desktop-contract').ResourceRef,resourceFingerprint?:string,providerRevision?:string|null,providerSnapshot?:import('./provider-contract.cjs').ModelSnapshot,summariesLoaded?:boolean,
 * providerProof?:import('./provider-contract.cjs').ConfigurationProof,providerError?:string|null,providerFailure?:{revision:string,serviceId?:string,generation?:string,message:string},
 * observationErrors?:Record<string,ObservationError>,refreshErrors?:Record<string,RefreshError>,
 * observationReads?:Map<string,ObservationRead>,summaryReads?:Promise<void|import('@areal/workbench/core-model-contract').CoreThread[]>,
 * taskNotificationMonitor?:InstanceType<typeof import('./notifications.cjs').TaskNotificationMonitor>,taskViews?:Map<string,string>,
 * error:string|null,summaries:import('../../../packages/workbench/client/core-model-contract.js').CoreThread[],
 * service?:(import('./local-service.cjs').RecoveryTarget & {endpoint?:string,owner?:unknown,hostPid?:unknown,corePid?:unknown})|null,resourceInitializing?:boolean,endpoint?:string|null,token?:string,connectionGeneration?:number,
 * reconnectTimer?:NodeJS.Timeout|null,reconnectBlocked?:boolean,reconnectAttempt?:number,
 * crashCheck?:{generation:string,started:number},crashAttempts?:number[],crashRecovery?:{original:import('./local-service.cjs').RecoveryTarget,calls:number},journalLoaded?:boolean,client?:import('@areal/runtime-client/core').CoreClient|null,hookRevision?:string|null
 * }} CoreProject */

/** @param {import('./project-index.cjs').SavedProject} saved @param {import('@areal/workbench/core-model').CoreTaskModel} model @returns {CoreProject} */
function createProjectState(saved, model) {
  return {
    ...saved,
    model,
    pending: [],
    outcomes: {},
    configurations: {},
    configurationChanges: new Map(),
    error: null,
    summaries: [],
  };
}

/** @param {unknown} value @returns {PendingSubmission[]} */
function parsePendingSubmissions(value) {
  if (!Array.isArray(value) || !value.every(isPendingSubmission))
    throw new Error("Invalid pending submission journal");
  return value;
}
/** @param {unknown} value @returns {Record<string,SubmissionOutcome>} */
function parseSubmissionOutcomes(value) {
  if (!isSubmissionOutcomes(value)) throw new Error("Invalid submission outcome journal");
  return value;
}
/** @param {PendingSubmission|SubmissionOutcome} value @returns {value is RemoteRecord} */
function isRemoteRecord(value) {
  return (
    typeof value.method === "string" &&
    typeof value.operationId === "string" &&
    value.remote !== undefined
  );
}

module.exports = {
  createProjectState,
  parsePendingSubmissions,
  parseSubmissionOutcomes,
  isSubmissionParams,
  isOperationRef,
  isRemoteAssociation,
  isPendingSubmission,
  isRemoteRecord,
};
