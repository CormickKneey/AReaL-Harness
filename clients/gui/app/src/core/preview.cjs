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
    page.control = 'human'; page.controlEpoch++;
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
    page.control = 'agent'; page.controlEpoch++;
    return { protocol: 'areal.browser.host.v1', operations: ['describe', 'observe'], available: true,
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
      const tree = await Promise.race([c.debugger.sendCommand('Accessibility.getFullAXTree'), cancelled]);
      if (page.control !== 'agent' || page.controlEpoch !== epoch || page.documentGeneration !== documentGeneration
        || this.pages.get(`${projectId}:${threadId}`) !== page || c.isDestroyed()) throw new Error('Browser observation was revoked');
      const lines = [], nodes = tree.nodes ?? [];
      let truncated = false;
      for (const node of nodes) {
        if (node.ignored) continue;
        const role = String(node.role?.value ?? '').slice(0, 80);
        const name = String(node.name?.value ?? '').slice(0, 500);
        const value = role === 'textField' || role === 'passwordField' ? '' : String(node.value?.value ?? '').slice(0, 500);
        const line = [role, name, value].filter(Boolean).join(': ');
        if (!line) continue;
        if (lines.length >= 160 || lines.join('\n').length + line.length > 16 * 1024) { truncated = true; break; }
        lines.push(line);
      }
      return { coreInstanceId, coreGeneration, projectId, threadId, turnId, callId, pageId,
        browserHostId, hostGeneration, pageGeneration, nativeWebContentsId: c.id,
        url: observationUrl(c.getURL()), title: c.getTitle().slice(0, 256), documentEpoch: documentGeneration,
        controlEpoch: epoch, capturedAt: new Date().toISOString(), scope: 'ax',
        frameCoverage: 'main-frame', truncated, text: lines.join('\n') };
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
      control: 'human', controlEpoch: 0, documentGeneration: 0 },
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
        page.url = url;
        page.error = "";
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
