import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from '../renderer/node_modules/vite/dist/node/index.js';
const require = createRequire(new URL('../renderer/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const createTestServer = () => createServer({ root: fileURLToPath(new URL('../renderer/', import.meta.url)), configFile: false,
    resolve: { alias: { '@': fileURLToPath(new URL('../renderer/src/', import.meta.url)) } },
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null },
    appType: 'custom', esbuild: { jsx: 'automatic' } });

test('backend notice hides normal connected status but keeps actionable states', async () => {
  const vite = await createTestServer();
  try {
    const { BackendStatusNotice } = await vite.ssrLoadModule('/src/BackendStatusNotice.tsx');
    const render = props => renderToStaticMarkup(React.createElement(BackendStatusNotice, {
      connection: { state: 'ready' }, currentCommands: true,
      pending: false, error: '', onAction() {}, ...props,
    }));
    for (const busy of [false, true]) {
      assert.equal(render({ summary: { state: 'running', busy } }), '', 'normal status occupies no header space');
    }
    for (const [props, message, action] of [
      [{ connection: { state: 'connecting' } }, '正在连接后台…'],
      [{ connection: { state: 'unavailable' } }, '后台尚未连接', '重新连接后台'],
      [{ update: { state: 'pending' } }, '当前部署更新尚未应用', '更新后台…'],
      [{ update: { state: 'applying' } }, '正在更新后台…'],
      [{ update: { state: 'failed' } }, '后台更新失败', '更新后台…'],
      [{ currentCommands: false }, '原后台不支持新版提交', '更新后台…'],
      [{ lifecycle: { error: '生命周期操作失败' } }, '生命周期操作失败', '检查后台'],
      [{ lifecycle: { recovery: { message: '需要恢复原后台' } } }, '需要恢复原后台', '恢复后台…'],
      [{ connection: undefined, summary: { state: 'stopped', busy: false } }, '后台已停止', '后台详情'],
      [{ connection: { state: 'ready', recovery: 'check' } }, '后台状态尚未确认', '检查后台'],
    ]) {
      const html = render(props);
      assert.ok(html.includes(message), message);
      assert.match(html, /role="status"/);
      assert.match(html, /后台详情/);
      if (action) assert.ok(html.includes(action), action);
    }
  } finally { await vite.close(); }
});

test('backend notice keeps inspection read-only and exposes a new explicit update only after target uncertainty settles', async () => {
  const vite = await createTestServer();
  try {
    const { BackendStatusNotice } = await vite.ssrLoadModule('/src/BackendStatusNotice.tsx');
    const render = (phase, phases, desktopExit = 'notRequested', kind = 'updateDesktop') => renderToStaticMarkup(
      React.createElement(BackendStatusNotice, { connection: { state: 'ready' }, update: { state: 'pending' },
        lifecycle: { supported: true, operations: [], kind, phase, desktopExit,
          targets: phases.map((phase, index) => ({ projectId: String(index), phase })) },
        pending: false, error: '', onAction() {} }));
    for (const [phase, phases] of [
      ['partial', ['completed', 'blocked']], ['settlementIncomplete', ['settlementIncomplete']],
      ['acceptedPending', ['completed']],
    ]) {
      const html = render(phase, phases);
      assert.match(html, /检查后台/);
      assert.match(html, /更新后台…/);
    }
    for (const html of [render('partial', ['completed', 'admissionUnconfirmed']),
      render('acceptedPending', ['acceptedPending']), render('acceptedPending', ['completed'], 'requested')]) {
      assert.match(html, /检查后台/);
      assert.doesNotMatch(html, /更新后台…/);
    }
    assert.doesNotMatch(render('settlementIncomplete', ['settlementIncomplete'], 'notRequested', 'stopDesktop'), /更新后台…/);
  } finally { await vite.close(); }
});
