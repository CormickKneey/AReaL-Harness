'use strict';

const { randomUUID } = require('node:crypto');
const { mkdir, open, readFile, readdir, rename, rm } = require('node:fs/promises');
const { join, isAbsolute, resolve } = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { lifecycleCapabilities, requestStop, readStop, detachStoppedProject, readOriginalTurn, readTurnMetadata } = require('./local-service.cjs');

const KINDS = Object.freeze(['stopDesktop', 'updateDesktop', 'stopProject', 'updateProject', 'interruptTurn']);
const PHASES = new Set(['notAttempted', 'acceptedPending', 'blocked', 'admissionUnconfirmed', 'settlementIncomplete', 'completed']);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const desktopKind = kind => kind === 'stopDesktop' || kind === 'updateDesktop';
const identities = targets => targets.map(({ projectId, serviceId, generation }) => ({ projectId, serviceId, generation }))
  .sort((a, b) => a.projectId.localeCompare(b.projectId));
const failure = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const unresolved = target => ['acceptedPending', 'admissionUnconfirmed', 'settlementIncomplete'].includes(target.phase);

function deriveReceipt(record) {
  const phases = record.targets.map(target => target.phase);
  if (record.desktopError) record.phase = 'settlementIncomplete';
  else if (phases.every(phase => phase === 'completed')) record.phase = desktopKind(record.kind) ? 'acceptedPending' : 'completed';
  else if (new Set(phases).size > 1) record.phase = 'partial';
  else record.phase = phases[0] === 'notAttempted' ? 'acceptedPending' : phases[0];
}

function receiptError(error, redact) {
  return { code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : 'LIFECYCLE_FAILED',
    message: redact(error.message).slice(0, 2048) };
}

function applyHostReceipt(record, target, operation) {
  if (!operation || operation.version !== 1 || operation.requestId !== target.requestId
    || operation.serviceId !== target.serviceId || operation.generation !== target.generation
    || operation.cancel !== (record.mode === 'cancel')
    || !['acceptedPending', 'blocked', 'admissionUnknown', 'settlementIncomplete', 'completed'].includes(operation.state)) {
    throw failure('原 Host 回执身份或状态不匹配', 'LIFECYCLE_RECEIPT_INVALID');
  }
  target.hostReceipt = operation;
  target.phase = operation.state === 'admissionUnknown' ? 'admissionUnconfirmed' : operation.state;
  delete target.error;
}

function applyTurnReceipt(record, target, turn) {
  if (!turn) return;
  if (turn.id !== record.turnId || !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status))
    throw failure('原轮次回执身份或状态不匹配', 'LIFECYCLE_RECEIPT_INVALID');
  if (turn.status !== 'inProgress') { target.phase = 'completed'; delete target.error; }
}

async function reconcileReceipt(record, { readHost, inspectTurn, completed = () => {}, redact }) {
  for (const target of record.targets) {
    if (!unresolved(target)) continue;
    try {
      if (record.kind === 'interruptTurn') await inspectTurn(record, target);
      else {
        const operation = await readHost(target);
        if (operation) applyHostReceipt(record, target, operation);
        else target.phase = 'admissionUnconfirmed';
      }
      if (target.phase === 'completed') completed(target);
    } catch (error) { target.error = receiptError(error, redact); }
  }
  deriveReceipt(record);
  return record;
}

function validateReceipt(record, requestId) {
  if (!uuid(record?.requestId) || record.requestId !== requestId || record.version !== 1
    || !KINDS.includes(record.kind) || !uuid(record.desktopGeneration) || !['ifIdle', 'cancel'].includes(record.mode)
    || record.harnessHome !== undefined && (typeof record.harnessHome !== 'string' || !isAbsolute(record.harnessHome))
    || !['notRequested', 'requested'].includes(record.desktopExit)
    || !['acceptedPending', 'blocked', 'partial', 'admissionUnconfirmed', 'settlementIncomplete', 'completed'].includes(record.phase)
    || !Array.isArray(record.targets) || record.targets.some(target => !text(target.projectId)
      || !text(target.serviceId) || !text(target.generation) || !uuid(target.requestId) || !PHASES.has(target.phase))
    || record.kind === 'interruptTurn' && (!text(record.threadId) || !text(record.turnId))) {
    throw failure('后台生命周期回执损坏，请检查原记录；不会启动或重发操作', 'LIFECYCLE_JOURNAL_INVALID');
  }
  return record;
}

async function readLifecycleReceipt(home, { requestId, desktopGeneration } = {}) {
  if (!uuid(requestId) || desktopGeneration !== undefined && !uuid(desktopGeneration))
    throw failure('无效的后台请求身份', 'LIFECYCLE_INVALID_REQUEST');
  let record;
  try { record = validateReceipt(JSON.parse(await readFile(join(home, 'lifecycle-operations', `${requestId}.json`), 'utf8')), requestId); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (desktopGeneration !== undefined && record.desktopGeneration !== desktopGeneration)
    throw failure('原 Desktop 回执代际不匹配', 'LIFECYCLE_RECEIPT_INVALID');
  return record;
}

async function reconcileLifecycleReceipt(home, { requestId, desktopGeneration, binary, harnessHome, redact = value => value } = {}) {
  const record = await readLifecycleReceipt(home, { requestId, desktopGeneration });
  if (!record) return null;
  if (!record.targets.some(unresolved)) { deriveReceipt(record); return record; }
  const registry = record.harnessHome ?? harnessHome;
  if (!isAbsolute(binary ?? '') || !isAbsolute(registry ?? '') || typeof redact !== 'function')
    throw failure('离线核查需要原 Core 程序与服务登记目录', 'LIFECYCLE_INVALID_REQUEST');
  const reader = { binary, home, providers: { redact },
    hooks: { environment: () => ({ ...process.env, AREAL_HARNESS_SERVICE_HOME: registry }) } };
  return reconcileReceipt(record, {
    readHost: target => readStop(reader, target), redact,
    inspectTurn: async (receipt, target) => {
      reader.saved ??= JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'));
      if (!Array.isArray(reader.saved) || reader.saved.some(project => !text(project?.id) || !isAbsolute(project.root ?? '')))
        throw failure('原工作区登记不可用，无法核对轮次', 'LIFECYCLE_INCOMPLETE');
      applyTurnReceipt(receipt, target, await readOriginalTurn(reader, target, receipt.threadId, receipt.turnId));
    },
  });
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

class LifecycleOperations {
  constructor(backend) {
    this.backend = backend;
    this.generation = randomUUID();
    this.directory = join(backend.home, 'lifecycle-operations');
    this.records = new Map();
    this.activeTargets = new Set();
    this.activeRequestId = null;
    this.tail = Promise.resolve();
  }

  init() {
    this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await syncDirectory(this.backend.home);
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith('.json')) continue;
        const record = await readLifecycleReceipt(this.backend.home, { requestId: name.slice(0, -5) });
        this.records.set(record.requestId, record);
      }
    })();
    return this.ready;
  }

  attach(service) {
    if (this.service && this.service !== service) {
      if (!this.service.closed) throw failure('原 Desktop owner 仍在使用，不能替换生命周期代际', 'LIFECYCLE_BLOCKED');
      const owner = new LifecycleOperations(this.backend);
      owner.service = service;
      this.backend.lifecycleOperations = owner;
      return owner;
    }
    this.service = service;
    return this;
  }

  async reconcileLoaded() {
    await this.init();
    for (const record of [...this.records.values()]) {
      if (record.targets.some(target => ['acceptedPending', 'admissionUnconfirmed', 'settlementIncomplete'].includes(target.phase)))
        await this.reconcile(record.requestId);
    }
  }

  snapshot() {
    return { version: 2, desktopGeneration: this.generation,
      capabilities: { request: true, read: true, reconcile: true, kinds: [...KINDS] },
      activeRequestId: this.activeRequestId,
      blockedProjectIds: [...new Set([...this.records.values()]
        .flatMap(record => record.targets.filter(target => ['acceptedPending', 'admissionUnconfirmed', 'settlementIncomplete'].includes(target.phase)).map(target => target.projectId)))],
    };
  }

  targets() {
    const engines = this.backend.applicationOwner
      ? [...this.backend.ownedEngines].filter(([, entry]) => entry.service).map(([projectId, entry]) => [projectId, entry.project])
      : [...this.backend.projects];
    return identities(engines.filter(([, project]) => project.service)
      .map(([projectId, project]) => ({ projectId, serviceId: project.service.serviceId, generation: project.service.generation })));
  }

  blocking(projectId, threadId) {
    for (const record of this.records.values()) {
      if (record.targets.some(target => target.projectId === projectId
        && ['acceptedPending', 'admissionUnconfirmed', 'settlementIncomplete'].includes(target.phase))) return record;
    }
    return null;
  }

  exitingReceipt() {
    return [...this.records.values()].find(record => record.desktopGeneration === this.generation && record.desktopExit === 'requested');
  }

  assertNotExiting() {
    const record = this.exitingReceipt();
    if (record) throw failure('原 Desktop 已请求退出，请等待原进程结束', 'LIFECYCLE_EXIT_REQUESTED',
      { requestId: record.requestId, lifecycle: record });
  }

  assertRegistration() {
    this.assertNotExiting();
    if (this.activeRequestId) throw failure('正在处理后台生命周期，请稍后打开工作区', 'LIFECYCLE_BLOCKED');
  }

  assertProject(projectId, threadId) {
    this.assertNotExiting();
    const record = this.blocking(projectId, threadId);
    if (this.activeRequestId || this.activeTargets.has(projectId) || record) throw failure('原后台操作尚未结算，请检查原请求；不会启动或重发',
      'LIFECYCLE_INCOMPLETE', { requestId: record?.requestId, lifecycle: record });
  }

  normalize(input) {
    if (!uuid(input?.requestId) || !uuid(input.expectedDesktopGeneration) || !KINDS.includes(input.kind)
      || !['ifIdle', 'cancel'].includes(input.mode) || !Array.isArray(input.expectedTargets)
      || input.expectedTargets.some(target => !text(target?.projectId) || !text(target.serviceId) || !text(target.generation))
      || new Set(input.expectedTargets.map(target => target.projectId)).size !== input.expectedTargets.length
      || !desktopKind(input.kind) && input.expectedTargets.length !== 1
      || input.kind === 'interruptTurn' && (!text(input.threadId) || !text(input.turnId) || input.mode !== 'cancel')) {
      throw failure('无效的后台生命周期请求', 'LIFECYCLE_INVALID_REQUEST');
    }
    return { requestId: input.requestId, kind: input.kind, mode: input.mode,
      desktopGeneration: input.expectedDesktopGeneration, targets: identities(input.expectedTargets),
      ...(input.kind === 'interruptTurn' ? { threadId: input.threadId, turnId: input.turnId } : {}) };
  }

  async store(record) {
    const previous = this.records.get(record.requestId);
    if (previous && isDeepStrictEqual(previous, record)) return;
    const path = join(this.directory, `${record.requestId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      await syncDirectory(this.directory);
      this.records.set(record.requestId, structuredClone(record));
      this.backend.onChange?.();
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw failure(`后台生命周期回执未能保存：${error.message}`, 'LIFECYCLE_RECEIPT_WRITE_FAILED', { requestId: record.requestId });
    }
  }

  async read(requestId) {
    if (!uuid(requestId)) throw failure('无效的后台请求身份', 'LIFECYCLE_INVALID_REQUEST');
    await this.init();
    return structuredClone(this.records.get(requestId) ?? null);
  }

  request(input) {
    const request = this.normalize(input);
    const task = this.tail.catch(() => {}).then(() => this.execute(request));
    this.tail = task.catch(() => {});
    return task;
  }

  async execute(request) {
    await this.init();
    const existing = this.records.get(request.requestId);
    if (existing) {
      const original = { requestId: existing.requestId, kind: existing.kind, mode: existing.mode,
        desktopGeneration: existing.desktopGeneration, targets: identities(existing.targets),
        ...(existing.kind === 'interruptTurn' ? { threadId: existing.threadId, turnId: existing.turnId } : {}) };
      if (!isDeepStrictEqual(request, original)) throw failure('请求身份已绑定其他生命周期意图', 'LIFECYCLE_REQUEST_CONFLICT');
      return structuredClone(existing);
    }
    this.assertNotExiting();
    const current = this.targets();
    if (request.desktopGeneration !== this.generation
      || !isDeepStrictEqual(request.targets, desktopKind(request.kind) ? current : current.filter(target => request.targets.some(expected => expected.projectId === target.projectId)))) {
      throw failure('后台实例或项目范围已变化，请重新确认', 'CONFIRMATION_STALE');
    }
    for (const target of request.targets) {
      const prior = [...this.records.values()].find(record => record.targets.some(value => value.projectId === target.projectId
          && ['admissionUnconfirmed', 'acceptedPending'].includes(value.phase)));
      if (prior) throw failure('原后台操作受理或退出尚未确认，请先检查原请求', 'LIFECYCLE_INCOMPLETE', { requestId: prior.requestId, lifecycle: prior });
    }
    if (desktopKind(request.kind)) {
      const { desktopBlockers, blockerMessage } = require('./lifecycle.cjs');
      const blockers = desktopBlockers({ clients: this.service?.clients.size ?? 0,
        activeCommands: Math.max(this.service?.inflight ?? 0, this.backend.activeCommands ?? 0),
        providerUpdating: this.backend.providerUpdating || this.backend.resourcesUpdating, starting: this.backend.starting.size }, request.kind === 'updateDesktop');
      if (blockers.length) throw failure(blockerMessage(blockers), 'LIFECYCLE_BLOCKED');
      this.activeRequestId = request.requestId;
    }
    const record = { version: 1, ...request, harnessHome: resolve(this.backend.harnessHome),
      targets: request.targets.map(target => ({ ...target, requestId: randomUUID(), phase: 'notAttempted' })),
      phase: 'acceptedPending', desktopExit: 'notRequested' };
    let admitted = false;
    try {
      for (const target of record.targets) this.activeTargets.add(target.projectId);
      await this.store(record);
      admitted = true;
      for (const target of record.targets) {
        if (record.kind === 'interruptTurn') await this.interrupt(record, target);
        else await this.stopTarget(record, target);
        deriveReceipt(record); await this.store(record);
      }
      if (desktopKind(record.kind) && record.targets.every(target => target.phase === 'completed')) {
        try {
          await this.backend.library?.writes;
          await Promise.all(this.backend.saves?.values() ?? []);
          record.desktopExit = 'requested';
        } catch (error) { record.desktopError = this.error(error); }
      }
      deriveReceipt(record); await this.store(record);
      return structuredClone(record);
    } catch (error) {
      if (!admitted) throw failure(`后台生命周期请求未受理，原后台保持运行：${error.message}`, 'LIFECYCLE_ADMISSION_FAILED',
        { requestId: record.requestId, submissionUnknown: false, cause: error });
      error.requestId = record.requestId;
      error.submissionUnknown = true;
      throw error;
    } finally {
      for (const target of record.targets) this.activeTargets.delete(target.projectId);
      if (this.activeRequestId === request.requestId) this.activeRequestId = null;
      this.backend.onChange?.();
    }
  }

  error(error) {
    return receiptError(error, value => this.backend.providers.redact(value));
  }

  currentTarget(target) {
    const project = this.backend.projects.get(target.projectId) ?? this.backend.ownedEngines?.get(target.projectId)?.project;
    if (project?.service?.serviceId !== target.serviceId || project.service.generation !== target.generation)
      throw failure('原 Core 实例或代际已变化', 'CONFIRMATION_STALE');
    return project;
  }

  applyHost(record, target, operation) {
    applyHostReceipt(record, target, operation);
    if (target.phase === 'completed') detachStoppedProject(this.backend, target);
  }

  async stopTarget(record, target) {
    try {
      this.currentTarget(target);
      await lifecycleCapabilities(this.backend, target);
      this.currentTarget(target);
    } catch (error) { target.phase = 'blocked'; target.error = this.error(error); return; }
    target.phase = 'acceptedPending'; await this.store(record);
    try {
      this.applyHost(record, target, await requestStop(this.backend, target, record.mode === 'cancel'));
      const deadline = Date.now() + 15000;
      while (target.phase === 'acceptedPending' && Date.now() < deadline) {
        await pause(50);
        const operation = await readStop(this.backend, target);
        if (!operation) break;
        this.applyHost(record, target, operation);
      }
    } catch (error) {
      try {
        const operation = await readStop(this.backend, target);
        if (operation) { this.applyHost(record, target, operation); return; }
      } catch { /* 原回执不可读时，不得授权重发。 */ }
      target.phase = 'admissionUnconfirmed'; target.error = this.error(error);
    }
  }

  readLiveTurn(project, target, threadId, turnId) {
    const client = project.client;
    const assertCurrent = () => {
      if (this.currentTarget(target) !== project) throw failure('原工作区归属已变化', 'CONFIRMATION_STALE');
      this.backend.requireConnection(project, client);
    };
    return readTurnMetadata(client, threadId, turnId, { assertCurrent,
      observe: () => this.backend.readObservation(project, threadId, { client, current: () => { assertCurrent(); return true; } }),
    });
  }

  async interrupt(record, target) {
    let project, client;
    try {
      project = this.currentTarget(target);
      if (!project.client?.ready || !project.client.capabilities?.methods?.includes('turn/interrupt'))
        throw failure('当前 Core 不支持精确轮次中断', 'LIFECYCLE_UNSUPPORTED');
      client = project.client;
      const turn = await this.readLiveTurn(project, target, record.threadId, record.turnId);
      if (turn?.status !== 'inProgress')
        throw failure('原轮次已结束，请刷新聊天状态', 'TURN_NOT_ACTIVE');
    } catch (error) { target.phase = 'blocked'; target.error = this.error(error); return; }
    target.phase = 'acceptedPending'; await this.store(record);
    try {
      this.currentTarget(target);
      this.backend.requireConnection(project, client);
      await client.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId });
      const deadline = Date.now() + 10000;
      do {
        await this.inspectInterrupt(record, target);
        if (target.phase === 'completed') break;
        await pause(50);
      } while (Date.now() < deadline);
    } catch (error) {
      target.phase = 'admissionUnconfirmed'; target.error = this.error(error);
      await this.inspectInterrupt(record, target).catch(() => {});
    }
  }

  async inspectInterrupt(record, target) {
    const project = this.backend.projects.get(target.projectId) ?? this.backend.ownedEngines?.get(target.projectId)?.project;
    let turn;
    if (project?.client?.ready && project.service?.serviceId === target.serviceId && project.service.generation === target.generation) {
      turn = await this.readLiveTurn(project, target, record.threadId, record.turnId);
    } else turn = await readOriginalTurn(this.backend, target, record.threadId, record.turnId);
    applyTurnReceipt(record, target, turn);
  }

  reconcile(requestId) {
    const task = this.tail.catch(() => {}).then(async () => {
      const record = await this.read(requestId);
      if (!record) return null;
      await reconcileReceipt(record, { readHost: target => readStop(this.backend, target),
        inspectTurn: (receipt, target) => this.inspectInterrupt(receipt, target),
        completed: target => detachStoppedProject(this.backend, target),
        redact: value => this.backend.providers.redact(value) });
      await this.store(record);
      return record;
    });
    this.tail = task.catch(() => {});
    return task;
  }
}

module.exports = { LifecycleOperations, readLifecycleReceipt, reconcileLifecycleReceipt, KINDS };
