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

async function recoverConnectedService({ backend, notify, purpose = 'stop', forUpdate = false, migration }) {
  const observed = await backend.observeLifecycle(true);
  const kind = purpose === 'update' || forUpdate ? 'updateDesktop' : 'stopDesktop';
  assertLifecycleSupport(observed.service, kind);
  if (observed.blockers.length) throw Object.assign(new Error(blockerMessage(observed.blockers)), { code: 'LIFECYCLE_BLOCKED' });
  const cancel = !observed.ifIdle;
  const retainedServices = purpose === 'quit' && (observed.service.remote?.enabled
    || observed.projects.some(project => project.tasks?.some(task => task.mode === 'scheduled' && !task.paused)));
  if (cancel || retainedServices) {
    if (!notify) throw Object.assign(new Error('取消后台任务需要原生确认'), { code: 'LIFECYCLE_CONFIRMATION_REQUIRED' });
    const answer = await notify({ type: 'warning', message: purpose === 'quit' ? cancel ? '停止任务并退出应用？' : '退出应用并暂停服务？' : '确认取消后台任务？',
      detail: (cancel ? '将取消所列工作区后台的活动执行，并暂停目标。未完成的资源清理仍可能阻止退出。\n\n' : '')
        + '退出应用会停止定时安排触发并断开手机连接。安排定义、待发送输入和历史保留。\n'
        + (observed.service.remote?.enabled ? `手机入口已启用，当前连接 ${observed.service.remote.connections}。\n` : '')
        + '\n'
        + observed.projects.map(project => [project.root ?? project.projectId,
          describe([project]),
          ...(project.activeThreads ?? []).map(turn => `正在执行的会话：${turn.threadId}`),
          ...(project.goals ?? []).map(goal => `持续目标：${goal.objective ?? goal.threadId}`),
          ...(project.tasks ?? []).map(task => `任务：${task.objective ?? task.id}`),
          ...(project.resources ?? []).map(resource => `未清理资源：${resource.executable || resource.id}`),
        ].filter(Boolean).join('\n')).join('\n\n'),
      buttons: [purpose === 'quit' ? '取消退出' : '返回', purpose === 'update' ? '取消任务并更新' : purpose === 'quit' ? cancel ? '停止任务并退出' : '退出应用' : '取消任务并停止'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return { kind: 'dismissed', canceled: true };
    observed.confirmedImpact = true;
  }
  return backend.stopService(forUpdate, { cancel, observed, kind, migration });
}
module.exports = { recoverStartupService, recoverConnectedService };
