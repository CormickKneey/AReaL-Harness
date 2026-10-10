"use strict";
const MAX_CACHED_PAGES = 8;
const MAX_WORKSPACE_PAGES = 4;
const workspaceKey = (coreInstanceId, projectId, threadId) => JSON.stringify([coreInstanceId, projectId, threadId]);
const pageKey = (coreInstanceId, projectId, threadId, pageId) => JSON.stringify([coreInstanceId, projectId, threadId, pageId]);
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { validatePreview } = require('@areal/workbench/desktop-contract');

function webUrl(value) {
  const text = String(value ?? "").trim();
  const explicit =
    /^[a-z][a-z\d+.-]*:/i.test(text) &&
    !/^(localhost|[\d.]+):\d+(\/|$)/i.test(text);
  const url = new URL(
    explicit
      ? text
      : `${/^(localhost|127\.|\[::1\])/.test(text) ? "http" : "https"}://${text}`,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("预览仅支持不含凭据的 HTTP(S) 地址");
  return url.href;
}
function observationUrl(value) {
  const url = new URL(value);
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href;
}
const sensitive = /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|\botp\b|credential/i;
const diagnosticSensitive = /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|bearer|cookie|session.?id|one.?time.?code|\botp\b|credential/i;
const BROWSER_READ_WORLD = 1001;
async function readIsolated(contents, code) {
  const result = await contents.executeJavaScriptInIsolatedWorld(BROWSER_READ_WORLD, [{ code }]);
  if (result === undefined) throw new Error('Browser isolated read failed');
  return result;
}
async function nativeWithin(promise, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error('等待原生输入结算超时，请停止或关闭页面');
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('等待原生输入结算超时，请停止或关闭页面')), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
const viewportScript = `({width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio})`;
const interactiveRoles = new Set(['button', 'link', 'textbox', 'textfield', 'searchbox', 'combobox',
  'checkbox', 'radiobutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
  'slider', 'spinbutton', 'option', 'listbox']);
const MAX_REFS = 1000;
const MAX_DIAGNOSTICS = 200;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const sensitiveCaptureScript = `(() => {
  const selector = 'input[type="password"],input[name*="token" i],input[name*="secret" i],input[name*="key" i]';
  const sensitiveAutocomplete = new Set(['current-password', 'new-password', 'cc-number', 'cc-csc', 'one-time-code']);
  const scan = root => {
    if (root.querySelector(selector)) return true;
    for (const input of root.querySelectorAll('input[autocomplete]')) {
      if (input.getAttribute('autocomplete').trim().toLowerCase().split(/\\s+/).some(token => sensitiveAutocomplete.has(token))) return true;
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot && scan(element.shadowRoot)) return true;
      if (!['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName)
        && [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|\\botp\\b|credential/i.test(child.textContent))) return true;
    }
    for (const frame of root.querySelectorAll('iframe,frame')) {
      try { if (!frame.contentDocument || scan(frame.contentDocument)) return true; }
      catch { return true; }
    }
    return false;
  };
  return scan(document);
})()`;
const captureGuardStartScript = (token, sequence) => `(() => {
  if ((globalThis.__arealCaptureGuardSequence ?? 0) >= ${sequence}) return false;
  globalThis.__arealCaptureGuardSequence = ${sequence};
  const previous = globalThis.__arealCaptureGuard;
  for (const observer of previous?.observers ?? []) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  const guard = { token: ${JSON.stringify(token)}, changed: false, observers: [] };
  const watch = root => {
    const observer = new MutationObserver(() => { guard.changed = true; });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    guard.observers.push(observer);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) watch(element.shadowRoot);
      if (element.matches('iframe,frame')) {
        if (!element.contentDocument) throw new Error('Frame unavailable');
        watch(element.contentDocument);
      }
    }
  };
  try { watch(document); globalThis.__arealCaptureGuard = guard; return true; }
  catch { for (const observer of guard.observers) observer.disconnect(); return false; }
})()`;
const captureGuardStopScript = (token, sequence) => `(() => {
  globalThis.__arealCaptureGuardSequence = Math.max(globalThis.__arealCaptureGuardSequence ?? 0, ${sequence});
  const guard = globalThis.__arealCaptureGuard;
  if (!guard || guard.token !== ${JSON.stringify(token)}) return true;
  const changed = guard.changed || guard.observers.some(observer => observer.takeRecords().length > 0);
  for (const observer of guard.observers) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  return changed;
})()`;
const clearCaptureGuardScript = `(() => {
  for (const observer of globalThis.__arealCaptureGuard?.observers ?? []) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  return true;
})()`;
function safeText(value, limit = 500) {
  const text = String(value ?? '').slice(0, limit);
  return sensitive.test(text) ? '[redacted]' : text;
}
function diagnosticText(value, limit = 500) {
  const text = String(value ?? '').slice(0, limit);
  if (diagnosticSensitive.test(text)) return '[redacted]';
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try { return observationUrl(raw); } catch { return '[redacted URL]'; }
  });
}
function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '[redacted URL]';
    return diagnosticText(observationUrl(url.href), 500);
  } catch { return '[redacted URL]'; }
}
function boundsWithinWindow(value, size) {
  if (
    !value ||
    ["x", "y", "width", "height"].some((key) => !Number.isFinite(value[key]))
  )
    throw new Error("无效预览区域");
  const x = Math.max(0, Math.round(value.x)),
    y = Math.max(0, Math.round(value.y));
  return {
    x: Math.min(x, size[0]),
    y: Math.min(y, size[1]),
    width: Math.max(0, Math.min(Math.round(value.width), size[0] - x)),
    height: Math.max(0, Math.min(Math.round(value.height), size[1] - y)),
  };
}
/** 网页没有 preload/Node/产品 IPC；任务拥有独立内容与导航历史。 */
class CorePreview {
  constructor(window, WebContentsView, owns, preferences = () => ({}), coreIdentity = () => null) {
    this.window = window;
    this.WebContentsView = WebContentsView;
    this.owns = owns;
    this.preferences = preferences;
    this.coreIdentity = coreIdentity;
    this.pages = new Map();
    this.selected = new Map();
    this.eventSequences = new Map();
    this.listeners = new Set();
    this.owner = null;
    this.view = null;
    this.browserHostId = randomUUID();
    this.hostGeneration = randomBytes(4).readUInt32BE(0);
  }
  workspacePages(projectId, threadId) {
    return [...this.pages.values()].filter(page => page.coreInstanceId === this.coreIdentity(projectId)
      && page.projectId === projectId && page.threadId === threadId);
  }
  page(projectId, threadId, id) {
    const selected = id ?? this.selected.get(workspaceKey(this.coreIdentity(projectId), projectId, threadId));
    return selected ? this.pages.get(pageKey(this.coreIdentity(projectId), projectId, threadId, selected)) : null;
  }
  pageStillOwned(page) {
    return this.pages.get(pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id)) === page
      && page.coreInstanceId === this.coreIdentity(page.projectId)
      && this.owns(page.projectId, page.threadId);
  }
  metadata(page) {
    const c = page.view?.webContents;
    return { coreInstanceId: page.coreInstanceId, pageId: page.id, openerId: page.openerId ?? null, origin: page.origin,
      resource: page.view ? page.crashed ? 'crashed' : 'ready' : 'suspended', control: page.control,
      stateLoss: page.stateLoss ?? null,
      url: c && !c.isDestroyed() ? c.getURL() || page.url : page.url,
      title: c && !c.isDestroyed() ? safeText(c.getTitle(), 256) : safeText(page.title, 256),
      pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch, viewportRevision: page.viewportRevision };
  }
  snapshot(projectId, threadId) {
    const key = workspaceKey(this.coreIdentity(projectId), projectId, threadId);
    return { sequence: this.eventSequences.get(key) ?? 0, workspaceId: key,
      selectedPageId: this.selected.get(key) ?? null,
      pages: this.workspacePages(projectId, threadId).map(page => this.metadata(page)) };
  }
  subscribe(projectId, threadId, listener) {
    const item = { key: workspaceKey(this.coreIdentity(projectId), projectId, threadId), listener };
    this.listeners.add(item);
    return { snapshot: this.snapshot(projectId, threadId), unsubscribe: () => this.listeners.delete(item) };
  }
  changed(page, type = 'pageChanged') {
    if (type !== 'pageRemoved' && !this.pageStillOwned(page)) return;
    const key = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    const sequence = (this.eventSequences.get(key) ?? 0) + 1;
    this.eventSequences.set(key, sequence);
    const event = { sequence, type, workspaceId: key,
      page: this.metadata(page) };
    for (const item of this.listeners) if (item.key === event.workspaceId) item.listener(event);
  }
  dispose() {
    for (const key of [...this.pages.keys()]) this.release(key);
    this.view = null; this.owner = null;
  }
  release(key, { preserveContext = false } = {}) {
    const page = this.pages.get(key);
    if (!page) return;
    this.revoke(page);
    this.pages.delete(key);
    this.closeNative(page);
    if (this.owner === key) { this.owner = null; this.view = null; }
    const workspace = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    if (this.selected.get(workspace) === page.id) {
      const next = this.workspacePages(page.projectId, page.threadId)[0];
      if (next) this.selected.set(workspace, next.id); else this.selected.delete(workspace);
    }
    this.changed(page, 'pageRemoved');
    if (!preserveContext && ![...this.pages.values()].some(other => other.partition === page.partition))
      this.releaseWorkspaceContext(page);
  }
  releaseWorkspaceContext(page) {
    void page.session?.clearStorageData().catch(() => {});
  }
  releaseInvalidOwners() {
    for (const [key, page] of this.pages) if (!this.owns(page.projectId, page.threadId)
      || page.coreInstanceId !== this.coreIdentity(page.projectId)) this.release(key);
  }
  closeNative(page) {
    if (!page.view) return;
    const c = page.view.webContents;
    for (const item of page.downloads ?? []) item.cancel();
    page.downloads?.clear();
    if (page.onDownload) c.session.removeListener('will-download', page.onDownload);
    page.diagnosticsReady = false; page.diagnosticRequests?.clear();
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(page.view);
    if (!c.isDestroyed()) c.close();
    page.view = null;
  }
  pinned(page) {
    return !page.view || page.crashed || page.control !== 'human' || page.requestedVisible
      || page.activeAction || page.activeRead || page.activePrepare || page.plans.size > 0
      || page.inputPending.size > 0 || page.heldButtons.size > 0 || page.heldKeys.size > 0
      || page.dialogPending || page.fileHandoff || (page.downloads?.size ?? 0) > 0;
  }
  suspend(page) {
    if (this.pinned(page)) throw new Error('页面正在使用，不能驱逐');
    const c = page.view.webContents;
    page.url = c.isDestroyed() ? page.url : c.getURL() || page.url;
    page.title = c.isDestroyed() ? page.title : c.getTitle() || page.title;
    page.refs.clear(); page.plans.clear(); page.lastObservation = null; page.needsObservation = true;
    page.stateLoss = '页面已驱逐；只恢复网址，表单和临时登录可能需要重做';
    this.closeNative(page);
    this.changed(page);
  }
  reservePageSlot(projectId, threadId, replacing = false, excluded = null) {
    this.releaseInvalidOwners();
    if (!replacing && this.workspacePages(projectId, threadId).length >= MAX_WORKSPACE_PAGES)
      throw new Error('当前浏览工作区已达4页，请先关闭页面');
    const native = [...this.pages.values()].filter(page => page.view && page !== excluded);
    if (native.length < MAX_CACHED_PAGES) return;
    const idle = native.find(page => !this.pinned(page));
    if (!idle) throw new Error('浏览页面已达8页且都在使用，请先关闭页面');
    this.suspend(idle);
  }
  workspaceOutstanding(projectId, threadId) {
    return this.workspacePages(projectId, threadId).reduce((count, page) => count + page.plans.size
      + Number(!!page.activeRead) + Number(!!page.activePrepare) + Number(!!page.activeAction), 0);
  }
  state(page = this.pages.get(this.owner)) {
    const contents = page?.view?.webContents;
    const c = contents && !contents.isDestroyed() ? contents : null;
    const state = {
      url: c?.getURL() || page?.url || '', title: c?.getTitle() ?? page?.title ?? '',
      loading: c?.isLoading() ?? false,
      canGoBack: c?.navigationHistory.canGoBack() ?? false,
      canGoForward: c?.navigationHistory.canGoForward() ?? false,
      error: page?.error ?? '',
      browser: page ? { pageId: page.id, control: page.control,
        transferError: page.transferError ?? null, resource: page.view ? page.crashed ? 'crashed' : 'ready' : 'suspended',
        stateLoss: page.stateLoss ?? null } : null,
    };
    return page ? { ...state, workspace: this.snapshot(page.projectId, page.threadId) } : state;
  }
  revoke(page) {
    if (page.control !== 'agent') return;
    // This local fence runs before any Core request and before awaiting native input.
    page.control = 'transferring'; page.controlEpoch++; page.refs.clear(); page.plans.clear();
    this.clearDiagnostics(page, 'control_changed');
    page.lastObservation = null; page.needsObservation = true;
    page.view?.setVisible(false);
    page.activeRead?.cancel();
    page.activeAction?.cancel();
    this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId, pageId: page.id });
    this.changed(page, 'controlChanged');
    void this.convergeInput(page);
  }
  dispatchInput(page, method, params) {
    const c = page.view.webContents;
    // Record the native call before awaiting its receipt. A lost receipt leaves
    // takeover transferring rather than pretending the held input was released.
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') page.heldButtons.set(params.button, { x: params.x, y: params.y });
    } else if (method === 'Input.dispatchKeyEvent') {
      if (params.type === 'keyDown') page.heldKeys.set(params.key, params);
    }
    const pending = c.debugger.sendCommand(method, params).then(value => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') page.heldButtons.delete(params.button);
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') page.heldKeys.delete(params.key);
      return value;
    });
    page.inputPending.add(pending);
    void pending.finally(() => page.inputPending.delete(pending)).catch(() => {});
    return pending;
  }
  async convergeInput(page) {
    if (page.converging) return page.converging;
    if (!this.pageStillOwned(page) || !page.view) return;
    const c = page.view.webContents;
    const epoch = page.controlEpoch;
    page.converging = (async () => {
      await Promise.resolve();
      try {
        const deadline = performance.now() + 2000;
        // Commands already submitted to CDP must settle before releases are sent.
        // The deadline bounds the first attempt; a late settlement retries safely.
        while (page.inputPending.size) {
          const pending = [...page.inputPending];
          await nativeWithin(Promise.allSettled(pending), deadline);
        }
        if (c.isDestroyed()) return;
        if (!c.debugger.isAttached() && (page.heldButtons.size || page.heldKeys.size))
          throw new Error('原生输入通道已断开，请关闭页面');
        const releases = [
          ...[...page.heldKeys.values()].map(key => ['Input.dispatchKeyEvent', { type: 'keyUp', key: key.key,
            code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode }]),
          ...[...page.heldButtons].map(([button, point]) => ['Input.dispatchMouseEvent',
            { type: 'mouseReleased', button, x: point.x, y: point.y, clickCount: 1 }]),
        ];
        for (const [method, params] of releases) await nativeWithin(this.dispatchInput(page, method, params), deadline);
        if (page.inputPending.size) await nativeWithin(Promise.allSettled([...page.inputPending]), deadline);
        if (page.heldButtons.size || page.heldKeys.size) throw new Error('原生输入释放未确认，请关闭页面');
        if (c.debugger.isAttached()) c.debugger.detach();
        if (page.control === 'transferring' && page.controlEpoch === epoch) {
          page.control = 'human'; page.transferError = null;
          page.view?.setVisible(this.pageStillOwned(page) && this.owner === pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id)
            && page.requestedVisible === true);
        }
      } catch (error) {
        page.transferError = error.message;
        // Keep the view hidden. A later native receipt may allow convergence.
        if (page.control === 'transferring' && page.controlEpoch === epoch && page.inputPending.size)
          void Promise.allSettled([...page.inputPending]).then(() => {
            page.converging = null;
            if (page.control === 'transferring' && page.controlEpoch === epoch) void this.convergeInput(page);
          });
      } finally { page.converging = null; }
    })();
    return page.converging;
  }
  revokeAll() { for (const page of this.pages.values()) this.revoke(page); }
  async claim(projectId, threadId, pageId) {
    const page = this.page(projectId, threadId, pageId);
    if (!page?.view || page.crashed || page.view.webContents.isDestroyed() || page.view.webContents.isDevToolsOpened()
      || !page.view.webContents.getURL()
      || !this.owns(projectId, threadId)) throw new Error('当前聊天没有可认领的页面');
    if (page.control === 'transferring') throw new Error('原生输入尚未收敛，请停止或关闭页面');
    // Any capture guard left by a revoked read observed only a private boolean;
    // discard it before re-enabling Agent observations.
    await readIsolated(page.view.webContents, clearCaptureGuardScript);
    if (page.control !== 'human' || !this.pageStillOwned(page)) throw new Error('页面控制状态已变化');
    page.control = 'agent'; page.controlEpoch++; page.refs.clear(); page.plans.clear();
    page.lastObservation = null; page.needsObservation = true;
    this.clearDiagnostics(page, 'new_control_epoch');
    try {
      const c = page.view.webContents;
      if (!c.debugger.isAttached()) c.debugger.attach('1.3');
      // Runtime.enable and Console.enable can replay earlier page messages.
      // Electron's live console-message event supplies Console evidence; CDP
      // Network starts only after this explicit enable receipt.
      await c.debugger.sendCommand('Network.enable', { maxPostDataSize: 0 });
      if (!this.pageStillOwned(page) || page.control !== 'agent' || c.isDestroyed()) throw new Error('Browser page changed');
      page.diagnosticsReady = true;
    } catch (error) { this.revoke(page); throw error; }
    this.changed(page, 'controlChanged');
    return { protocol: 'areal.browser.host.v1', operations: ['describe', 'observe', 'capture', 'act', 'wait', 'navigate', 'newPage', 'diagnostics'], available: true,
      coreInstanceId: page.coreInstanceId, projectId, threadId, pageId: page.id, browserHostId: this.browserHostId,
      hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch };
  }
  takeover(projectId, threadId, pageId) {
    const page = this.page(projectId, threadId, pageId);
    if (page) this.revoke(page);
    return this.state(page);
  }
  cancelRead({ projectId, threadId, pageId, requestId, hostGeneration }) {
    if (hostGeneration !== this.hostGeneration) return;
    const active = this.page(projectId, threadId, pageId)?.activeRead;
    if (active?.requestId === requestId) active.cancel();
    const action = this.page(projectId, threadId, pageId)?.activeAction;
    if (action?.requestId === requestId) action.cancel();
  }
  clearDiagnostics(page, reason) {
    page.diagnosticsReady = false;
    page.diagnosticRequests?.clear();
    page.diagnosticEvents = [];
    page.diagnosticBytes = 0;
    page.diagnosticLoss = { after: page.diagnosticSequence ?? 0, reason };
  }
  addDiagnostic(page, event) {
    if (!this.pageStillOwned(page) || page.control !== 'agent' || !page.diagnosticsReady) return;
    const record = { sequence: ++page.diagnosticSequence, at: new Date().toISOString(),
      pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch, ...event };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    page.diagnosticEvents.push({ record, bytes }); page.diagnosticBytes += bytes;
    while (page.diagnosticEvents.length > MAX_DIAGNOSTICS || page.diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
      const removed = page.diagnosticEvents.shift();
      page.diagnosticBytes -= removed.bytes;
      page.diagnosticLoss = { after: removed.record.sequence, reason: 'buffer_evicted' };
    }
    this.changed(page, 'diagnosticsAvailable');
  }
  async diagnostics(request) {
    const { page, c } = this.actionPage(request);
    if (!page.diagnosticsReady || !c.debugger.isAttached()) throw new Error('Browser diagnostics unavailable');
    const epoch = page.controlEpoch;
    const cursor = request.parameters.cursor ?? 0;
    const limit = request.parameters.limit ?? 50;
    const events = page.diagnosticEvents.filter(item => item.record.sequence > cursor
      && item.record.kind === request.parameters.kind).slice(0, limit).map(item => item.record);
    if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch)
      throw new Error('Browser observation was revoked');
    const first = page.diagnosticEvents[0]?.record.sequence ?? page.diagnosticSequence + 1;
    return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
      projectId: request.projectId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
      pageId: page.id, browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
      pageGeneration: page.pageGeneration, controlEpoch: epoch, kind: request.parameters.kind,
      events, cursor: events.at(-1)?.sequence ?? page.diagnosticSequence,
      loss: cursor < first - 1 || (page.diagnosticLoss?.reason === 'request_map_evicted' && cursor <= page.diagnosticLoss.after)
        ? { after: cursor, before: first, reason: page.diagnosticLoss?.reason ?? 'unavailable_interval' } : null,
      bounded: { entries: MAX_DIAGNOSTICS, bytes: MAX_DIAGNOSTIC_BYTES },
      coverage: 'live Electron Console and CDP Network metadata; no bodies or headers' };
  }
  actionPage(request) {
    const { projectId, threadId, pageId, browserHostId, hostGeneration, pageGeneration, controlEpoch } = request;
    const page = this.page(projectId, threadId, pageId);
    if (!page || page.id !== pageId || page.projectId !== projectId || page.threadId !== threadId
      || request.coreInstanceId !== page.coreInstanceId
      || browserHostId !== this.browserHostId || hostGeneration !== this.hostGeneration
      || pageGeneration !== page.pageGeneration || !this.owns(projectId, threadId)) throw new Error('plan_stale');
    if (page.control !== 'agent' || page.controlEpoch !== controlEpoch) throw new Error('plan_stale');
    const c = page.view?.webContents;
    if (!c) throw new Error('plan_stale');
    if (page.crashed || c.isDestroyed() || c.isDevToolsOpened()) throw new Error('plan_stale');
    return { page, c };
  }
  async actionTarget(page, c, ref) {
    const identity = [...page.refs].find(([, value]) => value === ref)?.[0];
    if (!identity) throw new Error('stale_ref');
    const [generation, documentEpoch, controlEpoch, frameId, backendNodeId] = JSON.parse(identity);
    if (generation !== page.pageGeneration || documentEpoch !== page.documentGeneration
      || controlEpoch !== page.controlEpoch || frameId !== 'main') throw new Error('stale_ref');
    const ax = await c.debugger.sendCommand('Accessibility.getPartialAXTree', { backendNodeId });
    const node = ax.nodes?.find(value => value.backendDOMNodeId === backendNodeId);
    if (!node || node.ignored || node.properties?.some(property => property.name === 'disabled' && property.value?.value === true))
      throw new Error('target_unavailable');
    const box = await c.debugger.sendCommand('DOM.getBoxModel', { backendNodeId });
    const quad = box.model?.content;
    if (!Array.isArray(quad) || quad.length !== 8) throw new Error('target_unavailable');
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    const viewport = await readIsolated(c, viewportScript);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
      throw new Error('target_unavailable');
    const hit = await c.debugger.sendCommand('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false });
    if (hit.backendNodeId !== backendNodeId) throw new Error('target_unavailable');
    return { identity, backendNodeId, x, y, viewport,
      role: safeText(node.role?.value, 80), name: safeText(node.name?.value, 256) };
  }
  async prepareNavigation(request) {
    const { page, c } = this.actionPage(request);
    if (page.activeRead || page.activePrepare || page.activeAction
      || this.workspaceOutstanding(page.projectId, page.threadId) >= 16)
      throw new Error('not_sent');
    const target = webUrl(request.parameters.url);
    const source = c.getURL();
    if (!source) throw new Error('plan_stale');
    const plan = { preparedActionId: randomUUID(), operation: request.operation, pageId: page.id,
      origin: new URL(source).origin, targetOrigin: new URL(target).origin,
      url: observationUrl(source), targetUrl: target,
      pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch, browserHostId: this.browserHostId,
      hostGeneration: this.hostGeneration, threadId: request.threadId, turnId: request.turnId,
      callId: request.callId, expiresAt: Date.now() + 300000 };
    plan.fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    page.plans.set(plan.preparedActionId, { plan, pageUrl: source });
    return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
      projectId: request.projectId, threadId: request.threadId, turnId: request.turnId,
      callId: request.callId, pageId: page.id, browserHostId: this.browserHostId,
      hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration,
      controlEpoch: page.controlEpoch, plan };
  }
  async executeNavigation(request) {
    const { page, c } = this.actionPage(request);
    const approved = request.browserApproval?.plan;
    const saved = approved && page.plans.get(approved.preparedActionId);
    const target = webUrl(request.parameters.url);
    if (!saved || !isDeepStrictEqual(saved.plan, approved)
      || approved.operation !== request.operation || approved.pageId !== page.id
      || approved.threadId !== request.threadId || approved.turnId !== request.turnId
      || approved.callId !== request.callId || approved.expiresAt < Date.now()
      || approved.targetUrl !== target || approved.origin !== new URL(c.getURL()).origin
      || saved.pageUrl !== c.getURL() || approved.pageGeneration !== page.pageGeneration
      || approved.documentEpoch !== page.documentGeneration || approved.controlEpoch !== page.controlEpoch)
      throw new Error('plan_stale');
    page.plans.delete(approved.preparedActionId);
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error('not_sent');
    let cancel;
    const stopped = new Promise((_, reject) => { cancel = () => reject(new Error('outcome_unknown')); });
    const action = { requestId: request.requestId, dispatched: false, cancelled: false,
      cancel() { this.cancelled = true; cancel(); } };
    page.activeAction = action;
    let child;
    const deadline = setTimeout(() => action.cancel(), 12000);
    try {
      if (request.operation === 'navigate') {
        page.approvedNavigation = target; page.url = target; page.error = '';
        action.dispatched = true;
        await Promise.race([c.loadURL(target), stopped]);
      } else {
        const id = randomUUID();
        child = this.create(pageKey(page.coreInstanceId, page.projectId, page.threadId, id), page.projectId, page.threadId,
          { id, openerId: page.id, origin: 'agent' });
        child.control = 'agent'; child.controlEpoch = page.controlEpoch;
        child.approvedNavigation = target; child.url = target;
        action.dispatched = true;
        await Promise.race([child.view.webContents.loadURL(target), stopped]);
      }
      if (action.cancelled || !this.pageStillOwned(page) || !this.owns(page.projectId, page.threadId)
        || page.controlEpoch !== approved.controlEpoch || (child && !this.pageStillOwned(child)))
        throw new Error('outcome_unknown');
      this.changed(child ?? page);
      return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        projectId: request.projectId, threadId: request.threadId, turnId: request.turnId,
        callId: request.callId, pageId: page.id, browserHostId: this.browserHostId,
        hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration,
        controlEpoch: page.controlEpoch, ...(child ? { createdPage: { pageId: child.id,
          pageGeneration: child.pageGeneration, controlEpoch: child.controlEpoch } } : {}),
        url: target, dispatch: 'confirmed' };
    } catch (error) {
      page.approvedNavigation = null;
      if (child) child.approvedNavigation = null;
      if (action.dispatched) throw new Error('outcome_unknown');
      throw error;
    } finally {
      clearTimeout(deadline);
      if (page.activeAction === action) page.activeAction = null;
    }
  }
  async prepare(request) {
    if (request.phase !== 'prepare' || !['act', 'wait', 'navigate', 'newPage'].includes(request.operation)) throw new Error('not_sent');
    if (['navigate', 'newPage'].includes(request.operation)) return this.prepareNavigation(request);
    const { page, c } = this.actionPage(request);
    const initialDocument = page.documentGeneration;
    for (const [id, record] of page.plans) if (record.plan.expiresAt < Date.now()) page.plans.delete(id);
    if (page.activeRead || page.activePrepare || page.activeAction
      || this.workspaceOutstanding(page.projectId, page.threadId) >= 16) throw new Error('not_sent');
    const url = new URL(c.getURL());
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!local) throw new Error('human_takeover_required'); // Unknown/external effects require human takeover.
    if (page.needsObservation || (request.operation === 'act' && request.parameters.snapshotId !== page.lastObservation)) throw new Error('stale_ref');
    let target = null;
    page.activePrepare = true;
    try {
      if (!c.debugger.isAttached()) c.debugger.attach('1.3');
      if (request.operation === 'act') target = await this.actionTarget(page, c, request.parameters.action.ref);
      if (request.parameters.action?.kind === 'fill'
        && !/^(textField|textbox|searchbox|comboBox|spinbutton)$/i.test(target.role))
        throw new Error('target_unavailable');
      const viewport = await readIsolated(c, viewportScript);
      const zoom = c.getZoomFactor();
      const viewportKey = JSON.stringify([viewport.width, viewport.height, viewport.scrollX, viewport.scrollY, zoom, viewport.deviceScaleFactor]);
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== request.controlEpoch
        || page.pageGeneration !== request.pageGeneration || page.documentGeneration !== initialDocument || c.isDestroyed()
        || c.getURL() !== url.href) throw new Error('plan_stale');
      if (page.viewportKey !== viewportKey) { page.viewportKey = viewportKey; page.viewportRevision++; }
      const plan = { preparedActionId: randomUUID(), operation: request.operation, pageId: page.id,
        origin: url.origin, url: observationUrl(url.href),
        snapshotId: request.operation === 'act' ? request.parameters.snapshotId : null,
        target: target ? { ref: request.parameters.action.ref,
          role: target.role, name: target.name, x: target.x, y: target.y } : null,
        action: request.operation === 'act' ? request.parameters.action : { kind: 'wait', timeoutMs: request.parameters.timeoutMs },
        pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
        controlEpoch: page.controlEpoch, viewportRevision: page.viewportRevision, viewportKey,
        browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
        threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        expiresAt: Date.now() + 300000 };
      plan.fingerprint = createHash('sha256').update(JSON.stringify({ plan, targetIdentity: target?.identity })).digest('hex');
      page.plans.set(plan.preparedActionId, { plan, targetIdentity: target?.identity, pageUrl: url.href });
      return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        projectId: request.projectId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        pageId: page.id, browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
        pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch, plan };
    } finally {
      page.activePrepare = false;
      if (c.debugger.isAttached() && !page.diagnosticsReady) c.debugger.detach();
    }
  }
  async execute(request) {
    if (request.phase !== 'execute' || !['act', 'wait', 'navigate', 'newPage'].includes(request.operation)) throw new Error('not_sent');
    if (['navigate', 'newPage'].includes(request.operation)) return this.executeNavigation(request);
    const { page, c } = this.actionPage(request);
    const approved = request.browserApproval?.plan;
    const saved = approved && page.plans.get(approved.preparedActionId);
    const nowViewport = await readIsolated(c, viewportScript);
    const nowKey = JSON.stringify([nowViewport.width, nowViewport.height, nowViewport.scrollX,
      nowViewport.scrollY, c.getZoomFactor(), nowViewport.deviceScaleFactor]);
    if (!saved || !isDeepStrictEqual(approved, saved.plan)
      || saved.plan.threadId !== request.threadId || saved.plan.turnId !== request.turnId
      || saved.plan.callId !== request.callId || saved.plan.operation !== request.operation
      || saved.plan.pageId !== request.pageId || saved.plan.expiresAt < Date.now()
      || saved.plan.origin !== new URL(c.getURL()).origin || saved.pageUrl !== c.getURL()
      || saved.plan.pageGeneration !== page.pageGeneration || saved.plan.documentEpoch !== page.documentGeneration
      || saved.plan.controlEpoch !== page.controlEpoch || saved.plan.viewportRevision !== page.viewportRevision
      || saved.plan.viewportKey !== nowKey
      || saved.plan.snapshotId !== (request.operation === 'act' ? request.parameters.snapshotId : null)
      || !isDeepStrictEqual(saved.plan.action, request.operation === 'act'
        ? request.parameters.action : { kind: 'wait', timeoutMs: request.parameters.timeoutMs })) throw new Error('plan_stale');
    page.plans.delete(approved.preparedActionId);
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error('not_sent');
    let cancelled;
    const stop = new Promise((_, reject) => { cancelled = reject; });
    const action = { requestId: request.requestId, syntheticInput: request.operation === 'act', dispatched: false, cancelled: false,
      cancel: () => { action.cancelled = true; cancelled(new Error(action.dispatched ? 'outcome_unknown' : 'not_sent')); } };
    page.activeAction = action;
    if (request.operation === 'act') {
      // A hidden View can retain keyboard focus. Move focus only if this page
      // owns the foreground window's native focus; never raise a background app.
      if (this.window.isFocused() && c.isFocused()) this.window.webContents.focus();
      page.view.setVisible(false);
    }
    const deadline = setTimeout(() => action.cancel(), Math.min(30000, request.operation === 'wait' ? request.parameters.timeoutMs + 1000 : 5000));
    try {
      if (request.operation === 'wait') {
        await Promise.race([new Promise(resolve => setTimeout(resolve, request.parameters.timeoutMs)), stop]);
      } else {
        if (!c.debugger.isAttached()) c.debugger.attach('1.3');
        let target = await Promise.race([this.actionTarget(page, c, request.parameters.action.ref), stop]);
        if (target.identity !== saved.targetIdentity || target.x !== saved.plan.target.x || target.y !== saved.plan.target.y
          || target.role !== saved.plan.target.role || target.name !== saved.plan.target.name)
          throw new Error('plan_stale');
        await Promise.race([new Promise(resolve => setTimeout(resolve, 50)), stop]);
        target = await Promise.race([this.actionTarget(page, c, request.parameters.action.ref), stop]);
        if (target.identity !== saved.targetIdentity || target.x !== saved.plan.target.x || target.y !== saved.plan.target.y
          || target.role !== saved.plan.target.role || target.name !== saved.plan.target.name
          || c.getURL() !== saved.pageUrl || page.controlEpoch !== saved.plan.controlEpoch)
          throw new Error('plan_stale');
        // If the native page still owns local keyboard focus, do not dispatch.
        // before-input-event cannot distinguish a physical key from CDP echo.
        if (this.window.isFocused() && c.isFocused()) throw new Error('not_sent');
        const live = () => {
          if (action.cancelled || !this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== saved.plan.controlEpoch
            || page.documentGeneration !== saved.plan.documentEpoch || c.isDestroyed()) throw new Error('outcome_unknown');
        };
        const input = params => { live(); action.dispatched = true; return this.dispatchInput(page, 'Input.dispatchMouseEvent', params); };
        const keyboard = params => { live(); action.dispatched = true; return this.dispatchInput(page, 'Input.dispatchKeyEvent', params); };
        const click = async () => {
          await input({ type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
          await input({ type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        };
        await Promise.race([(async () => {
          await click();
          if (request.parameters.action.kind === 'fill') {
            const modifier = process.platform === 'darwin' ? 8 : 2;
            await keyboard({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
            await keyboard({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
            live(); action.dispatched = true;
            await this.dispatchInput(page, 'Input.insertText', { text: request.parameters.action.value });
          } else if (request.parameters.action.kind === 'press') {
            const key = request.parameters.action.key;
            const code = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8,
              ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key];
            await keyboard({ type: 'keyDown', key, windowsVirtualKeyCode: code });
            await keyboard({ type: 'keyUp', key, windowsVirtualKeyCode: code });
          }
        })(), stop]);
      }
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== saved.plan.controlEpoch)
        throw new Error(action.dispatched ? 'outcome_unknown' : 'not_sent');
      return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        projectId: request.projectId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        pageId: page.id, browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
        pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch,
        dispatch: action.dispatched ? 'confirmed' : 'not_sent', inputConfirmed: action.dispatched,
        verification: 'not_checked',
        preparedActionId: saved.plan.preparedActionId };
    } catch (error) {
      if (action.dispatched) throw new Error('outcome_unknown');
      throw error;
    } finally {
      clearTimeout(deadline);
      if (page.activeAction === action) page.activeAction = null;
      if (page.control === 'agent' && page.inputPending.size === 0
        && page.heldButtons.size === 0 && page.heldKeys.size === 0) {
        if (!c.isDestroyed() && c.debugger.isAttached() && !page.diagnosticsReady) c.debugger.detach();
        page.view?.setVisible(this.pageStillOwned(page) && this.owner === pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id)
          && page.requestedVisible === true);
      } else if (page.control === 'agent') {
        // Even a failed action must release native input before local input resumes.
        page.control = 'transferring'; page.controlEpoch++;
        page.refs.clear(); page.plans.clear(); page.lastObservation = null; page.needsObservation = true;
        this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId, pageId: page.id });
        void this.convergeInput(page);
      }
    }
  }
  async observe(request) {
    const { projectId, threadId, pageId, browserHostId, hostGeneration, pageGeneration, controlEpoch,
      coreInstanceId, coreGeneration, turnId, callId } = request ?? {};
    const page = this.page(projectId, threadId, pageId);
    if (browserHostId !== this.browserHostId || hostGeneration !== this.hostGeneration || !page
      || coreInstanceId !== page.coreInstanceId
      || page.id !== pageId || page.pageGeneration !== pageGeneration || !this.owns(projectId, threadId))
      throw new Error('Browser page identity is stale');
    if (page.control !== 'agent' || page.controlEpoch !== controlEpoch) throw new Error('Human controls this page');
    const c = page.view?.webContents;
    if (!c) throw new Error('Browser page is unavailable');
    if (page.crashed || c.isDestroyed() || c.isDevToolsOpened()) throw new Error('Browser page is unavailable');
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error('Browser page is busy');
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new Error('Browser observation was revoked')); });
    const read = { requestId: request.requestId, cancel };
    page.activeRead = read;
    const epoch = page.controlEpoch, documentGeneration = page.documentGeneration;
    const timer = setTimeout(cancel, 10000);
    try {
      if (!c.debugger.isAttached()) c.debugger.attach('1.3');
      const operation = request.operation;
      if (operation !== 'observe' && operation !== 'capture') throw new Error('Unsupported browser operation');
      const parameters = request.parameters ?? {};
      const tree = operation === 'observe'
        ? await Promise.race([c.debugger.sendCommand('Accessibility.getFullAXTree'), cancelled]) : null;
      const frames = operation === 'observe'
        ? await Promise.race([c.debugger.sendCommand('Page.getFrameTree'), cancelled]) : null;
      const viewport = await Promise.race([readIsolated(c, viewportScript), cancelled]);
      if (![viewport.width, viewport.height, viewport.scrollX, viewport.scrollY, viewport.deviceScaleFactor]
        .every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0 || viewport.deviceScaleFactor <= 0)
        throw new Error('Browser viewport unavailable');
      const zoom = c.getZoomFactor();
      const viewportKey = JSON.stringify([viewport.width, viewport.height, viewport.scrollX, viewport.scrollY, zoom, viewport.deviceScaleFactor]);
      if (page.viewportKey !== viewportKey) { page.viewportKey = viewportKey; page.viewportRevision++; }
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch
        || page.documentGeneration !== documentGeneration || c.isDestroyed()) throw new Error('Browser observation was revoked');
      const base = { observationId: randomUUID(), coreInstanceId, coreGeneration, projectId, threadId, turnId, callId, pageId,
        browserHostId, hostGeneration, pageGeneration, nativeWebContentsId: c.id,
        url: observationUrl(c.getURL()), title: safeText(c.getTitle(), 256), documentEpoch: documentGeneration,
        controlEpoch: epoch, capturedAt: new Date().toISOString(), scope: operation === 'capture' ? 'viewport' : (parameters.scope ?? 'document'),
        viewport: { ...viewport, pageZoom: zoom, viewportRevision: page.viewportRevision } };
      if (operation === 'capture') {
        // A known sensitive form or a DOM change during capture cannot be safely represented unmasked.
        const guardToken = randomUUID();
        const guardSequence = page.nextGuardSequence = (page.nextGuardSequence ?? 0) + 1;
        let image, postSensitive, changed = true;
        try {
          const watching = await Promise.race([readIsolated(c, captureGuardStartScript(guardToken, guardSequence)), cancelled]);
          if (watching !== true) throw new Error('Browser capture guard unavailable');
          const hasSensitive = await Promise.race([readIsolated(c, sensitiveCaptureScript), cancelled]);
          if (typeof hasSensitive !== 'boolean') throw new Error('Browser sensitive-field check unavailable');
          if (hasSensitive) throw new Error('Sensitive field prevents automatic screenshot');
          image = await Promise.race([c.capturePage(), cancelled]);
          if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch
            || page.documentGeneration !== documentGeneration)
            throw new Error('Browser observation was revoked');
          postSensitive = await Promise.race([readIsolated(c, sensitiveCaptureScript), cancelled]);
        } finally {
          if (page.control === 'agent' && page.controlEpoch === epoch) changed = await Promise.race([
            readIsolated(c, captureGuardStopScript(guardToken, guardSequence)).catch(() => true),
            new Promise(resolve => setTimeout(() => resolve(true), 1000)),
          ]);
        }
        if (postSensitive !== false || changed !== false) throw new Error('Browser content changed during capture');
        const currentViewport = await Promise.race([readIsolated(c, viewportScript), cancelled]);
        if (JSON.stringify(currentViewport) !== JSON.stringify(viewport) || c.getZoomFactor() !== zoom)
          throw new Error('Browser viewport changed during capture');
        const size = image.getSize();
        if (size.width * size.height > 8_000_000 || size.width > 4096 || size.height > 4096) throw new Error('Screenshot pixel budget exceeded');
        const png = image.toPNG();
        if (png.length > 2 * 1024 * 1024) throw new Error('Screenshot byte budget exceeded');
        if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch)
          throw new Error('Browser observation was revoked');
        page.lastObservation = base.observationId;
        page.needsObservation = false;
        return { ...base, capturedAt: new Date().toISOString(), viewport: { ...base.viewport, bitmapWidth: size.width, bitmapHeight: size.height }, mimeType: 'image/png', imageBase64: png.toString('base64'), byteLength: png.length };
      }
      const lines = [], entries = [], nodes = tree.nodes ?? [];
      const liveIdentities = new Set(nodes.filter(node => node.backendDOMNodeId).map(node =>
        JSON.stringify([page.pageGeneration, documentGeneration, epoch, node.frameId ?? 'main', node.backendDOMNodeId])));
      const requestedIdentity = parameters.rootRef && [...page.refs].find(([, ref]) => ref === parameters.rootRef)?.[0];
      if (parameters.rootRef && !requestedIdentity) throw new Error('stale_ref');
      const requestedBackend = requestedIdentity && JSON.parse(requestedIdentity)[4];
      const rootNode = requestedBackend && nodes.find(node => node.backendDOMNodeId === requestedBackend);
      if (parameters.rootRef && !rootNode) throw new Error('stale_ref');
      const parent = new Map(nodes.map(node => [node.nodeId, node.parentId]));
      const descendant = node => { for (let id = node.nodeId; id; id = parent.get(id)) if (id === rootNode?.nodeId) return true; return false; };
      const sensitiveNodes = new Set(nodes.filter(node => /passwordField/i.test(String(node.role?.value ?? ''))
        || sensitive.test(String(node.name?.value ?? ''))
        || (/textField|textbox|searchbox|comboBox/i.test(String(node.role?.value ?? ''))
          && (node.properties ?? []).some(property => sensitive.test(String(property.name)) || sensitive.test(String(property.value?.value)))))
        .map(node => node.nodeId));
      const fieldNodes = new Set(nodes.filter(node => /^(textField|passwordField|textbox|searchbox|comboBox)$/i
        .test(String(node.role?.value ?? ''))).map(node => node.nodeId));
      const fieldValues = [...new Set(nodes.filter(node => fieldNodes.has(node.nodeId))
        .map(node => String(node.value?.value ?? '')).filter(Boolean))];
      const fieldEcho = text => fieldValues.some(value => text === value || (value.length >= 3 && text.includes(value)));
      const sensitiveChild = node => { for (let id = node.parentId; id; id = parent.get(id)) if (sensitiveNodes.has(id)) return true; return false; };
      const fieldChild = node => { for (let id = node.parentId; id; id = parent.get(id)) if (fieldNodes.has(id)) return true; return false; };
      const limitNodes = parameters.budget?.nodes ?? 200;
      const limitBytes = parameters.budget?.textBytes ?? 32 * 1024;
      const nextRefs = new Map();
      const entryByNodeId = new Map();
      let textBytes = 0, truncated = false;
      for (const node of nodes) {
        if (node.ignored) continue;
        const role = String(node.role?.value ?? '').slice(0, 80);
        const rawName = String(node.name?.value ?? '');
        const propertySensitive = (node.properties ?? []).some(property => sensitive.test(String(property.name)) || sensitive.test(String(property.value?.value)));
        const sensitiveNode = sensitiveNodes.has(node.nodeId) || sensitiveChild(node) || propertySensitive;
        const concealed = sensitiveNode || fieldChild(node) || fieldEcho(rawName);
        const name = concealed ? '[redacted]' : safeText(rawName);
        const value = concealed || /textField|passwordField|textbox|searchbox|comboBox/i.test(role)
          || sensitive.test(rawName) || propertySensitive || fieldEcho(String(node.value?.value ?? ''))
          ? '' : safeText(node.value?.value);
        const identity = node.backendDOMNodeId && JSON.stringify([page.pageGeneration, documentGeneration, epoch, node.frameId ?? 'main', node.backendDOMNodeId]);
        const interactive = interactiveRoles.has(role.toLowerCase()) && !concealed
          && (!fieldNodes.has(node.nodeId) || name.trim().length > 0);
        let ref;
        if (identity && interactive) {
          ref = page.refs.get(identity) ?? `r${++page.nextRef}`;
        }
        if (rootNode && !descendant(node)) continue;
        const line = [ref, role, name, value].filter(Boolean).join(': ');
        if (!line) continue;
        let ancestor = node.parentId;
        while (ancestor && !entryByNodeId.has(ancestor)) ancestor = parent.get(ancestor);
        const entry = { id: `n${entries.length + 1}`, role, name,
          ...(ancestor ? { parent: entryByNodeId.get(ancestor) } : {}),
          ...(node.frameId ? { frameId: node.frameId } : {}),
          ...(ref ? { ref } : {}),
          ...(value ? { value } : {}),
          ...(node.description?.value ? { description: concealed
            ? '[redacted]' : safeText(node.description.value) } : {}),
          state: Object.fromEntries((node.properties ?? [])
            .filter(property => ['checked', 'selected', 'disabled', 'expanded', 'required', 'invalid'].includes(property.name))
            .map(property => [property.name, safeText(property.value?.value, 80)])) };
        const bytes = Buffer.byteLength(line, 'utf8') + Buffer.byteLength(JSON.stringify(entry), 'utf8');
        if (lines.length >= limitNodes || textBytes + bytes > limitBytes) { truncated = true; break; }
        lines.push(line);
        if (ref) nextRefs.set(identity, ref);
        entries.push(entry);
        entryByNodeId.set(node.nodeId, entry.id);
        textBytes += bytes;
      }
      const retainedRefs = new Map([...page.refs].filter(([identity]) => liveIdentities.has(identity)));
      for (const [identity, ref] of nextRefs) {
        retainedRefs.delete(identity);
        retainedRefs.set(identity, ref);
      }
      let refsEvicted = 0;
      while (retainedRefs.size > MAX_REFS) {
        retainedRefs.delete(retainedRefs.keys().next().value);
        refsEvicted++;
      }
      page.refs = retainedRefs;
      const seenFrames = new Set(nodes.map(node => node.frameId).filter(Boolean));
      const childFrames = [];
      const walkFrames = (branch, root = false) => {
        if (!root) childFrames.push({ frameId: branch.frame.id, url: branch.frame.url ? observationUrl(branch.frame.url) : '',
          coverage: seenFrames.has(branch.frame.id) ? 'covered' : 'unavailable' });
        for (const child of branch.childFrames ?? []) walkFrames(child);
      };
      walkFrames(frames.frameTree, true);
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch)
        throw new Error('Browser observation was revoked');
      page.lastObservation = base.observationId;
      page.needsObservation = false;
      return { ...base, frameCoverage: { main: 'covered', childFrames },
        shadowCoverage: 'not-distinguished-by-accessibility-tree', dynamicCoverage: 'snapshot-at-capturedAt',
        truncated, truncationReason: truncated ? 'budget' : null,
        refCache: { capacity: MAX_REFS, evicted: refsEvicted },
        budget: { nodes: limitNodes, textBytes: limitBytes }, nodes: entries, text: lines.join('\n') };
    } finally {
      clearTimeout(timer);
      if (page.activeRead === read) {
        page.activeRead = null;
        try { if (!c.isDestroyed() && c.debugger.isAttached() && !page.diagnosticsReady) c.debugger.detach(); }
        catch { /* A detached/crashed target already revoked this read. */ }
      }
    }
  }
  create(owner, projectId, threadId, options = {}) {
    this.reservePageSlot(projectId, threadId, options.replacing === true);
    const siblings = this.workspacePages(projectId, threadId);
    const partition = options.partition ?? siblings[0]?.partition ?? `areal-preview-${randomUUID()}`;
    const view = new this.WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
      },
    });
    const page = { id: options.id ?? randomUUID(), pageGeneration: options.pageGeneration ?? 1, view, partition,
      session: view.webContents.session, coreInstanceId: this.coreIdentity(projectId), projectId, threadId,
      openerId: options.openerId ?? null, origin: options.origin ?? 'human', title: '', error: '', url: '', crashed: false,
      control: 'human', controlEpoch: 0, documentGeneration: 0, viewportRevision: 0, refs: new Map(),
      plans: new Map(), lastObservation: null, needsObservation: true, nextRef: 0,
      heldButtons: new Map(), heldKeys: new Map(), inputPending: new Set(), requestedVisible: false,
      downloads: new Set(), dialogPending: false, fileHandoff: false, stateLoss: options.stateLoss ?? null,
      diagnosticsReady: false, diagnosticEvents: [], diagnosticRequests: new Map(), diagnosticBytes: 0,
      diagnosticSequence: 0, diagnosticLoss: null },
      c = view.webContents;
    c.on('console-message', (_event, details) => {
      if (page.control !== 'agent' || !page.diagnosticsReady) return;
      const value = details && typeof details === 'object' ? details : {};
      this.addDiagnostic(page, { kind: 'console', level: ['error', 'warning', 'info', 'debug'].includes(value.level) ? value.level : 'log',
        message: diagnosticText(value.message), source: diagnosticUrl(value.sourceId),
        line: Number.isSafeInteger(value.lineNumber) ? value.lineNumber : null });
    });
    c.debugger.on('message', (_event, method, params) => {
      if (!page.diagnosticsReady || page.control !== 'agent' || !this.pageStillOwned(page)) return;
      if (method === 'Network.requestWillBeSent') {
        if (typeof params?.requestId !== 'string') return;
        const previous = page.diagnosticRequests.get(params.requestId);
        if (previous && previous.controlEpoch === page.controlEpoch && params.redirectResponse) {
          this.addDiagnostic(page, { kind: 'network', url: previous.url, method: previous.method,
            status: Number.isSafeInteger(params.redirectResponse.status) ? params.redirectResponse.status : null,
            resourceType: previous.resourceType ?? null, failure: null,
            documentEpoch: previous.documentEpoch });
        }
        const request = params.request ?? {};
        page.diagnosticRequests.set(params.requestId, { url: diagnosticUrl(request.url),
          method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request.method) ? request.method : 'OTHER',
          documentEpoch: page.documentGeneration, controlEpoch: page.controlEpoch });
        while (page.diagnosticRequests.size > MAX_DIAGNOSTICS) {
          page.diagnosticRequests.delete(page.diagnosticRequests.keys().next().value);
          page.diagnosticLoss = { after: page.diagnosticSequence, reason: 'request_map_evicted' };
        }
      } else if (method === 'Network.responseReceived') {
        const request = page.diagnosticRequests.get(params?.requestId);
        if (!request || request.controlEpoch !== page.controlEpoch) return;
        request.status = Number.isSafeInteger(params.response?.status) ? params.response.status : null;
        request.resourceType = diagnosticText(params.type, 40);
      } else if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
        const request = page.diagnosticRequests.get(params?.requestId);
        if (!request) return;
        page.diagnosticRequests.delete(params.requestId);
        if (request.controlEpoch !== page.controlEpoch) return;
        this.addDiagnostic(page, { kind: 'network', url: request.url, method: request.method,
          status: request.status ?? null, resourceType: request.resourceType ?? null,
          failure: method === 'Network.loadingFailed' ? diagnosticText(params.errorText, 120) : null,
          documentEpoch: request.documentEpoch });
      }
    });
    c.debugger.on('detach', () => {
      this.clearDiagnostics(page, 'debugger_detached');
      if (page.control === 'agent') this.revoke(page);
    });
    c.on('devtools-opened', () => this.revoke(page));
    c.on('devtools-closed', () => {
      if (!this.pageStillOwned(page)) return;
      page.pageGeneration++; page.documentGeneration++; page.refs.clear(); page.plans.clear();
      page.needsObservation = true; this.clearDiagnostics(page, 'devtools_closed'); this.changed(page);
    });
    page.onDownload = (event, item, source) => {
      if (source !== c) return;
      if (!this.pageStillOwned(page)) { event.preventDefault(); return; }
      if (!page.fileHandoff || page.downloads.size >= 4) {
        event.preventDefault();
        page.error = '下载需要明确的文件交接；未保存文件';
        this.changed(page);
        return;
      }
      page.downloads.add(item);
      item.once('done', () => { page.downloads.delete(item); this.changed(page); });
      this.changed(page);
    };
    c.session.on('will-download', page.onDownload);
    c.setWindowOpenHandler(details => {
      // Electron must never create an unowned BrowserWindow. A local human click
      // may create a sibling only after URL and current ownership checks.
      if (page.control !== 'human' || !this.pageStillOwned(page) || !this.owns(projectId, threadId)
        || page.coreInstanceId !== this.coreIdentity(projectId)
        || Date.now() > (page.userPopupIntentUntil ?? 0))
        return { action: 'deny' };
      page.userPopupIntentUntil = 0;
      let url;
      try { url = webUrl(details.url); } catch { return { action: 'deny' }; }
      if (!['foreground-tab', 'background-tab', 'new-window'].includes(details.disposition))
        return { action: 'deny' };
      const id = randomUUID();
      let child;
      try { child = this.create(pageKey(page.coreInstanceId, projectId, threadId, id), projectId, threadId,
        { id, openerId: page.id, origin: c.isFocused() ? 'human' : 'unknown' }); }
      catch (error) { page.error = error.message; this.changed(page); return { action: 'deny' }; }
      if (c.isFocused() && details.disposition !== 'background-tab')
        this.selected.set(workspaceKey(page.coreInstanceId, projectId, threadId), child.id);
      child.url = url;
      void child.view.webContents.loadURL(url).catch(error => {
        if (this.pageStillOwned(child) && error.code !== 'ERR_ABORTED') child.error = error.message;
      });
      this.changed(child);
      return { action: 'deny' };
    });
    c.session.setPermissionRequestHandler((_contents, _permission, respond) =>
      respond(false),
    );
    c.session.setPermissionCheckHandler(() => false);
    const navigate = (event, url) => {
      try {
        webUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    c.on("will-navigate", navigate);
    c.on("will-redirect", navigate);
    c.on("will-frame-navigate", (event) => {
      try {
        webUrl(event.url);
      } catch {
        event.preventDefault();
      }
    });
    c.on("did-start-navigation", (_event, url, _inPlace, main) => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = false;
      if (main) {
        if (page.approvedNavigation === url) page.approvedNavigation = null;
        else this.revoke(page);
        page.documentGeneration++;
        page.refs.clear();
        page.url = url;
        page.error = "";
      } else {
        page.documentGeneration++;
        page.refs.clear();
        page.activeRead?.cancel();
      }
      if (this.pageStillOwned(page)) this.changed(page);
    });
    c.on("did-fail-load", (_event, code, message, url, main) => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = false;
      if (main && code !== -3 && url === page.url) page.error = message;
      if (this.pageStillOwned(page)) this.changed(page);
    });
    c.on('did-finish-load', () => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = false;
      this.changed(page);
    });
    c.on('will-prevent-unload', () => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = true;
      this.changed(page);
    });
    c.on('page-title-updated', () => { if (this.pageStillOwned(page)) this.changed(page); });
    c.on('render-process-gone', () => {
      if (this.pages.get(owner) !== page) return;
      page.title = c.isDestroyed() ? page.title : c.getTitle() || page.title;
      this.revoke(page);
      page.crashed = true;
      page.error = '预览页面已退出，请重新加载';
      this.changed(page);
    });
    c.on('before-input-event', (event, input) => {
      if (!this.pageStillOwned(page)) { event.preventDefault(); return; }
      if (page.control === 'human' && c.isFocused() && input.type === 'keyDown'
        && ['Enter', 'Space'].includes(input.key)) page.userPopupIntentUntil = Date.now() + 1000;
      // CDP keys may echo while the native view is hidden. Only an action on a
      // page without native focus may pass here; a focused page is local input.
      if (page.control === 'agent' && (!page.activeAction?.syntheticInput || page.view.getVisible()
        || (this.window.isFocused() && c.isFocused()))) {
        event.preventDefault(); this.revoke(page);
      } else if (page.control === 'transferring') event.preventDefault();
    });
    c.on('before-mouse-event', (event, mouse) => {
      if (!this.pageStillOwned(page)) { event.preventDefault(); return; }
      if (page.control === 'human' && mouse.type === 'mouseDown' && c.isFocused())
        page.userPopupIntentUntil = Date.now() + 1000;
      if (page.control === 'agent' && page.view.getVisible() && mouse.type === 'mouseDown') {
        event.preventDefault(); this.revoke(page);
      } else if (page.control === 'transferring') event.preventDefault();
    });
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.pages.set(owner, page);
    const workspace = workspaceKey(this.coreIdentity(projectId), projectId, threadId);
    if (!this.selected.has(workspace)) this.selected.set(workspace, page.id);
    this.changed(page, 'pageAdded');
    return page;
  }
  async command(request) {
    validatePreview(request);
    const workspace = workspaceKey(this.coreIdentity(request.projectId), request.projectId, request.threadId);
    let page = this.page(request.projectId, request.threadId, request.pageId);
    let key = page && pageKey(page.coreInstanceId, request.projectId, request.threadId, page.id);
    if (!page && request.operation === 'state') {
      page = this.page(request.projectId, request.threadId);
      key = page && pageKey(page.coreInstanceId, request.projectId, request.threadId, page.id);
    }
    if (request.pageId && !page && request.operation !== 'state') throw new Error('页面已关闭');
    if (request.operation === 'subscribe') return this.snapshot(request.projectId, request.threadId);
    // A read must not touch LRU order or publish another metadata event.
    if (request.operation === 'state') return page ? this.state(page)
      : { ...this.state(null), workspace: this.snapshot(request.projectId, request.threadId) };
    if (request.operation === 'release') {
      if (!page) return this.state(null);
      if (page.origin !== 'agent' && request.userIntent !== true) throw new Error('关闭人工页面需要明确用户操作');
      this.release(key); return this.state(this.page(request.projectId, request.threadId));
    }
    if (request.operation === 'hide') {
      if (page) page.requestedVisible = false;
      if (!request.projectId || this.owner === key) {
        if (!page) { const displayed = this.pages.get(this.owner); if (displayed) displayed.requestedVisible = false; }
        this.view?.setVisible(false);
      }
      return this.state(page);
    }
    if (request.operation !== 'state' && (!this.owns(request.projectId, request.threadId)
      || !this.coreIdentity(request.projectId)))
      throw new Error('请选择已连接 Core 的有效任务');
    if (request.operation === 'openLink') {
      const url = webUrl(request.url), host = new URL(url).hostname;
      const local = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
      const settings = this.preferences();
      const destination = local ? settings.browserLocalTarget ?? 'internal' : settings.browserLinkTarget ?? 'external';
      if (destination === 'external') await require('electron').shell.openExternal(url);
      return { destination, url };
    }
    if (request.operation === 'newPage') {
      const id = randomUUID();
      const child = this.create(pageKey(this.coreIdentity(request.projectId), request.projectId, request.threadId, id), request.projectId, request.threadId,
        { id, openerId: page?.id ?? null, origin: 'human' });
      this.selected.set(workspace, child.id);
      this.changed(child);
      return this.state(child);
    }
    const target = request.operation === 'navigate' ? webUrl(request.url) : null;
    const restoreUrl = page?.url || request.url;
    if (page && (!page.view || page.crashed || page.view.webContents.isDestroyed())
      && ['show', 'navigate', 'reload'].includes(request.operation)) {
      const previous = page;
      this.reservePageSlot(request.projectId, request.threadId, true, previous);
      const wasSelected = this.selected.get(workspace) === previous.id;
      const saved = { id: previous.id, pageGeneration: previous.pageGeneration + 1,
        partition: previous.partition, openerId: previous.openerId, origin: previous.origin,
        stateLoss: previous.stateLoss ?? (previous.crashed ? '页面崩溃；只恢复网址，表单和临时登录可能需要重做' : null),
        replacing: true };
      this.release(key, { preserveContext: true });
      page = this.create(key, request.projectId, request.threadId, saved);
      page.title = previous.title;
      page.url = previous.url;
      page.error = previous.error;
      if (wasSelected) this.selected.set(workspace, page.id);
    }
    if (!page && ['show', 'navigate', 'reload'].includes(request.operation)) {
      const id = randomUUID();
      key = pageKey(this.coreIdentity(request.projectId), request.projectId, request.threadId, id);
      page = this.create(key, request.projectId, request.threadId, { id });
    }
    if (page && ['show', 'navigate', 'reload'].includes(request.operation) && !page.view.webContents.getURL()) {
      const restored = request.operation !== 'navigate' && restoreUrl ? webUrl(restoreUrl) : null;
      if (restored) {
        page.url = restored;
        void page.view.webContents.loadURL(restored).catch(error => {
          if (this.pageStillOwned(page) && error.code !== 'ERR_ABORTED') page.error = error.message;
        });
      }
    }
    if (!page) return { ...this.state(null), workspace: this.snapshot(request.projectId, request.threadId) };
    if (!page.view) {
      if (request.operation === 'selectPage') {
        this.selected.set(workspace, page.id);
        this.changed(page);
      }
      return this.state(page);
    }
    this.pages.delete(key); this.pages.set(key, page);
    const c = page.view.webContents;
    if (['navigate', 'back', 'forward', 'reload', 'stop'].includes(request.operation)) this.revoke(page);
    if (page.control === 'transferring' && !['state', 'show', 'hide', 'stop', 'release', 'selectPage'].includes(request.operation))
      throw new Error('原生输入尚未收敛，请停止或关闭页面');
    if (request.bounds) page.view.setBounds(boundsWithinWindow(request.bounds, this.window.getContentSize()));
    switch (request.operation) {
      case 'selectPage':
        this.selected.set(workspace, page.id);
        this.changed(page);
        break;
      case 'show':
        if (this.owner !== key) {
          const outgoing = this.pages.get(this.owner);
          if (outgoing) outgoing.requestedVisible = false;
          this.view?.setVisible(false);
        }
        this.owner = key; this.view = page.view;
        page.requestedVisible = request.visible !== false;
        page.view.setVisible(page.requestedVisible && page.control !== 'transferring' && !page.activeAction);
        break;
      case 'navigate':
        page.url = target; page.error = '';
        void c.loadURL(target).catch(error => {
          if (this.pageStillOwned(page) && error.code !== 'ERR_ABORTED' && page.url === target) page.error = error.message;
        });
        break;
      case 'back': if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack(); break;
      case 'forward': if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward(); break;
      case 'reload':
        page.error = '';
        if (c.getURL()) c.reload();
        else if (page.url) void c.loadURL(page.url).catch(error => {
          if (this.pageStillOwned(page) && error.code !== 'ERR_ABORTED') page.error = error.message;
        });
        break;
      case 'stop': c.stop(); break;
      case 'external': await require('electron').shell.openExternal(webUrl(c.getURL() || page.url)); break;
      case 'devtools':
        this.revoke(page);
        await this.convergeInput(page);
        if (page.control !== 'human') throw new Error('原生输入尚未收敛，请停止或关闭页面');
        c.openDevTools({ mode: 'detach' });
        break;
    }
    if (['navigate', 'reload', 'stop'].includes(request.operation)) this.changed(page);
    return this.state(page);
  }

}
module.exports = { CorePreview, webUrl, boundsWithinWindow };
