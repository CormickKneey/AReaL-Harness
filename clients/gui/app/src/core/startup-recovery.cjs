'use strict';
const { ServiceConnection, waitForServiceExit } = require('./service-client.cjs');
const { PROTOCOL } = require('./service-protocol.cjs');
const { createResourceRecovery, summary } = require('./resource-recovery.cjs');
const { cancelLegacyService } = require('./legacy-service-cancel.cjs');

// 只使用旧服务的资源恢复/安全停止接口，不将其任务投影接入新 GUI。
async function recoverStartupService({ metadata, home, notify }) {
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity });
    const recoverResources = createResourceRecovery({
      backend: { resources: request => connection.request('resources', request, request.operation !== 'inspect') }, notify,
    });
    let lastError = '', stopRejected = false;
    while (true) {
      const { service } = await connection.request('snapshot');
      const projects = await connection.request('resources', { operation: 'inspect', includeTasks: true });
      const busy = service.busy || service.activeCommands > 0 || service.providerUpdating || service.starting > 0;
      const peers = service.clients > 1;
      // Old adapters expose resource-only restartSafe. Core stop also protects
      // goals, queues and task work, so inspect their explicit counters here.
      const unsafe = projects.some(p => !p.restartSafe || p.activeTasks || p.goalThreads?.length || p.waitingMessages);
      const blocked = busy || peers || unsafe || stopRejected;
      const canRecover = !busy && !peers && projects.some(p => p.resources.length);
      const schedules = projects.flatMap(p => (p.tasks ?? []).filter(t => t.mode === 'scheduled' && !t.paused && !t.running)
        .map(t => ({ projectId: p.projectId, taskId: t.id })));
      const canPause = unsafe && !busy && !peers && schedules.length > 0;
      const canCancel = busy && !peers;
      const detail = [
        '检测到另一版本或启动配置的后台服务。安全重启后继续打开应用，已有模型配置和历史记录会保留。',
        peers && '请先退出其他连接此后台的 GUI。',
        busy && '后台仍有任务、排队消息或操作，请等待完成后重试。',
        canPause && `存在 ${schedules.length} 个等待触发的定时安排，旧后台可能要求先暂停安排后才能安全重启。安排和历史保留，打开应用后可手动恢复。`,
        canRecover && '受管终端阻止后台重启。请检查并关闭不再需要的终端，然后重新检查。',
        summary(projects), lastError,
      ].filter(Boolean).join('\n\n');
      const buttons = blocked ? ['稍后处理', '重新检查', ...(canRecover ? ['检查后台资源…'] : []), ...(canPause ? ['暂停定时安排…'] : []), ...(canCancel ? ['取消任务并重启'] : [])] : ['稍后处理', '重启后台并继续'];
      const answer = await notify({ type: blocked ? 'warning' : 'question', message: blocked ? '后台暂时无法重启' : '需要重启后台服务', detail, buttons, defaultId: canRecover ? 2 : 1, cancelId: 0, noLink: true });
      if (answer.response === 0) throw Object.assign(new Error('后台连接已暂缓，原后台保持运行。可重新检查并处理后台资源。'), { code: 'STARTUP_CANCELLED' });
      lastError = ''; stopRejected = false;
      if (blocked) {
        if (buttons[answer.response] === '检查后台资源…') await recoverResources();
        if (buttons[answer.response] === '暂停定时安排…') {
          const confirmation = await notify({ type: 'warning', message: '暂停定时安排以恢复启动？',
            detail: `将暂停 ${schedules.length} 个定时安排的后续触发，不删除安排或历史。重启后这些安排保持暂停，请在定时任务中手动恢复。`,
            buttons: ['返回', '暂停安排'], defaultId: 0, cancelId: 0, noLink: true });
          if (confirmation.response === 1) {
            for (const target of schedules) {
              const task = await connection.request('command', { name: 'manage', request: { ...target, operation: 'task' } });
              if (task.mode !== 'scheduled' || task.cancelled || task.paused) continue;
              if (task.runs.some(run => ['queued', 'running', 'waitingForInput', 'waitingForAgents'].includes(run.status))) {
                lastError = '定时任务已开始执行，请等待本次运行结束后重新检查。'; break;
              }
              // Use the old adapter's existing revision-checked task command;
              // no new recovery RPC, raw Core passthrough or automatic replay.
              try { await connection.request('command', { name: 'manage', request: { ...target, operation: 'taskPause', expectedRevision: task.revision } }, true); }
              catch (error) {
                if (error.submissionUnknown || error.code === 'DISCONNECTED') throw error;
                lastError = error.message; break;
              }
            }
          }
        }
        const cancelIndex = buttons.indexOf('取消任务并重启');
        if (canCancel && answer.response === cancelIndex) {
          const confirm = await notify({ type: 'warning', message: '确认取消后台任务？', detail: '当前活动轮次和未完成的模型/工具请求将被取消；未确认的结果会保留为 UNKNOWN。取消后将安全重启后台服务。', buttons: ['返回', '取消任务并重启'], defaultId: 0, cancelId: 0, noLink: true });
          if (confirm.response !== 1) continue;
          try {
            await connection.request('stopService', { protocol: PROTOCOL, forUpdate: true, cancel: true }, true);
            await waitForServiceExit(home, metadata);
            return;
          } catch (error) {
            if (error.submissionUnknown || error.code === 'DISCONNECTED') throw error;
            if (service.cancelStop || !error.message.startsWith('后台仍有任务')) { lastError = error.message; continue; }
            try {
              // 旧后台忽略 cancel 字段；直接取消旧 Core 后仍走原有安全退出。
              await cancelLegacyService({ connection, home });
              await connection.request('stopService', { protocol: PROTOCOL, forUpdate: true }, true);
              await waitForServiceExit(home, metadata);
              return;
            } catch (fallbackError) {
              if (fallbackError.submissionUnknown || fallbackError.code === 'DISCONNECTED') throw fallbackError;
              lastError = `${error.message}；兼容旧后台取消失败：${fallbackError.message}`;
            }
          }
        }
        continue;
      }
      try {
        // 此控制连接已经 hello，forUpdate 可在服务端挡住竞态中新连入的其他 GUI。
        await connection.request('stopService', { protocol: PROTOCOL, forUpdate: true }, true);
      } catch (error) {
        if (error.submissionUnknown || error.code === 'DISCONNECTED') throw error;
        lastError = error.message.includes('service is busy; wait for work to settle or stop with --cancel')
          ? 'Core 仍有活动目标、排队消息或后台任务，请等待完成或先暂停相关任务后重试。' : error.message;
        stopRejected = true; continue;
      }
      // 等待旧所有者撤回元数据，不删除锁或连接文件，也不向旧任务重放请求。
      await waitForServiceExit(home, metadata);
      return;
    }
  } catch (error) {
    // 服务可能在检查期间已由原 GUI 正常停止，交给启动路径重新发现。
    if (error.code === 'DISCONNECTED' && !error.submissionUnknown) return;
    throw error;
  } finally { connection.close(); }
}
module.exports = { recoverStartupService };
