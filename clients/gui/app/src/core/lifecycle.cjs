'use strict';

const labels = { activeTurn: '活动轮次', resource: '未清理终端', uninspectedUnknown: '未核查结果',
  compaction: '上下文压缩', workgroup: '未结算工作组', activeGoal: '活动目标', queuedMessage: '待发消息', activeTask: '活动任务' };
const unknown = () => ({ allowed: false, reasons: [{ code: 'unknown', count: 1 }] });
const recoveryReads = new Set(['server', 'inspect', 'context', 'plan', 'processes', 'process', 'processOutput', 'goal', 'task', 'tasks', 'interactions', 'executions', 'execution']);
const isRecoveryCommand = (name, request) => name === 'manage'
  && (recoveryReads.has(request?.operation) || request?.operation === 'toolAcknowledge');
function decision(value) {
  if (typeof value?.allowed !== 'boolean' || !Array.isArray(value.reasons)
    || value.reasons.some(r => !Object.hasOwn(labels, r.code) || !Number.isSafeInteger(r.count) || r.count <= 0)
    || value.allowed !== (value.reasons.length === 0)) return unknown();
  return value;
}
function coreLifecycle(status) {
  if (status.lifecycle !== undefined) {
    if (status.lifecycle?.version !== 1 || !['open', 'draining', 'closed'].includes(status.lifecycle.admission))
      return { ifIdle: unknown(), settled: unknown(), admission: 'unknown' };
    return { ...status.lifecycle, ifIdle: decision(status.lifecycle.ifIdle), settled: decision(status.lifecycle.settled) };
  }
  // 已知 v1 Core 的旧字段；缺字段不能被当成空闲。
  const settled = status.restartSafe === true ? { allowed: true, reasons: [] } : unknown();
  if (typeof status.restartSafe !== 'boolean' || !Array.isArray(status.activeGoals)
    || !Number.isSafeInteger(status.pendingQueueItems) || status.pendingQueueItems < 0
    || !Number.isSafeInteger(status.activeTasks) || status.activeTasks < 0)
    return { ifIdle: unknown(), settled, admission: 'unknown' };
  const reasons = [...settled.reasons];
  for (const [code, count] of [['activeGoal', status.activeGoals.length], ['queuedMessage', status.pendingQueueItems], ['activeTask', status.activeTasks]])
    if (count > 0) reasons.push({ code, count });
  return { ifIdle: { allowed: reasons.length === 0, reasons }, settled,
    admission: status.draining === true ? 'draining' : status.closed === true ? 'closed' : 'open' };
}
function desktopBlockers(service, forUpdate = true) {
  return [forUpdate && service.clients > 1 && 'peerGui', service.activeCommands > 0 && 'inflight',
    service.providerUpdating && 'providerUpdating', service.starting > 0 && 'starting'].filter(Boolean);
}
const blockerMessage = blockers => blockers.map(code => ({ peerGui: '请先退出其他 GUI', inflight: '请等待已提交操作完成',
  providerUpdating: '请等待模型配置更新完成', starting: '请等待项目启动完成' })[code] ?? '请等待后台状态核对').join('；');
function recoveryView(service, projects, forUpdate = true) {
  const blockers = desktopBlockers(service, forUpdate);
  const unsafe = projects.some(p => p.lifecycle ? !p.lifecycle.ifIdle.allowed
    : !p.restartSafe || p.activeTasks || p.goalThreads?.length || p.waitingMessages);
  return { blockers, ifIdle: !blockers.length && !unsafe && !service.busy && !service.stopReport,
    cancel: !blockers.length && (unsafe || service.busy || !!service.stopReport), projects, service };
}
function targets(projects) {
  return projects.map(p => ({ projectId: p.projectId, serviceId: p.serviceId ?? null, generation: p.generation ?? null }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
}
function describe(projects) {
  return projects.flatMap(p => (p.lifecycle?.ifIdle.reasons ?? []).map(r => `${p.root ?? p.projectId}：${labels[r.code] ?? '状态待核查'} ${r.count}`)).join('\n');
}
class DesktopLifecycle {
  constructor({ connection, metadata, home, notify, forUpdate = true }) {
    this.connection = connection; this.metadata = metadata; this.home = home;
    this.notify = notify; this.forUpdate = forUpdate;
  }
  async observe() {
    const projects = await this.connection.request('resources', { operation: 'inspect', includeTasks: true });
    const { service } = await this.connection.request('snapshot');
    return { ...recoveryView(service, projects, this.forUpdate), targets: targets(service.targets ?? projects) };
  }
  async stop({ mode = 'ifIdle', observed } = {}) {
    if (!['ifIdle', 'cancel'].includes(mode)) throw new Error('无效的停止意图');
    const before = observed ?? await this.observe();
    if (mode === 'cancel') {
      if (!this.notify) throw new Error('取消后台任务需要原生确认');
      const answer = await this.notify({ type: 'warning', message: '确认取消后台任务？',
        detail: '将取消所列工作区后台的活动执行，并暂停目标；待发送输入、安排和历史保留。UNKNOWN 或未清理资源仍可能阻止退出。\n\n'
          + before.projects.map(p => p.root ?? p.projectId).join('\n'),
        buttons: ['返回', '取消任务并停止'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return { kind: 'dismissed', canceled: true };
    }
    const current = await this.observe();
    if (!require('node:util').isDeepStrictEqual(before.targets, current.targets))
      throw Object.assign(new Error('后台实例或项目范围已变化，请重新确认'), { code: 'CONFIRMATION_STALE' });
    if (current.blockers.length) throw Object.assign(new Error(blockerMessage(current.blockers)), { code: 'LIFECYCLE_BLOCKED' });
    let result;
    try {
      result = await this.connection.request('stopService', { protocol: this.metadata.protocol,
        forUpdate: this.forUpdate, cancel: mode === 'cancel',
        ...(current.service.lifecycleVersion === 1 ? { expectedTargets: current.targets } : {}) }, true);
    } catch (error) {
      if (error.lifecycle?.phase === 'incomplete') error.submissionUnknown = true;
      throw error;
    }
    if (result?.stopped !== true) throw Object.assign(new Error('停止结果待核对，不会自动重发'), { submissionUnknown: true });
    if (!Number.isSafeInteger(this.metadata.pid) || this.metadata.pid <= 1)
      throw Object.assign(new Error('后台进程身份不完整，退出尚未确认'), { submissionUnknown: true });
    try { await require('./service-client.cjs').waitForServiceProcessExit(this.home, this.metadata); }
    catch (error) { error.submissionUnknown = true; throw error; }
    return { ...result, kind: 'exited' };
  }
}
module.exports = { coreLifecycle, desktopBlockers, blockerMessage, recoveryView, targets, describe, DesktopLifecycle, isRecoveryCommand };
