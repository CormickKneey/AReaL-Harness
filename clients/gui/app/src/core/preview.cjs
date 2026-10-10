"use strict";
const MAX_CACHED_PAGES = 8;
const { randomUUID, randomBytes, createHash } = require('node:crypto');
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
const BROWSER_READ_WORLD = 1001;
async function readIsolated(contents, code) {
  const result = await contents.executeJavaScriptInIsolatedWorld(BROWSER_READ_WORLD, [{ code }]);
  if (result === undefined) throw new Error('Browser isolated read failed');
  return result;
}
const viewportScript = `({width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio})`;
const interactiveRoles = new Set(['button', 'link', 'textbox', 'textfield', 'searchbox', 'combobox',
  'checkbox', 'radiobutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
  'slider', 'spinbutton', 'option', 'listbox']);
const MAX_REFS = 1000;
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
function safeText(value, limit = 500) {
  const text = String(value ?? '').slice(0, limit);
  return sensitive.test(text) ? '[redacted]' : text;
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
  constructor(window, WebContentsView, owns, preferences = () => ({})) {
    this.window = window;
    this.WebContentsView = WebContentsView;
    this.owns = owns;
    this.preferences = preferences;
    this.pages = new Map();
    this.owner = null;
    this.view = null;
    this.browserHostId = randomUUID();
    this.hostGeneration = randomBytes(4).readUInt32BE(0);
  }
  dispose() {
    for (const owner of [...this.pages.keys()]) this.release(owner);
    this.view = null;
    this.owner = null;
  }
  release(owner) {
    const page = this.pages.get(owner);
    if (!page) return;
    this.revoke(page);
    // 先撤销归属，close/loadURL 的迟到回调不能写入新页面。
    this.pages.delete(owner);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
    if (this.owner === owner) { this.owner = null; this.view = null; }
  }
  releaseInvalidOwners() {
    for (const [owner, page] of this.pages) if (!this.owns(page.projectId, page.threadId)) this.release(owner);
  }
  prune() {
    for (const owner of this.pages.keys()) {
      if (this.pages.size <= MAX_CACHED_PAGES) break;
      if (owner !== this.owner) this.release(owner);
    }
  }
  state(page = this.pages.get(this.owner)) {
    const contents = page?.view.webContents;
    const c = contents && !contents.isDestroyed() ? contents : null;
    return {
      url: c?.getURL() || page?.url || "",
      title: c?.getTitle() ?? "",
      loading: c?.isLoading() ?? false,
      canGoBack: c?.navigationHistory.canGoBack() ?? false,
      canGoForward: c?.navigationHistory.canGoForward() ?? false,
      error: page?.error ?? "",
      browser: page ? { pageId: page.id, control: page.control } : null,
    };
  }
  revoke(page) {
    if (page.control !== 'agent') return;
    page.control = 'human'; page.controlEpoch++; page.refs.clear(); page.plans.clear();
    page.activeRead?.cancel();
    page.activeAction?.cancel();
    if (page.view.webContents.debugger.isAttached()) page.view.webContents.debugger.detach();
    this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId });
  }
  revokeAll() { for (const page of this.pages.values()) this.revoke(page); }
  claim(projectId, threadId) {
    const owner = `${projectId}:${threadId}`;
    const page = this.pages.get(owner);
    if (!page || page.crashed || page.view.webContents.isDestroyed() || !page.view.webContents.getURL()
      || !this.owns(projectId, threadId)) throw new Error('当前聊天没有可认领的页面');
    this.revokeAll();
    page.control = 'agent'; page.controlEpoch++; page.refs.clear(); page.plans.clear();
    return { protocol: 'areal.browser.host.v1', operations: ['describe', 'observe', 'capture', 'act', 'wait'], available: true,
      projectId, threadId, pageId: page.id, browserHostId: this.browserHostId,
      hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch };
  }
  takeover(projectId, threadId) {
    const page = this.pages.get(`${projectId}:${threadId}`);
    if (page) this.revoke(page);
    return this.state(page);
  }
  cancelRead({ projectId, threadId, requestId, hostGeneration }) {
    if (hostGeneration !== this.hostGeneration) return;
    const active = this.pages.get(`${projectId}:${threadId}`)?.activeRead;
    if (active?.requestId === requestId) active.cancel();
    const action = this.pages.get(`${projectId}:${threadId}`)?.activeAction;
    if (action?.requestId === requestId) action.cancel();
  }
  actionPage(request) {
    const { projectId, threadId, pageId, browserHostId, hostGeneration, pageGeneration, controlEpoch } = request;
    const page = this.pages.get(`${projectId}:${threadId}`);
    if (!page || page.id !== pageId || page.projectId !== projectId || page.threadId !== threadId
      || browserHostId !== this.browserHostId || hostGeneration !== this.hostGeneration
      || pageGeneration !== page.pageGeneration || !this.owns(projectId, threadId)) throw new Error('plan_stale');
    if (page.control !== 'agent' || page.controlEpoch !== controlEpoch) throw new Error('plan_stale');
    const c = page.view.webContents;
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
  async prepare(request) {
    if (request.phase !== 'prepare' || !['act', 'wait'].includes(request.operation)) throw new Error('not_sent');
    const { page, c } = this.actionPage(request);
    const initialDocument = page.documentGeneration;
    for (const [id, record] of page.plans) if (record.plan.expiresAt < Date.now()) page.plans.delete(id);
    if (page.activeRead || page.activePrepare || page.activeAction || page.plans.size >= 16) throw new Error('not_sent');
    const url = new URL(c.getURL());
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!local) throw new Error('human_takeover_required'); // Unknown/external effects require human takeover.
    if (request.operation === 'act' && request.parameters.snapshotId !== page.lastObservation) throw new Error('stale_ref');
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
      if (page.control !== 'agent' || page.controlEpoch !== request.controlEpoch
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
      if (c.debugger.isAttached()) c.debugger.detach();
    }
  }
  async execute(request) {
    if (request.phase !== 'execute' || !['act', 'wait'].includes(request.operation)) throw new Error('not_sent');
    const { page, c } = this.actionPage(request);
    const approved = request.browserApproval?.plan;
    const saved = approved && page.plans.get(approved.preparedActionId);
    const nowViewport = await readIsolated(c, viewportScript);
    const nowKey = JSON.stringify([nowViewport.width, nowViewport.height, nowViewport.scrollX,
      nowViewport.scrollY, c.getZoomFactor(), nowViewport.deviceScaleFactor]);
    if (!saved || JSON.stringify(approved) !== JSON.stringify(saved.plan)
      || saved.plan.threadId !== request.threadId || saved.plan.turnId !== request.turnId
      || saved.plan.callId !== request.callId || saved.plan.operation !== request.operation
      || saved.plan.pageId !== request.pageId || saved.plan.expiresAt < Date.now()
      || saved.plan.origin !== new URL(c.getURL()).origin || saved.pageUrl !== c.getURL()
      || saved.plan.pageGeneration !== page.pageGeneration || saved.plan.documentEpoch !== page.documentGeneration
      || saved.plan.controlEpoch !== page.controlEpoch || saved.plan.viewportRevision !== page.viewportRevision
      || saved.plan.viewportKey !== nowKey
      || saved.plan.snapshotId !== (request.operation === 'act' ? request.parameters.snapshotId : null)
      || JSON.stringify(saved.plan.action) !== JSON.stringify(request.operation === 'act'
        ? request.parameters.action : { kind: 'wait', timeoutMs: request.parameters.timeoutMs })) throw new Error('plan_stale');
    page.plans.delete(approved.preparedActionId);
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error('not_sent');
    let cancelled;
    const stop = new Promise((_, reject) => { cancelled = reject; });
    const action = { requestId: request.requestId, dispatched: false, cancelled: false,
      cancel: () => { action.cancelled = true; cancelled(new Error(action.dispatched ? 'outcome_unknown' : 'not_sent')); } };
    page.activeAction = action;
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
        const live = () => {
          if (action.cancelled || page.control !== 'agent' || page.controlEpoch !== saved.plan.controlEpoch
            || page.documentGeneration !== saved.plan.documentEpoch || c.isDestroyed()) throw new Error('outcome_unknown');
        };
        const input = params => { live(); action.dispatched = true; return c.debugger.sendCommand('Input.dispatchMouseEvent', params); };
        const keyboard = params => { live(); return c.debugger.sendCommand('Input.dispatchKeyEvent', params); };
        const click = async () => {
          await input({ type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
          await input({ type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        };
        page.agentInput = true;
        await Promise.race([(async () => {
          await click();
          if (request.parameters.action.kind === 'fill') {
            const modifier = process.platform === 'darwin' ? 8 : 2;
            await keyboard({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
            await keyboard({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
            live(); await c.debugger.sendCommand('Input.insertText', { text: request.parameters.action.value });
          } else if (request.parameters.action.kind === 'press') {
            const key = request.parameters.action.key;
            const code = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8,
              ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key];
            await keyboard({ type: 'keyDown', key, windowsVirtualKeyCode: code });
            await keyboard({ type: 'keyUp', key, windowsVirtualKeyCode: code });
          }
        })(), stop]);
      }
      if (page.control !== 'agent' || page.controlEpoch !== saved.plan.controlEpoch)
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
      page.agentInput = false;
      if (!c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
    }
  }
  async observe(request) {
    const { projectId, threadId, pageId, browserHostId, hostGeneration, pageGeneration, controlEpoch,
      coreInstanceId, coreGeneration, turnId, callId } = request ?? {};
    const page = this.pages.get(`${projectId}:${threadId}`);
    if (browserHostId !== this.browserHostId || hostGeneration !== this.hostGeneration || !page
      || page.id !== pageId || page.pageGeneration !== pageGeneration || !this.owns(projectId, threadId))
      throw new Error('Browser page identity is stale');
    if (page.control !== 'agent' || page.controlEpoch !== controlEpoch) throw new Error('Human controls this page');
    const c = page.view.webContents;
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
      if (page.control !== 'agent' || page.controlEpoch !== epoch || page.documentGeneration !== documentGeneration
        || this.pages.get(`${projectId}:${threadId}`) !== page || c.isDestroyed()) throw new Error('Browser observation was revoked');
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
          if (page.control !== 'agent' || page.controlEpoch !== epoch || page.documentGeneration !== documentGeneration)
            throw new Error('Browser observation was revoked');
          postSensitive = await Promise.race([readIsolated(c, sensitiveCaptureScript), cancelled]);
        } finally {
          changed = await Promise.race([
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
      page.lastObservation = base.observationId;
      return { ...base, frameCoverage: { main: 'covered', childFrames },
        shadowCoverage: 'not-distinguished-by-accessibility-tree', dynamicCoverage: 'snapshot-at-capturedAt',
        truncated, truncationReason: truncated ? 'budget' : null,
        refCache: { capacity: MAX_REFS, evicted: refsEvicted },
        budget: { nodes: limitNodes, textBytes: limitBytes }, nodes: entries, text: lines.join('\n') };
    } finally {
      clearTimeout(timer);
      if (page.activeRead === read) {
        page.activeRead = null;
        try { if (!c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach(); }
        catch { /* A detached/crashed target already revoked this read. */ }
      }
    }
  }
  create(owner, projectId, threadId) {
    const view = new this.WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: `areal-preview-${crypto.randomUUID()}`,
      },
    });
    const page = { id: randomUUID(), pageGeneration: 1, view, projectId, threadId, error: "", url: "", crashed: false,
      control: 'human', controlEpoch: 0, documentGeneration: 0, viewportRevision: 0, refs: new Map(),
      plans: new Map(), lastObservation: null, nextRef: 0 },
      c = view.webContents;
    c.setWindowOpenHandler(() => ({ action: "deny" }));
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
      if (main) {
        this.revoke(page);
        page.documentGeneration++;
        page.refs.clear();
        page.url = url;
        page.error = "";
      } else {
        page.documentGeneration++;
        page.refs.clear();
        page.activeRead?.cancel();
      }
    });
    c.on("did-fail-load", (_event, code, message, url, main) => {
      if (main && code !== -3 && url === page.url) page.error = message;
    });
    c.on('render-process-gone', () => {
      if (this.pages.get(owner) !== page) return;
      this.revoke(page);
      page.crashed = true;
      page.error = '预览页面已退出，请重新加载';
    });
    c.on('before-input-event', () => { if (!page.agentInput) this.revoke(page); });
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.pages.set(owner, page);
    return page;
  }
  async command(request) {
    validatePreview(request);
    const owner = `${request.projectId}:${request.threadId ?? ""}`;
    if (request.operation === 'release') { this.release(owner); return this.state(null); }
    if (request.operation === "hide") {
      if (!request.projectId || this.owner === owner)
        this.view?.setVisible(false);
      return this.state(this.pages.get(owner));
    }
    if (!this.owns(request.projectId, request.threadId))
      throw new Error("请选择有效任务");
    if (request.operation === "openLink") {
      const url = webUrl(request.url), host = new URL(url).hostname;
      const local = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
      const settings = this.preferences();
      const destination = local ? settings.browserLocalTarget ?? 'internal' : settings.browserLinkTarget ?? 'external';
      if (destination === 'external') await require('electron').shell.openExternal(url);
      // Renderer may have switched tasks while awaiting native handoff. It
      // chooses whether to reveal an internal page; this read creates none.
      return { destination, url };
    }
    const target =
      request.operation === "navigate" ? webUrl(request.url) : null;
    let page = this.pages.get(owner);
    const restoreUrl = page?.url || request.url;
    if (page && (page.crashed || page.view.webContents.isDestroyed()) && ['show', 'navigate', 'reload'].includes(request.operation)) {
      this.release(owner); page = null;
    }
    if (!page && ["show", "navigate", "reload"].includes(request.operation)) {
      const restored = request.operation !== 'navigate' && restoreUrl ? webUrl(restoreUrl) : null;
      page = this.create(owner, request.projectId, request.threadId);
      if (restored) {
        page.url = restored;
        const created = page;
        void page.view.webContents.loadURL(page.url).catch(error => {
          if (this.pages.get(owner) === created && error.code !== 'ERR_ABORTED') created.error = error.message;
        });
      }
    }
    if (!page) return this.state(null);
    this.pages.delete(owner); this.pages.set(owner, page);
    const c = page.view.webContents;
    if (['navigate', 'back', 'forward', 'reload', 'stop'].includes(request.operation)) this.revoke(page);
    if (request.bounds)
      page.view.setBounds(
        boundsWithinWindow(request.bounds, this.window.getContentSize()),
      );
    switch (request.operation) {
      case "show":
        if (this.owner !== owner) this.view?.setVisible(false);
        this.owner = owner;
        this.view = page.view;
        page.view.setVisible(request.visible !== false);
        break;
      case "navigate": {
        page.url = target;
        page.error = "";
        // Loading is observed through state; navigation completion cannot switch task ownership.
        void c.loadURL(target).catch((error) => {
          if (this.pages.get(owner) === page && error.code !== "ERR_ABORTED" && page.url === target)
            page.error = error.message;
        });
        break;
      }
      case "back":
        if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack();
        break;
      case "forward":
        if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward();
        break;
      case "reload":
        page.error = "";
        if (c.getURL()) c.reload();
        else if (page.url)
          void c.loadURL(page.url).catch((error) => {
            if (this.pages.get(owner) === page && error.code !== "ERR_ABORTED") page.error = error.message;
          });
        break;
      case "stop":
        c.stop();
        break;
      case "external":
        await require("electron").shell.openExternal(
          webUrl(c.getURL() || page.url),
        );
        break;
      case "devtools":
        this.revoke(page);
        c.openDevTools({ mode: "detach" });
        break;
    }
    this.prune();
    return this.state(page);
  }
}
module.exports = { CorePreview, webUrl, boundsWithinWindow };
