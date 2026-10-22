'use strict';

const { executeCore } = require('./core-process.cjs');
const { readFile, realpath } = require('node:fs/promises');
const { isAbsolute, resolve, join } = require('node:path');
const WebSocket = require('ws');

// 服务管理只走公共 CLI；轮次核查只读原代际的认证 app-server，不持有或终止 Core/Runtime 子进程。
async function request(backend, args, environment = backend.hooks.environment(), project) {
  let stdout;
  try {
    const execution = executeCore(backend.binary, ['service', ...args, '--json'], {
      ...(['ensure', 'recover'].includes(args[0]) && backend.applicationOwner ? { applicationOwner: backend.applicationOwner } : {}),
      env: environment, timeout: ['status', 'capabilities', 'operation'].includes(args[0]) ? 10_000 : 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    if (project && execution.child.ownerLifetime) {
      const entry = backend.ownedEngines.get(project.id);
      entry.lifetimes ??= new Set();
      entry.lifetimes.add(execution.child.ownerLifetime);
      execution.child.ownerLifetime.on('error', () => {});
    }
    ({ stdout } = await execution);
  } catch (error) {
    let failure;
    try { failure = JSON.parse(error.stderr).error; } catch { /* CLI/launcher diagnostics can be plain text. */ }
    const message = typeof failure?.message === 'string' ? failure.message : error.stderr || error.message;
    if (message.includes('service is busy; wait for work to settle or stop with --cancel')) {
      throw Object.assign(new Error('Core 仍有活动目标、排队消息或后台任务，请等待完成或先暂停相关任务后重试。'), { code: 'CORE_BUSY' });
    }
    throw Object.assign(new Error(`Core 服务请求失败：${backend.providers.redact(message).slice(0, 2048)}`),
      { code: typeof failure?.code === 'string' ? failure.code : error.timedOut ? 'TIMEOUT' : error.code });
  }
  try { return JSON.parse(stdout); }
  catch { throw new Error('Core 返回了无效的本地服务描述'); }
}

async function connectService(backend, operation, args, environment, project, dataDir) {
  const descriptor = await request(backend, [operation, ...args, ...(operation === 'ensure' ? ['--no-auto-restart'] : [])], environment, project);
  if (operation === 'status' && ['stopped', 'unavailable', 'stopping'].includes(descriptor?.state)) {
    throw Object.assign(new Error('Core 服务已停止或正在停止，请显式重新连接'), { code: 'CORE_STOPPED' });
  }
  let endpoint;
  try { endpoint = new URL(descriptor?.endpoint); }
  catch { throw Object.assign(new Error('Core 返回了无效的服务地址'), { code: 'CORE_INCOMPATIBLE' }); }
  if (descriptor.protocolVersion !== 1 || descriptor.state !== 'ready'
    || !/^[a-f0-9]{24}$/.test(descriptor.serviceId) || typeof descriptor.generation !== 'string'
    || typeof descriptor.configFingerprint !== 'string'
    || descriptor.workspace !== await realpath(project.root)
    || descriptor.dataDir !== await realpath(dataDir)
    || endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || typeof descriptor.authFile !== 'string' || !isAbsolute(descriptor.authFile)) {
    throw Object.assign(new Error('Core 服务描述与当前工作区不匹配'), { code: 'CORE_INCOMPATIBLE' });
  }
  if (backend.applicationOwner && !require('./application-owner.cjs').sameOwner(descriptor.owner, backend.applicationOwner))
    throw Object.assign(new Error('原 Core 不属于本次 GUI 应用，请先从原 owner 的安全管理入口停止后再连接'), { code: 'APPLICATION_OWNER_MISMATCH' });
  const auth = JSON.parse(await readFile(resolve(descriptor.authFile), 'utf8'));
  const principal = auth.principals?.find(item => ['observe', 'interact', 'manage']
    .every(permission => item.permissions?.includes(permission)));
  if (typeof principal?.token !== 'string' || !principal.token) throw new Error('Core 未提供桌面身份');
  return { descriptor, token: principal.token };
}

const targetArguments = target => ['--instance', target.serviceId, '--expected-generation', target.generation];

async function recoveryStatus(backend, project, target) {
  const value = await request(backend, ['status', '--instance', target.serviceId, '--recovery']);
  const service = value?.service;
  if (value?.recovery?.version !== 1 || value.recovery.generation !== target.generation
    || typeof value.recovery.eligible !== 'boolean' || typeof value.recovery.reason !== 'string'
    || service?.serviceId !== target.serviceId || service.generation !== target.generation
    || service.configFingerprint !== target.configFingerprint || service.workspace !== await realpath(project.root)
    || service.dataDir !== await realpath(target.dataDir)
    || !require('./application-owner.cjs').sameOwner(service.owner, backend.applicationOwner))
    throw Object.assign(new Error('原服务的恢复证明与当前应用不匹配'), { code: 'CORE_INCOMPATIBLE' });
  return value;
}

function recoverService(backend, project, target, launch) {
  return connectService(backend, 'recover', [...targetArguments(target), ...launch.args],
    launch.environment, project, target.dataDir);
}

async function lifecycleCapabilities(backend, target) {
  let value;
  try { value = await request(backend, ['capabilities', ...targetArguments(target)]); }
  catch (error) {
    throw Object.assign(new Error('原 Core Host 不支持持久生命周期回执，请先安全升级后台。'),
      { code: /generation changed/.test(error.message) ? 'CONFIRMATION_STALE' : 'LIFECYCLE_UNSUPPORTED' });
  }
  if (value?.version !== 1 || value.stopOperations !== 1)
    throw Object.assign(new Error('原 Core Host 不支持持久生命周期回执，请先安全升级后台。'), { code: 'LIFECYCLE_UNSUPPORTED' });
  return value;
}

function requestStop(backend, target, cancel) {
  return request(backend, ['stop', ...targetArguments(target), '--request-id', target.requestId, ...(cancel ? ['--cancel'] : [])]);
}

async function readStop(backend, target) {
  const result = await request(backend, ['operation', ...targetArguments(target), '--request-id', target.requestId]);
  if (!result || !Object.hasOwn(result, 'operation')) throw new Error('Core 返回了无效的生命周期回执查询');
  return result.operation;
}

function detachStoppedProject(backend, target) {
  const owned = backend.ownedEngines?.get(target.projectId);
  if (owned?.service?.serviceId === target.serviceId && owned.service.generation === target.generation) {
    for (const lifetime of owned.lifetimes ?? []) lifetime.destroy();
    backend.ownedEngines.delete(target.projectId);
  }
  const project = backend.projects.get(target.projectId) ?? owned?.project;
  if (project?.service?.serviceId !== target.serviceId || project.service.generation !== target.generation) return;
  project.service = null;
  project.endpoint = null;
  clearTimeout(project.reconnectTimer);
  project.reconnectTimer = null;
  project.taskNotificationMonitor?.stop();
  project.client?.close();
  project.client = null;
  project.model.connection(false);
}

async function readTurnMetadata(client, threadId, turnId, { observe, assertCurrent = () => {} } = {}) {
  const invalid = () => Object.assign(new Error('原轮次历史元数据不完整或身份不匹配'), { code: 'LIFECYCLE_RECEIPT_INVALID' });
  const bounded = client.capabilities?.features?.boundedObservation === true && client.capabilities.features.boundedHistory === true;
  assertCurrent();
  let result;
  if (!bounded) result = await client.request('thread/read', { threadId, includeTurns: true });
  else if (observe) result = await observe();
  else {
    for (const maxBytes of [262144, 1048576]) {
      try {
        result = await client.request('areal/thread/observe', { threadId, mode: 'bounded', maxBytes }, { maxResponseBytes: maxBytes });
        break;
      } catch (error) {
        assertCurrent();
        if (maxBytes === 1048576 || (error.reason ?? error.data?.reason) !== 'HISTORY_BUDGET_TOO_SMALL') throw error;
      }
    }
  }
  assertCurrent();
  if (result?.thread?.id !== threadId || !Array.isArray(result.thread.turns)) throw invalid();
  const found = result.thread.turns.find(turn => turn.id === turnId);
  if (found) return { id: found.id, status: found.status };
  if (!bounded) return null;
  const history = result.history;
  if (!history || typeof history.snapshotId !== 'string' || typeof history.complete !== 'boolean') throw invalid();
  let cursor = history.nextCursor;
  while (!history.complete && cursor) {
    assertCurrent();
    const page = await client.request('areal/conversation/history', { threadId, view: 'own', cursor, maxBytes: 262144 }, { maxResponseBytes: 262144 });
    assertCurrent();
    if (page.snapshotId !== history.snapshotId || !Array.isArray(page.data)
      || page.data.some(entry => entry.sourceThreadId !== threadId) || typeof page.complete !== 'boolean') throw invalid();
    const entry = page.data.find(entry => entry.sourceTurnId === turnId);
    if (entry) return { id: entry.sourceTurnId, status: entry.sourceTurnStatus };
    if (page.complete) return null;
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === cursor) throw invalid();
    cursor = page.nextCursor;
  }
  if (!history.complete) throw invalid();
  return null;
}

async function readOriginalTurn(backend, target, threadId, turnId) {
  const project = backend.saved.find(project => project.id === target.projectId) ?? backend.ownedEngines?.get(target.projectId)?.project;
  if (!project) throw Object.assign(new Error('原工作区登记不可用，无法核对轮次'), { code: 'LIFECYCLE_INCOMPLETE' });
  const { descriptor, token } = await connectService(backend, 'status', ['--instance', target.serviceId],
    backend.hooks.environment(), project, join(backend.home, target.projectId, 'state'));
  if (descriptor.serviceId !== target.serviceId || descriptor.generation !== target.generation)
    throw Object.assign(new Error('原 Core 代际已变化，不能用新实例代替核查'), { code: 'CONFIRMATION_STALE' });
  const { CoreClient, MAX_RESPONSE_BYTES } = await import('@areal/runtime-client/core');
  const client = new CoreClient({ createSocket: () => new WebSocket(descriptor.endpoint,
    { headers: { Authorization: `Bearer ${token}` }, followRedirects: false, maxPayload: MAX_RESPONSE_BYTES }) });
  try {
    await client.connect();
    return await readTurnMetadata(client, threadId, turnId);
  } finally { client.close(); }
}

module.exports = { connectService, recoveryStatus, recoverService, lifecycleCapabilities, requestStop, readStop, detachStoppedProject, readOriginalTurn, readTurnMetadata };

// Status alone normalizes a vanished Host to stopped. Recovery also requires
// the original Host's clean-shutdown marker; PID/socket disappearance is not proof.
async function inspectOriginalService(backend, target) {
  const descriptor = await request(backend, ['status', '--instance', target.serviceId]);
  const dataDir = await realpath(join(backend.home, target.projectId, 'state'));
  const workspace = await realpath(target.root);
  const matches = value => value?.protocolVersion === 1 && value.serviceId === target.serviceId
    && value.generation === target.generation && value.dataDir === dataDir && value.workspace === workspace;
  if (!matches(descriptor)) throw Object.assign(new Error('原 Core 身份或代际已变化，不能用新实例代替核查'), { code: 'CONFIRMATION_STALE' });
  if (descriptor.state === 'stopped') {
    const record = JSON.parse(await readFile(join(backend.hooks.environment().AREAL_HARNESS_SERVICE_HOME,
      'services', target.serviceId, 'service.json'), 'utf8'));
    return { descriptor, cleanupConfirmed: matches(record) && record.state === 'stopped' };
  }
  if (descriptor.state !== 'ready') return { descriptor, cleanupConfirmed: false };
  const { token, descriptor: connected } = await connectService(backend, 'status', ['--instance', target.serviceId], backend.hooks.environment(), target, dataDir);
  if (!matches(connected)) throw Object.assign(new Error('原 Core 代际已变化'), { code: 'CONFIRMATION_STALE' });
  const { CoreClient } = await import('@areal/runtime-client/core');
  const client = new CoreClient({ createSocket: () => new WebSocket(connected.endpoint,
    { headers: { Authorization: `Bearer ${token}` }, followRedirects: false, maxPayload: 4 * 1024 * 1024 }) });
  try {
    await client.connect();
    return { descriptor, cleanupConfirmed: false, status: await client.request('areal/server/status') };
  } finally { client.close(); }
}
module.exports.inspectOriginalService = inspectOriginalService;
module.exports.serviceRequest = request;
