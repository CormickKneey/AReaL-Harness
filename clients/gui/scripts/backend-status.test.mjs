import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from '../renderer/node_modules/vite/dist/node/index.js';
const require = createRequire(new URL('../renderer/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

test('backend notice keeps inspection read-only and exposes a new explicit update only after target uncertainty settles', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../renderer/', import.meta.url)), configFile: false,
    resolve: { alias: { '@': fileURLToPath(new URL('../renderer/src/', import.meta.url)) } },
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null },
    appType: 'custom', esbuild: { jsx: 'automatic' } });
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
