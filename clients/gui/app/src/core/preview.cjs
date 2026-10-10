"use strict";
const MAX_CACHED_PAGES = 8;
const { randomUUID, randomBytes } = require('node:crypto');
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
const sensitiveCaptureScript = `(() => {
  const selector = 'input[type="password"],input[autocomplete="cc-number"],input[autocomplete="one-time-code"],input[name*="token" i],input[name*="secret" i],input[name*="key" i]';
  const scan = root => {
    if (root.querySelector(selector)) return true;
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
    page.control = 'human'; page.controlEpoch++; page.refs.clear();
    page.activeRead?.cancel();
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
    page.control = 'agent'; page.controlEpoch++; page.refs.clear();
    return { protocol: 'areal.browser.host.v1', operations: ['describe', 'observe', 'capture'], available: true,
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
    if (page.activeRead) throw new Error('Browser page is busy');
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
      const viewport = await Promise.race([c.executeJavaScript(`({width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio})`, true), cancelled]);
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
        // A known sensitive form cannot be safely represented in an unmasked image.
        const hasSensitive = await Promise.race([c.executeJavaScript(sensitiveCaptureScript, true), cancelled]);
        if (hasSensitive) throw new Error('Sensitive field prevents automatic screenshot');
        const image = await Promise.race([c.capturePage(), cancelled]);
        if (page.control !== 'agent' || page.controlEpoch !== epoch || page.documentGeneration !== documentGeneration) throw new Error('Browser observation was revoked');
        const currentViewport = await Promise.race([c.executeJavaScript(`({width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio})`, true), cancelled]);
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
      const sensitiveChild = node => { for (let id = node.parentId; id; id = parent.get(id)) if (sensitiveNodes.has(id)) return true; return false; };
      const limitNodes = parameters.budget?.nodes ?? 200;
      const limitBytes = parameters.budget?.textBytes ?? 32 * 1024;
      const nextRefs = new Map();
      const entryByNodeId = new Map();
      let textBytes = 0, truncated = false;
      for (const node of nodes) {
        if (node.ignored) continue;
        const role = String(node.role?.value ?? '').slice(0, 80);
        const rawName = String(node.name?.value ?? '');
        const name = sensitiveNodes.has(node.nodeId) || sensitiveChild(node) ? '[redacted]' : safeText(rawName);
        const propertySensitive = (node.properties ?? []).some(property => sensitive.test(String(property.name)) || sensitive.test(String(property.value?.value)));
        const value = sensitiveChild(node) || /textField|passwordField|textbox|searchbox|comboBox/i.test(role)
          || sensitive.test(rawName) || propertySensitive ? '' : safeText(node.value?.value);
        const identity = node.backendDOMNodeId && JSON.stringify([page.pageGeneration, documentGeneration, epoch, node.frameId ?? 'main', node.backendDOMNodeId]);
        const interactive = /button|link|textField|checkBox|radioButton|comboBox|menuItem|tab|switch/i.test(role);
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
          ...(node.description?.value ? { description: sensitiveNodes.has(node.nodeId) || sensitiveChild(node)
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
      page.refs = new Map([...page.refs].filter(([identity]) => liveIdentities.has(identity)).concat([...nextRefs]));
      const seenFrames = new Set(nodes.map(node => node.frameId).filter(Boolean));
      const childFrames = [];
      const walkFrames = (branch, root = false) => {
        if (!root) childFrames.push({ frameId: branch.frame.id, url: branch.frame.url ? observationUrl(branch.frame.url) : '',
          coverage: seenFrames.has(branch.frame.id) ? 'covered' : 'unavailable' });
        for (const child of branch.childFrames ?? []) walkFrames(child);
      };
      walkFrames(frames.frameTree, true);
      return { ...base, frameCoverage: { main: 'covered', childFrames },
        shadowCoverage: 'not-distinguished-by-accessibility-tree', dynamicCoverage: 'snapshot-at-capturedAt',
        truncated, truncationReason: truncated ? 'budget' : null,
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
      control: 'human', controlEpoch: 0, documentGeneration: 0, viewportRevision: 0, refs: new Map(), nextRef: 0 },
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
    c.on('before-input-event', () => this.revoke(page));
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
