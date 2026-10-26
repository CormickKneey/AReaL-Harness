// @ts-check
"use strict";

/** @param {string|null} coreInstanceId @param {string} projectId @param {string} threadId */
const workspaceKey = (coreInstanceId, projectId, threadId) =>
  JSON.stringify([coreInstanceId, projectId, threadId]);
/** @param {string|null} coreInstanceId @param {string} projectId @param {string} threadId @param {string} pageId */
const pageKey = (coreInstanceId, projectId, threadId, pageId) =>
  JSON.stringify([coreInstanceId, projectId, threadId, pageId]);
module.exports = { workspaceKey, pageKey };
