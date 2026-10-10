'use strict';
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const { WebSocketServer } = require('ws');
const { validateCommand: validateDesktopCommand, desktopError } = require('@areal/workbench/desktop-contract');
const { inspectResources, recoverResource, summary, blocked } = require('./resource-recovery.cjs');
const { validToolInput, failure: browserFailure, success: browserSuccess } = require('./browser-tool.cjs');
const PROTOCOL = 'areal.desktop-service.v1';
const browserKey = (projectId, threadId) => JSON.stringify([projectId, threadId]);
function validateCommand(name, params) {
  validateDesktopCommand(name, params, { serviceOnly: true });
}

// Media is the only binary value in the desktop contract. Keep the existing
// Uint8Array IPC API; use bounded base64 only across the service JSON transport.
function encodeMedia(value) {
  if (value?.bytes === undefined) return value;
  if (!(value.bytes instanceof Uint8Array) || value.bytes.length > 16 * 1024 * 1024) throw new Error('附件必须为 1 B–16 MiB');
  return { ...value, bytes: Buffer.from(value.bytes).toString('base64') };
}
function decodeMedia(value) {
  if (value?.bytes === undefined) return value;
  if (typeof value.bytes !== 'string' || value.bytes.length > 22369624) throw new Error('无效附件编码');
  const bytes = Buffer.from(value.bytes, 'base64');
  if (bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== value.bytes) throw new Error('无效附件编码');
  return { ...value, bytes: new Uint8Array(bytes) };
}

// One writer for provider secrets, recovery journals and projections. Core remains
// authoritative for execution. No generic RPC passthrough or renderer credentials.
class DesktopService {
  constructor(backend, identity, onStop = () => {}, backgroundNotifications, power) {
    this.backend = backend; this.identity = identity; this.onStop = onStop;
    this.backgroundNotifications = backgroundNotifications; this.power = power;
    this.pendingNotificationTarget = null;
    this.token = randomBytes(32).toString('hex'); this.clients = new Set();
    this.browserClaims = new Map(); this.browserPending = new Map(); this.nextBrowserId = 0;
    this.browserTestTrace = process.env.AREAL_BROWSER_READ_TEST_TRACE;
    backend.browserRead = request => this.browserRead(request);
    this.sequence = 0; this.inflight = 0; this.stopping = false;
    this.idleSince = Date.now(); this.closed = false;
    backend.onChange = () => this.schedule();
    backend.onNotification = notice => this.notify(notice);
  }
  packet() {
    return { sequence: ++this.sequence, snapshot: this.backend.snapshot(), service: {
      connected: true, clients: this.clients.size, busy: this.backend.hasWork({ includePausedQueues: false }),
      activeCommands: this.inflight, providerUpdating: !!this.backend.providerUpdating,
      starting: this.backend.starting.size, pid: process.pid,
    } };
  }
  send(socket, value) {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 32 * 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(value));
  }
  schedule() {
    void this.power?.refresh();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.publish(); }, 20);
  }
  publish() {
    const state = this.packet();
    for (const socket of this.clients) this.send(socket, { method: 'state', params: state });
    this.remote?.publish();
  }
  notify(notice) {
    const settings = this.backend.library.value.settings;
    const clients = [...this.clients].filter(s => s.notifications && s.readyState === 1);
    if (notice.kind === 'completion') {
      const policy = settings.turnNotifications ?? 'unfocused';
      if (policy === 'never') return;
      if (policy === 'unfocused' && clients.some(s => !s.activity || Date.now() - s.activity.time > 15000 || s.activity.windowFocused)) return;
    } else if (notice.kind === 'approval' && settings.permissionNotifications === false) return;
    else if (notice.kind === 'question' && settings.questionNotifications === false) return;
    // Most recently focused GUI owns delivery. Do not broadcast or replay if a
    // recipient disconnects: delivery is best-effort, never an execution receipt.
    clients.sort((a, b) => (b.lastFocused ?? 0) - (a.lastFocused ?? 0));
    const delivery = { ...notice, silent: settings.notificationSound === 'silent' };
    if (clients.length) this.send(clients[0], { method: 'notification', params: delivery });
    else this.backgroundNotifications?.show(delivery, target => this.openNotification(target));
  }
  openNotification(target) {
    const clients = [...this.clients].filter(s => s.notifications && s.readyState === 1)
      .sort((a, b) => (b.lastFocused ?? 0) - (a.lastFocused ?? 0));
    if (clients.length) { this.send(clients[0], { method: 'notificationOpen', params: target }); return; }
    // This is a user click, not a new execution request. Pass only navigation
    // identity over the authenticated connection when the GUI attaches.
    this.pendingNotificationTarget = target;
    try { this.backgroundNotifications?.launch(); }
    catch (error) { console.warn(this.backend.providers.redact(`通知打开界面失败：${error.message}`)); }
  }
  async listen() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 * 1024,
      verifyClient: ({ req }) => {
        const actual = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${this.token}`);
        return !req.headers.origin && actual.length === expected.length && timingSafeEqual(actual, expected);
      } });
    this.server.on('connection', socket => {
      socket.on('error', () => {});
      socket.on('message', bytes => { void this.receive(socket, bytes); });
      socket.on('close', () => {
        for (const [key, claim] of this.browserClaims) if (claim.socket === socket) this.browserClaims.delete(key);
        for (const [id, pending] of this.browserPending) if (pending.socket === socket) {
          this.browserPending.delete(id); clearTimeout(pending.timer);
          pending.reject(new Error('Browser host disconnected after dispatch'));
        }
        this.sampleActivity();
        if (this.clients.delete(socket) && !this.clients.size) this.idleSince = Date.now();
        this.sampleActivity(); this.schedule();
      });
    });
    await new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject); });
    this.activityTimer = setInterval(() => { this.sampleActivity(); }, 5000);
    this.flushTimer = setInterval(() => { void this.backend.analytics.flush(); }, 30000);
    return { protocol: PROTOCOL, endpoint: `ws://127.0.0.1:${this.server.address().port}`, token: this.token, identity: this.identity, pid: process.pid };
  }
  sampleActivity() {
    const now = Date.now();
    const active = [...this.clients].some(s => s.activity && now - s.activity.time <= 15000 && s.activity.focused);
    // Count the union of active GUI intervals, never one duration per client.
    this.backend.analytics.sample({ time: now, focused: active });
  }
  async stop() {
    if (this.stopping || this.inflight || this.backend.hasWork({ includePausedQueues: false }) || this.backend.providerUpdating || this.backend.starting.size) throw new Error('后台仍有任务、可执行的排队消息或操作，完成或暂停队列后重试');
    this.stopping = true; // Block new admissions before asynchronous status checks.
    try {
      const projects = await inspectResources(this.backend);
      if (projects.some(p => !p.restartSafe)) throw blocked('Core 仍有活动任务或终端。请打开“检查后台资源…”处理。\n' + summary(projects));
      await this.backend.shutdown({ requireSafe: true });
      await this.backend.library?.writes;
      await Promise.all(this.backend.saves?.values() ?? []);
    } catch (error) { this.stopping = false; throw error; }
  }
  async receive(socket, bytes) {
    let message;
    try { message = JSON.parse(bytes.toString()); } catch { socket.close(1008); return; }
    const { id, method, params } = message ?? {};
    if (!Number.isSafeInteger(id) || typeof method !== 'string') { socket.close(1008); return; }
    try {
      if (this.stopping) throw Object.assign(new Error('后台服务正在停止'), { code: 'SERVICE_STOPPING' });
      if (this.recovering) throw blocked('正在处理后台资源，请稍后重试');
      if (method === 'hello') {
        if (params?.protocol !== PROTOCOL || params?.identity !== this.identity) throw Object.assign(new Error('后台服务版本或启动配置不兼容。请先安全停止旧后台服务。'), { code: 'SERVICE_INCOMPATIBLE' });
        socket.notifications = params.notifications === true;
        this.clients.add(socket);
        this.idleSince = null;
        this.send(socket, { id, result: this.packet() });
        if (socket.notifications && this.pendingNotificationTarget) {
          this.send(socket, { method: 'notificationOpen', params: this.pendingNotificationTarget });
          this.pendingNotificationTarget = null;
        }
        this.schedule(); return;
      }
      // Explicit local stop also works after a source upgrade, without attaching
      // an incompatible GUI. Possession of the private token is still mandatory.
      if (method === 'stopService') {
        if (params?.protocol !== PROTOCOL) throw new Error('后台服务协议不兼容');
        if (params?.forUpdate && this.clients.size > 1) throw new Error('请先退出其他连接此后台服务的 GUI，再停止后台或安装更新');
        await this.stop(); this.send(socket, { id, result: { stopped: true } });
        setImmediate(() => this.onStop()); return;
      }
      if (!this.clients.has(socket)) throw new Error('请先完成后台服务握手');
      if (method === 'browserClaim') {
        const { projectId, threadId, pageId, browserHostId, hostGeneration, pageGeneration, controlEpoch } = params ?? {};
        if (params?.protocol !== 'areal.browser.host.v1' || params?.available !== true
          || JSON.stringify(params?.operations) !== JSON.stringify(['describe', 'observe', 'capture', 'act', 'wait'])) throw new Error('浏览器宿主能力不兼容');
        if (![projectId, threadId, pageId, browserHostId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
          || ![hostGeneration, pageGeneration, controlEpoch].every(Number.isSafeInteger)) throw new Error('无效浏览页面身份');
        const project = this.backend.projects.get(projectId);
        const thread = project?.model.state.threads[threadId];
        if (!thread?.dynamicTools?.some(tool => tool.name === 'browser_v1')) throw new Error('当前聊天未启用浏览器');
        const coreInstanceId = project.service?.serviceId, coreGeneration = project.service?.generation;
        if (typeof coreInstanceId !== 'string' || typeof coreGeneration !== 'string') throw new Error('Core 部署身份不可用');
        const key = browserKey(projectId, threadId);
        const previous = this.browserClaims.get(key);
        if (previous && previous.socket !== socket && previous.socket.readyState === 1) throw new Error('浏览页面已由其他桌面窗口认领');
        this.browserClaims.set(key, { socket, coreInstanceId, coreGeneration, pageId,
          browserHostId, hostGeneration, pageGeneration, controlEpoch });
        this.send(socket, { id, result: { claimed: true } }); return;
      }
      if (method === 'browserRevoke') {
        const key = browserKey(params?.projectId, params?.threadId);
        if (this.browserClaims.get(key)?.socket === socket) this.browserClaims.delete(key);
        this.send(socket, { id, result: { revoked: true } }); return;
      }
      if (method === 'browserResult') {
        const pending = this.browserPending.get(params?.requestId);
        if (!pending || pending.socket !== socket) throw new Error('无效浏览器回执');
        this.browserPending.delete(params.requestId); clearTimeout(pending.timer);
        if (params?.error) pending.reject(new Error('Browser host failed after dispatch'));
        else pending.resolve(params?.result);
        this.send(socket, { id, result: null }); return;
      }
      if (method === 'remoteControl') {
        if (!this.remote) throw new Error('手机连接未初始化');
        this.inflight++;
        try { this.send(socket, { id, result: await this.remote.control(params) }); }
        finally { this.inflight--; this.schedule(); }
        return;
      }
      if (method === 'resources') {
        if (params?.operation === 'inspect') {
          this.inflight++;
          try { this.send(socket, { id, result: await inspectResources(this.backend, { includeTasks: params.includeTasks === true }) }); }
          finally { this.inflight--; }
          return;
        }
        if (!['terminate', 'acknowledge'].includes(params?.operation)) throw new Error('无效资源操作');
        if (this.inflight || this.backend.hasWork({ includePausedQueues: false }) || this.backend.starting.size || this.backend.providerUpdating) throw new Error('请先完成任务和其他操作，再处理资源');
        this.inflight++; this.recovering = true;
        try { this.send(socket, { id, result: await recoverResource(this.backend, params) }); }
        finally { this.inflight--; this.recovering = false; this.schedule(); }
        return;
      }
      if (method === 'snapshot') { this.send(socket, { id, result: this.packet() }); return; }
      if (method === 'activity') {
        this.sampleActivity();
        const windowFocused = params?.focused === true && params?.suspended !== true;
        if (windowFocused && !socket.activity?.windowFocused) socket.lastFocused = Date.now();
        socket.activity = { time: Date.now(), windowFocused, focused: params?.focused === true && params?.suspended !== true && Number.isFinite(params?.idleSeconds) && params.idleSeconds <= 300 };
        this.sampleActivity(); this.send(socket, { id, result: null }); return;
      }
      if (method !== 'addProject' && method !== 'command') throw new Error('不支持的后台服务操作');
      if (method === 'command') validateCommand(params?.name, params?.request);
      else if (typeof params?.path !== 'string') throw new Error('无效工作区路径');
      this.inflight++; this.schedule();
      try {
        let result = method === 'command' ? await this.backend.command(params.name, params.name === 'media' ? decodeMedia(params.request) : params.request) : await this.backend.addProject(params.path);
        if (method === 'command' && params.name === 'media') result = encodeMedia(result);
        this.publish(); this.send(socket, { id, result });
      } finally { this.inflight--; this.schedule(); }
    } catch (error) {
      const message = error.code === 'SIDEBAR_SAVE_FAILED'
        ? '侧栏整理未能保存，原有布局已保留。请检查存储位置和写入权限后重试。'
        : error.message;
      this.send(socket, { id, error: { ...desktopError(error), message: this.backend.providers.redact(message) } });
    }
  }
  close() {
    this.closed = true;
    for (const pending of this.browserPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser service closed after dispatch')); }
    this.browserPending.clear(); this.browserClaims.clear();
    this.remote?.close();
    this.power?.close();
    this.backgroundNotifications?.close(); this.pendingNotificationTarget = null;
    clearTimeout(this.timer); clearInterval(this.activityTimer); clearInterval(this.flushTimer);
    for (const socket of this.server?.clients ?? []) socket.terminate();
    this.server?.close();
  }
  async executeRemote(name, request) {
    if (this.closed || this.stopping || this.recovering) throw new Error('后台正在停止或恢复，请稍后重试');
    this.inflight++; this.schedule();
    try { return await this.backend.command(name, request); }
    finally { this.inflight--; this.schedule(); }
  }
  async browserRead(request) {
    const { projectId, threadId, turnId, callId, toolHostGeneration, coreInstanceId, coreGeneration, signal, arguments: input,
      phase = 'execute', browserApproval } = request ?? {};
    if (typeof projectId !== 'string' || typeof threadId !== 'string' || typeof turnId !== 'string'
      || typeof callId !== 'string' || typeof coreInstanceId !== 'string' || !validToolInput(input))
      return browserFailure('invalid_arguments', 'Unsupported browser operation or parameters');
    const action = ['act', 'wait'].includes(input.operation);
    if (action && phase === 'execute' && (!browserApproval?.plan || typeof browserApproval.plan.preparedActionId !== 'string'))
      return browserFailure('approval_required', 'Core approval metadata is required');
    if (phase === 'prepare' && !action) throw new Error('Browser prepare is only for actions');
    const key = browserKey(projectId, threadId);
    const claim = this.browserClaims.get(key);
    if (!claim || claim.socket.readyState !== 1) return browserFailure('host_unavailable', 'No authorized live desktop page');
    if (claim.coreInstanceId !== coreInstanceId || claim.coreGeneration !== coreGeneration) {
      this.browserClaims.delete(key);
      return browserFailure('host_unavailable', 'Core deployment changed; authorize the page again');
    }
    if (input.operation === 'describe') return browserSuccess({ protocol: 'areal.browser.host.v1',
      browserHostId: claim.browserHostId, hostGeneration: claim.hostGeneration, available: true,
      operations: ['describe', 'observe', 'capture', 'act', 'wait'], pageId: claim.pageId });
    if (input.parameters.pageId !== claim.pageId) return browserFailure('wrong_page', 'Page does not belong to this thread');
    if (this.browserPending.size >= 8) return browserFailure('host_busy', 'Too many pending browser observations');
    if (signal?.aborted) throw new Error('Browser request was cancelled');
    const requestId = ++this.nextBrowserId;
    const trace = phase => { if (this.browserTestTrace) appendFileSync(this.browserTestTrace,
      JSON.stringify({ phase, requestId, threadId, callId }) + '\n'); };
    const result = await new Promise((resolve, reject) => {
      const finish = (kind, value) => { trace('finished'); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.browserPending.delete(requestId); kind(value); };
      const cancelNative = () => this.send(claim.socket, { method: 'browserCancel', params: {
        requestId, projectId, threadId, hostGeneration: claim.hostGeneration } });
      const onAbort = () => { cancelNative(); finish(reject, new Error('Browser request was cancelled')); };
      const timeoutMs = phase === 'prepare' ? 10000 : input.operation === 'wait'
        ? Math.min(35000, input.parameters.timeoutMs + 3000) : 15000;
      const timer = setTimeout(() => { cancelNative(); finish(reject, new Error('Browser host response unknown')); }, timeoutMs);
      this.browserPending.set(requestId, { socket: claim.socket, resolve: value => finish(resolve, value), reject: error => finish(reject, error), timer });
      trace('pending');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send(claim.socket, { method: 'browserRequest', params: { requestId, coreInstanceId, coreGeneration,
        projectId, threadId, turnId, callId, pageId: claim.pageId, browserHostId: claim.browserHostId,
        hostGeneration: claim.hostGeneration, pageGeneration: claim.pageGeneration,
        controlEpoch: claim.controlEpoch, operation: input.operation, parameters: input.parameters,
        phase, ...(action && phase === 'execute' ? { browserApproval } : {}) } });
    });
    if (this.browserClaims.get(key) !== claim) return browserFailure('human_control', 'Browser authorization was revoked');
    const currentProject = this.backend.projects.get(projectId);
    if (currentProject?.service?.serviceId !== coreInstanceId || currentProject.service.generation !== coreGeneration)
      return browserFailure('host_unavailable', 'Core deployment changed during observation');
    if (!result || typeof result !== 'object' || result.pageId !== claim.pageId || result.callId !== callId
      || result.turnId !== turnId || result.threadId !== threadId || result.projectId !== projectId
      || result.coreInstanceId !== coreInstanceId || result.coreGeneration !== coreGeneration
      || result.browserHostId !== claim.browserHostId || result.hostGeneration !== claim.hostGeneration
      || result.pageGeneration !== claim.pageGeneration || result.controlEpoch !== claim.controlEpoch
      || JSON.stringify(result).length > (input.operation === 'capture' ? 3 * 1024 * 1024 : 512 * 1024)) throw new Error('Invalid browser host response');
    if (result.error) {
      if (phase === 'prepare') return { error: result.error, dispatch: 'not_sent' };
      const hint = { human_control: 'Human controls this page', plan_stale: 'Page or target changed; observe again before a new action',
        stale_ref: 'Target changed; observe again', human_takeover_required: 'Use human takeover for this page',
        not_sent: 'Target unavailable before input; observe again' }[result.error] ?? 'Page unavailable';
      return browserFailure(result.error, hint);
    }
    if (phase === 'prepare') {
      if (!result.plan || result.plan.pageId !== claim.pageId || result.plan.operation !== input.operation)
        throw new Error('Invalid browser plan');
      return result.plan;
    }
    if (action) return { ...browserSuccess(result), structuredContent: result };
    if (input.operation === 'capture') {
      if (result.mimeType !== 'image/png' || typeof result.imageBase64 !== 'string'
        || result.imageBase64.length > 2_800_000 || typeof toolHostGeneration !== 'string')
        throw new Error('Invalid browser image');
      const bytes = Buffer.from(result.imageBase64, 'base64');
      if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== result.imageBase64)
        throw new Error('Invalid browser image');
      const project = this.backend.projects.get(projectId);
      const url = new URL(project.endpoint);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = '/areal/blobs'; url.search = '';
      url.searchParams.set('threadId', threadId);
      url.searchParams.set('callId', callId);
      url.searchParams.set('hostGeneration', toolHostGeneration);
      const uploaded = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${project.token}`, 'Content-Type': 'image/png' },
        body: bytes, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!uploaded.ok) throw new Error(`Browser evidence upload failed (${uploaded.status})`);
      const media = await uploaded.json();
      if (signal?.aborted || this.browserClaims.get(key) !== claim || claim.socket.readyState !== 1)
        return browserFailure('human_control', 'Browser authorization was revoked during capture');
      const current = this.backend.projects.get(projectId);
      if (current?.service?.serviceId !== coreInstanceId || current.service.generation !== coreGeneration)
        return browserFailure('host_unavailable', 'Core deployment changed during capture');
      const { imageBase64, ...metadata } = result;
      return { success: true, contentItems: [
        { type: 'inputText', text: JSON.stringify({ ...metadata, media }) },
        { type: 'arealMedia', modality: 'image', media },
      ] };
    }
    return browserSuccess(result);
  }
}
module.exports = { PROTOCOL, DesktopService, validateCommand, encodeMedia, decodeMedia };
