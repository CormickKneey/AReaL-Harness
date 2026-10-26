// @ts-check
"use strict";
const { safeText } = require("../preview/diagnostics.cjs");
const { workspaceKey, pageKey } = require("./identity.cjs");
const { randomUUID, randomBytes } = require("node:crypto");
const { sharedBrowserProfile } = require("../shared-browser-profile.cjs");
const MAX_FILE_RECEIPTS = 8;

class PreviewWorkspace {
  /**
   * @param {import("./model.js").Ownership} owns
   * @param {import("./model.js").CoreIdentity} coreIdentity
   * @param {import("./model.js").Ownership} retainsOwner
   * @param {() => string[]} controlEndpoints
   * @param {() => Promise<void>} quiesce
   */
  constructor(owns, coreIdentity, retainsOwner, controlEndpoints, quiesce) {
    this.owns = owns;
    this.coreIdentity = coreIdentity;
    this.retainsOwner = retainsOwner;
    this.profile = sharedBrowserProfile;
    this.profileHost = { controlEndpoints, quiesce };
    /** @type {(()=>boolean)|null} */
    this.unregisterProfileHost = this.profile.registerHost(this.profileHost);
    /** @type {Map<string, import("./model.js").Page>} */
    this.pages = new Map();
    /** @type {Map<string, {commandName:string|null}>} */
    this.contexts = new Map();
    /** @type {Map<string,string>} */
    this.selected = new Map();
    /** @type {Map<string,number>} */
    this.eventSequences = new Map();
    /** @type {Set<{key:string,listener:(event:{sequence:number,type:string,workspaceId:string,page:ReturnType<PreviewWorkspace['metadata']>})=>void}>} */
    this.listeners = new Set();
    /** @type {Map<string,import("./model.js").FileReceipt[]>} */
    this.fileReceipts = new Map();
    this.browserHostId = randomUUID();
    this.hostGeneration = randomBytes(4).readUInt32BE(0);
  }
  /**
   * @param {string} projectId
   * @param {string} threadId
   */
  workspacePages(projectId, threadId) {
    return [...this.pages.values()].filter(
      (page) =>
        page.coreInstanceId === this.coreIdentity(projectId, threadId) &&
        page.projectId === projectId &&
        page.threadId === threadId,
    );
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string} [id]
   */
  page(projectId, threadId, id) {
    const selected =
      id ??
      this.selected.get(workspaceKey(this.coreIdentity(projectId, threadId), projectId, threadId));
    return selected
      ? this.pages.get(
          pageKey(this.coreIdentity(projectId, threadId), projectId, threadId, selected),
        )
      : null;
  }

  /**
   * @param {import('./model.js').Page|null|undefined} page
   * @returns {page is import('./model.js').Page}
   */
  pageStillOwned(page) {
    return (
      !!page &&
      this.pages.get(pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id)) ===
        page &&
      page.coreInstanceId === this.coreIdentity(page.projectId, page.threadId) &&
      this.owns(page.projectId, page.threadId)
    );
  }

  /**
   * @param {import('./model.js').Page} page
   */
  metadata(page) {
    const c = page.view?.webContents;
    return {
      coreInstanceId: page.coreInstanceId,
      pageId: page.id,
      openerId: page.openerId ?? null,
      origin: page.origin,
      resource: page.view ? (page.crashed ? "crashed" : "ready") : "suspended",
      control: page.control,
      stateLoss: page.stateLoss ?? null,
      url: c && !c.isDestroyed() ? c.getURL() || page.url : page.url,
      title: c && !c.isDestroyed() ? safeText(c.getTitle(), 256) : safeText(page.title, 256),
      pageGeneration: page.pageGeneration,
      documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch,
      viewportRevision: page.viewportRevision,
      operation: page.batchProgress ?? null,
    };
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   */
  snapshot(projectId, threadId) {
    const key = workspaceKey(this.coreIdentity(projectId, threadId), projectId, threadId);
    return {
      sequence: this.eventSequences.get(key) ?? 0,
      workspaceId: key,
      selectedPageId: this.selected.get(key) ?? null,
      pages: this.workspacePages(projectId, threadId).map((page) => this.metadata(page)),
      fileReceipts: this.fileReceipts.get(key) ?? [],
    };
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {(event: {sequence:number,type:string,workspaceId:string,page:ReturnType<PreviewWorkspace['metadata']>})=>void} listener
   */
  subscribe(projectId, threadId, listener) {
    const item = {
      key: workspaceKey(this.coreIdentity(projectId, threadId), projectId, threadId),
      listener,
    };
    this.listeners.add(item);
    return {
      snapshot: this.snapshot(projectId, threadId),
      unsubscribe: () => this.listeners.delete(item),
    };
  }

  /**
   * @param {import('./model.js').Page} page
   */
  changed(page, type = "pageChanged") {
    if (type !== "pageRemoved" && !this.pageStillOwned(page)) return;
    const key = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    const sequence = (this.eventSequences.get(key) ?? 0) + 1;
    this.eventSequences.set(key, sequence);
    const event = { sequence, type, workspaceId: key, page: this.metadata(page) };
    for (const item of this.listeners) if (item.key === event.workspaceId) item.listener(event);
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').FileReceipt} record
   */
  fileReceipt(page, record) {
    const key = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    const entries = this.fileReceipts.get(key) ?? [];
    const index = entries.findIndex((value) => value.id === record.id);
    if (index >= 0) entries.splice(index, 1);
    const { timer: _timer, ...publicRecord } = record;
    entries.push(publicRecord);
    while (entries.length > MAX_FILE_RECEIPTS) entries.shift();
    this.fileReceipts.delete(key);
    this.fileReceipts.set(key, entries);
    while (this.fileReceipts.size > 32)
      this.fileReceipts.delete(this.fileReceipts.keys().next().value ?? "");
    this.changed(page);
  }

  /**
   * @param {import('./model.js').Page} page
   */
  releaseWorkspaceContext(page) {
    this.contexts.delete(workspaceKey(page.coreInstanceId, page.projectId, page.threadId));
  }

  /**
   * @param {import('./model.js').Page} page
   */
  ensureWorkspaceContext(page) {
    const key = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    if (page.session !== this.profile.session) throw new Error("浏览共享 Profile 归属不匹配");
    if (!this.contexts.has(key)) this.contexts.set(key, { commandName: null });
    return this.profile.policy;
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   */
  workspaceOutstanding(projectId, threadId) {
    return this.workspacePages(projectId, threadId).reduce(
      (count, page) =>
        count +
        page.plans.size +
        Number(!!page.activeRead) +
        Number(!!page.activePrepare) +
        Number(!!page.activeAction),
      0,
    );
  }

  /**
   * @param {import('./model.js').HostIdentity} request
   */
  actionPage(request) {
    this.profile.assertAvailable();
    const {
      projectId,
      threadId,
      pageId,
      browserHostId,
      hostGeneration,
      pageGeneration,
      controlEpoch,
    } = request;
    const page = this.page(projectId, threadId, pageId);
    if (
      !page ||
      page.id !== pageId ||
      page.projectId !== projectId ||
      page.threadId !== threadId ||
      request.coreInstanceId !== page.coreInstanceId ||
      browserHostId !== this.browserHostId ||
      hostGeneration !== this.hostGeneration ||
      pageGeneration !== page.pageGeneration ||
      !this.owns(projectId, threadId)
    )
      throw new Error("plan_stale");
    if (page.control !== "agent" || page.controlEpoch !== controlEpoch)
      throw new Error("plan_stale");
    const c = page.view?.webContents;
    if (!c || !hasNativePage(page)) throw new Error("plan_stale");
    if (page.crashed || c.isDestroyed() || c.isDevToolsOpened()) throw new Error("plan_stale");
    return { page, c };
  }
}

/** @param {import("./model.js").Page|null|undefined} page @returns {page is import("./model.js").LivePage} */
function hasNativePage(page) {
  return !!page?.view;
}
module.exports = { PreviewWorkspace, hasNativePage };
