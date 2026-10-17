'use strict';
const { ServiceConnection } = require('./service-client.cjs');
const { DesktopLifecycle, assertLifecycleSupport, blockerMessage, describe } = require('./lifecycle.cjs');
const { PROTOCOL } = require('./service-protocol.cjs');

async function recoverStartupService({ metadata, home }) {
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity });
    await new DesktopLifecycle({ connection, metadata, home }).observe();
    return { kind: 'reconnect-existing' };
  } finally { connection.close(); }
}

async function recoverConnectedService({ backend, notify, purpose = 'stop', forUpdate = false }) {
  const observed = await backend.observeLifecycle(true);
  const kind = purpose === 'update' || forUpdate ? 'updateDesktop' : 'stopDesktop';
  assertLifecycleSupport(observed.service, kind);
  if (observed.blockers.length) throw Object.assign(new Error(blockerMessage(observed.blockers)), { code: 'LIFECYCLE_BLOCKED' });
  const cancel = !observed.ifIdle;
  if (cancel) {
    if (!notify) throw Object.assign(new Error('取消后台任务需要原生确认'), { code: 'LIFECYCLE_CONFIRMATION_REQUIRED' });
    const answer = await notify({ type: 'warning', message: '确认取消后台任务？',
      detail: '将取消所列工作区后台的活动执行，并暂停目标。待发送输入、安排和历史保留。未完成的资源清理仍可能阻止退出。\n\n'
        + (describe(observed.projects) || observed.projects.map(project => project.root ?? project.projectId).join('\n')),
      buttons: ['返回', purpose === 'update' ? '取消任务并更新' : '取消任务并停止'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return { kind: 'dismissed', canceled: true };
  }
  return backend.stopService(forUpdate, { cancel, observed, kind });
}
module.exports = { recoverStartupService, recoverConnectedService };
