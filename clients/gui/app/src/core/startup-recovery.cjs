'use strict';
const { ServiceConnection, waitForServiceProcessExit } = require('./service-client.cjs');
const { DesktopLifecycle, describe } = require('./lifecycle.cjs');
const { PROTOCOL } = require('./service-protocol.cjs');
const { createResourceRecovery, summary } = require('./resource-recovery.cjs');
const { cancelLegacyService, legacyBusy, captureLegacySchedules, reconcileLegacySchedules, pauseLegacySchedules } = require('./legacy-service-cancel.cjs');

// 只使用旧服务的资源恢复/安全停止接口，不将其任务投影接入新 GUI。
async function recoverDesktopService({ metadata, home, notify, connection, performStop, purpose = 'startup' }) {
  const lifecycle = new DesktopLifecycle({ connection, metadata, home, notify, forUpdate: true });
  const restarting = purpose === 'startup';
  const cancelLabel = restarting ? '取消任务并重启' : '取消任务并停止';
  try {
    const recoverResources = createResourceRecovery({
      backend: { resources: request => connection.request('resources', request, request.operation !== 'inspect') }, notify,
    });
    let lastError = '', stopRejected = false;
    while (true) {
      const view = await lifecycle.observe();
      const { service, projects } = view;
      const busy = view.blockers.length > 0;
      const peers = view.blockers.includes('peerGui');
      const blocked = !view.ifIdle || stopRejected || !!service.stopReport;
      const canRecover = !busy && projects.some(p => p.resources.length);
      const schedules = service.lifecycleVersion === 1 ? [] : projects.flatMap(p => p.goalThreads?.length ? [] : (p.tasks ?? [])
        .filter(t => t.mode === 'scheduled' && !t.paused && !t.running).map(t => ({ projectId: p.projectId, taskId: t.id })));
      const canPause = !busy && schedules.length > 0;
      const canCancel = view.cancel;
      const stop = mode => performStop ? performStop(mode, view) : lifecycle.stop({ mode, observed: view });
      const detail = [
        restarting ? '检测到另一版本或启动配置的后台服务。安全重启后继续打开应用，已有模型配置和历史记录会保留。'
          : '检查共享后台的执行和资源状态。安全停止后所有窗口将断开后台连接，已有模型配置和历史记录会保留。',
        peers && '请先退出其他连接此后台的 GUI。',
        busy && '后台仍有任务、排队消息或操作，请等待完成后重试。',
        canPause && `存在 ${schedules.length} 个等待触发的定时安排，旧后台可能要求先临时暂停安排才能安全退出。恢复记录会保留，新后台核对身份和修订号后恢复安排的启用状态，不恢复已暂停的 Run。`,
        canRecover && '受管终端阻止后台重启。请检查并关闭不再需要的终端，然后重新检查。',
        describe(projects) || summary(projects), lastError,
      ].filter(Boolean).join('\n\n');
      const buttons = blocked ? ['稍后处理', '重新检查', ...(canRecover ? ['检查后台资源…'] : []), ...(canPause ? ['暂停定时安排…'] : []), ...(canCancel ? [cancelLabel] : [])] : ['稍后处理', restarting ? '重启后台并继续' : '停止后台服务'];
      const answer = await notify({ type: blocked ? 'warning' : 'question', message: blocked ? restarting ? '后台暂时无法重启' : '后台暂时无法停止' : restarting ? '需要重启后台服务' : '停止共享后台服务？', detail, buttons, defaultId: canRecover ? 2 : 1, cancelId: 0, noLink: true });
      if (answer.response === 0 && purpose !== 'startup') return { kind: 'dismissed', canceled: true };
      if (answer.response === 0) throw Object.assign(new Error('后台连接已暂缓，原后台保持运行。可重新检查并处理后台资源。'), { code: 'STARTUP_CANCELLED' });
      lastError = ''; stopRejected = false;
      if (blocked) {
        if (buttons[answer.response] === '检查后台资源…') await recoverResources();
        if (buttons[answer.response] === '暂停定时安排…') {
          const confirmation = await notify({ type: 'warning', message: '暂停定时安排以恢复启动？',
            detail: `将临时暂停 ${schedules.length} 个定时安排的后续触发，不删除安排或历史。恢复记录会在写入前保存，新后台核对原任务后恢复安排；暂停的 Run 保持暂停，未知回执不会自动重发。`,
            buttons: ['返回', '暂停安排'], defaultId: 0, cancelId: 0, noLink: true });
          if (confirmation.response === 1) {
            try { await pauseLegacySchedules({ connection, home, metadata }); }
            catch (error) { if (error.submissionUnknown || error.code === 'DISCONNECTED') throw error; lastError = error.message; }
          }
        }
        const cancelIndex = buttons.indexOf(cancelLabel);
        if (canCancel && answer.response === cancelIndex) {
          try {
            const result = await stop('cancel');
            if (result.kind === 'dismissed') continue;
            return result;
          } catch (error) {
            if (error.submissionUnknown || error.code === 'DISCONNECTED') throw error;
            if (!legacyBusy(error, service)) { lastError = error.message; continue; }
            try {
              // 旧后台忽略 cancel 字段；直接取消旧 Core 后仍走原有安全退出。
              await captureLegacySchedules({ connection, home, metadata });
              await cancelLegacyService({ connection, home });
              await reconcileLegacySchedules({ connection, home });
              try { await connection.request('stopService', { protocol: PROTOCOL, forUpdate: true }, true); }
              catch (stopError) {
                if (!legacyBusy(stopError, service)) throw stopError;
                await pauseLegacySchedules({ connection, home, metadata });
                await connection.request('stopService', { protocol: PROTOCOL, forUpdate: true }, true);
              }
              await waitForServiceProcessExit(home, metadata);
              return { stopped: true, cancelled: true, kind: 'exited' };
            } catch (fallbackError) {
              if (fallbackError.submissionUnknown || fallbackError.code === 'DISCONNECTED') throw fallbackError;
              lastError = `${error.message}；兼容旧后台取消失败：${fallbackError.message}。已写入的安排恢复记录会保留，请核对后继续。`;
            }
          }
        }
        continue;
      }
      try {
        // 此控制连接已经 hello，forUpdate 可在服务端挡住竞态中新连入的其他 GUI。
        const result = await stop('ifIdle');
        return result;
      } catch (error) {
        if (error.submissionUnknown || error.code === 'DISCONNECTED') throw error;
        lastError = error.message.includes('service is busy; wait for work to settle or stop with --cancel')
          ? 'Core 仍有活动目标、排队消息或后台任务，请等待完成或先暂停相关任务后重试。' : error.message;
        stopRejected = true; continue;
      }
    }
  } catch (error) {
    // 服务可能在检查期间已由原 GUI 正常停止，交给启动路径重新发现。
    if (error.code === 'DISCONNECTED' && !error.submissionUnknown) return;
    throw error;
  }
}
async function recoverStartupService({ metadata, home, notify }) {
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity });
    return await recoverDesktopService({ metadata, home, notify, connection });
  } finally { connection.close(); }
}
async function recoverConnectedService({ backend, notify, purpose = 'stop', forUpdate = false }) {
  return recoverDesktopService({ metadata: backend.metadata, home: backend.home, connection: backend.connection,
    notify, purpose, performStop: (mode, observed) => backend.stopService(forUpdate, { cancel: mode === 'cancel', notify, observed }) });
}
module.exports = { recoverStartupService, recoverConnectedService };
