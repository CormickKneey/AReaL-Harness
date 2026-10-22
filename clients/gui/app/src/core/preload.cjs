'use strict';
const { contextBridge, ipcRenderer } = require('electron');
let quitSubscription = null;
let quitProgress = { state: 'idle' };
const quitProgressListeners = new Set();
ipcRenderer.on('areal-core:quit-progress', (_event, value) => {
  if (value?.state === 'idle') quitProgress = { state: 'idle' };
  else if (value?.state === 'quitting' && ['checking', 'stopping', 'finishing'].includes(value.phase))
    quitProgress = { state: 'quitting', phase: value.phase };
  else return;
  for (const listener of quitProgressListeners) listener(quitProgress);
});
function answerQuitRequest(subscription, allowed) {
  if (subscription.pending === null) return;
  const id = subscription.pending;
  subscription.pending = null;
  ipcRenderer.send('areal-core:quit-decision', { id, allowed });
}
ipcRenderer.on('areal-core:quit-request', (_event, id) => {
  const subscription = quitSubscription;
  if (!subscription || subscription.pending !== null) {
    ipcRenderer.send('areal-core:quit-decision', { id, allowed: false });
    return;
  }
  subscription.pending = id;
  void Promise.resolve().then(() => subscription === quitSubscription ? subscription.listener() : false)
    .then(allowed => answerQuitRequest(subscription, allowed === true), () => answerQuitRequest(subscription, false));
});
contextBridge.exposeInMainWorld('arealDesktop', {
  presentReady: () => ipcRenderer.invoke('areal-core:present-ready'),
  onQuitProgress: listener => {
    quitProgressListeners.add(listener);
    listener(quitProgress);
    return () => quitProgressListeners.delete(listener);
  },
  onQuitRequested: listener => {
    if (quitSubscription) answerQuitRequest(quitSubscription, false);
    const subscription = { listener, pending: null };
    quitSubscription = subscription;
    return () => {
      if (quitSubscription === subscription) quitSubscription = null;
      answerQuitRequest(subscription, false);
    };
  },
  updateState: () => ipcRenderer.invoke('areal-core:update-state'),
  downloadUpdate: () => ipcRenderer.invoke('areal-core:update-download'),
  recoverUpdateResources: () => ipcRenderer.invoke('areal-core:update-recover-resources'),
  onUpdate: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:update-changed', handler);
    return () => ipcRenderer.removeListener('areal-core:update-changed', handler);
  },
  onMcpAppDeepLink: listener => {
    let active = true, pending = null;
    const handler = () => { void ipcRenderer.invoke('areal-core:mcp-app-deep-link-target').then(async target => {
      if (!active || !target || pending === target.id) return;
      pending = target.id;
      try { await listener(target); if (active) await ipcRenderer.invoke('areal-core:mcp-app-deep-link-consumed', target.id); }
      finally { pending = null; }
    }).catch(() => {}); };
    ipcRenderer.on('areal-core:mcp-app-deep-link', handler); handler();
    return () => { active = false; ipcRenderer.removeListener('areal-core:mcp-app-deep-link', handler); };
  },
  mcpFormResource: (operation, request) => ipcRenderer.invoke('areal-core:mcp-form-resource', operation, request),
  mcpApp: request => ipcRenderer.invoke('areal-core:mcp-app', request),
  onMcpAppEvent: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:mcp-app-event', handler);
    return () => ipcRenderer.removeListener('areal-core:mcp-app-event', handler);
  },
  preview: request => ipcRenderer.invoke('areal-core:preview', request),
  onPreviewEvent: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:preview-event', handler);
    return () => ipcRenderer.removeListener('areal-core:preview-event', handler);
  },
  snapshot: () => ipcRenderer.invoke('areal-core:snapshot'),
  chooseProject: () => ipcRenderer.invoke('areal-core:choose-project'),
  chooseTaskDirectory: () => ipcRenderer.invoke('areal-core:choose-task-directory'),
  chooseProjectlessDirectory: () => ipcRenderer.invoke('areal-core:choose-projectless-directory'),
  fileOpen: request => ipcRenderer.invoke('areal-core:file-open', request),
  command: (name, params) => ipcRenderer.invoke('areal-core:command', name, params),
  theme: id => ipcRenderer.invoke('areal-core:theme', id),
  onNotificationOpen: listener => {
    let active = true, delivered = null;
    const handler = () => { void ipcRenderer.invoke('areal-core:notification-target').then(target => {
      if (!active || !target || delivered === target.id) return;
      delivered = target.id;
      listener(target.taskId
        ? { projectId: target.projectId, taskId: target.taskId, runId: target.runId, questionId: target.questionId }
        : { projectId: target.projectId, threadId: target.threadId });
      return ipcRenderer.invoke('areal-core:notification-consumed', target.id);
    }).catch(() => {}); };
    ipcRenderer.on('areal-core:notification-open', handler);
    handler(); // A click while the renderer was loading stays pending in Main.
    return () => { active = false; ipcRenderer.removeListener('areal-core:notification-open', handler); };
  },
  requestProjection: requestId => ipcRenderer.send('areal-core:projection-request', requestId),
  onProjection: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:projection', handler);
    return () => ipcRenderer.removeListener('areal-core:projection', handler);
  },
  onTheme: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('areal-core:theme-changed', handler);
    return () => ipcRenderer.removeListener('areal-core:theme-changed', handler);
  },
});
