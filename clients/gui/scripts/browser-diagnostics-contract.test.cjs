'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validToolInput } = require('../app/src/core/browser-tool.cjs');

test('browser_v1 exposes a bounded diagnostics read without script or unbounded options', () => {
  const pageId = '12345678-1234-1234-1234-123456789abc';
  assert.equal(validToolInput({ operation: 'diagnostics', parameters: { pageId, kind: 'console', limit: 50 } }), true);
  assert.equal(validToolInput({ operation: 'diagnostics', parameters: { pageId, kind: 'network', cursor: 2, limit: 200 } }), true);
  for (const parameters of [
    { pageId, kind: 'network', limit: 201 },
    { pageId, kind: 'network', cursor: -1 },
    { pageId, kind: 'network', script: 'fetch("/private")' },
    { pageId, kind: 'headers' },
  ]) assert.equal(validToolInput({ operation: 'diagnostics', parameters }), false);
});

// 纯控制契约使用最小依赖替身；原生输入行为由桌面验收覆盖。
const Module = require('node:module');
const load = Module._load;
let CorePreview;
try {
  Module._load = function (id, ...args) {
    if (id === '@areal/workbench/desktop-contract') return { validatePreview() {} };
    return load.call(this, id, ...args);
  };
  ({ CorePreview } = require('../app/src/core/preview.cjs'));
} finally { Module._load = load; }

test('direct human input fences before drain and delivers only after convergence', async () => {
  const log = [];
  let finish;
  const drained = new Promise(resolve => { finish = resolve; });
  const c = { isDestroyed: () => false, sendInputEvent: input => log.push(input.type), focus() {} };
  const page = { id: 'page', coreInstanceId: 'core', projectId: 'project', threadId: 'thread',
    control: 'agent', controlEpoch: 2, pageGeneration: 1, documentGeneration: 1,
    requestedVisible: true, view: { webContents: c, getBounds: () => ({ width: 500, height: 300 }) } };
  const preview = Object.create(CorePreview.prototype);
  Object.assign(preview, { page: () => page, pageStillOwned: () => true,
    owner: JSON.stringify(['core', 'project', 'thread', 'page']),
    selected: new Map([[JSON.stringify(['core', 'project', 'thread']), 'page']]),
    window: { isVisible: () => true, isMinimized: () => false, isFocused: () => true },
    revoke: () => { log.push('fence'); page.control = 'transferring'; page.controlEpoch++; },
    convergeInput: async () => { await drained; page.control = 'human'; }, state: () => ({}) });
  const pending = preview.humanInput('project', 'thread', 'page', { type: 'mouseDown', x: 10, y: 12, button: 'left' });
  assert.deepEqual(log, ['fence']);
  preview.revoke = () => {};
  const up = preview.humanInput('project', 'thread', 'page', { type: 'mouseUp', x: 10, y: 12, button: 'left' });
  finish(); await Promise.all([pending, up]);
  assert.deepEqual(log, ['fence', 'mouseDown', 'mouseUp']);
});

test('human input never delivers to a replacement document while draining', async () => {
  let finish;
  const page = { id: 'page', coreInstanceId: 'core', projectId: 'project', threadId: 'thread',
    control: 'agent', controlEpoch: 1, pageGeneration: 1, documentGeneration: 1, requestedVisible: true,
    view: { webContents: { isDestroyed: () => false, sendInputEvent: () => assert.fail('stale input delivered') },
      getBounds: () => ({ width: 500, height: 300 }) } };
  const preview = Object.create(CorePreview.prototype);
  Object.assign(preview, { page: () => page, pageStillOwned: () => true,
    owner: JSON.stringify(['core', 'project', 'thread', 'page']),
    selected: new Map([[JSON.stringify(['core', 'project', 'thread']), 'page']]),
    window: { isVisible: () => true, isMinimized: () => false, isFocused: () => true },
    revoke: () => { page.control = 'transferring'; page.controlEpoch++; },
    convergeInput: () => new Promise(resolve => { finish = () => { page.control = 'human'; resolve(); }; }), state: () => ({}) });
  const pending = preview.humanInput('project', 'thread', 'page', { type: 'keyDown', keyCode: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  page.documentGeneration++; finish();
  await assert.rejects(pending, /页面|input/);
});

test('keyDown and character are queued ahead of a physical keyUp during drain', async () => {
  const log = [];
  let finish;
  const drained = new Promise(resolve => { finish = resolve; });
  const preview = Object.create(CorePreview.prototype);
  preview.humanInput = async (_project, _thread, _page, input) => { log.push(input.type); await drained; };
  const page = { projectId: 'project', threadId: 'thread', id: 'page' };
  const down = preview.humanKey(page, { type: 'keyDown', key: 'a' });
  const up = preview.humanKey(page, { type: 'keyUp', key: 'a' });
  assert.deepEqual(log, ['keyDown', 'char', 'keyUp']);
  finish(); await Promise.all([down, up]);
});

test('takeover drains prior native receipts before releasing held key and mouse', async () => {
  const log = [];
  let finish;
  const receipt = new Promise(resolve => { finish = resolve; });
  const page = { control: 'transferring', controlEpoch: 3, requestedVisible: true,
    coreInstanceId: 'core', projectId: 'project', threadId: 'thread', id: 'page',
    heldKeys: new Map([['a', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }]]),
    heldButtons: new Map([['left', { x: 10, y: 12 }]]), inputPending: new Set([receipt]) };
  receipt.then(() => page.inputPending.delete(receipt));
  page.view = { setVisible() {}, webContents: { isDestroyed: () => false,
    debugger: { isAttached: () => true, sendCommand: async (method, params) => { log.push([method, params.type]); },
      detach: () => log.push(['detach']) } } };
  const preview = Object.create(CorePreview.prototype);
  Object.assign(preview, { pageStillOwned: () => true, changed() {},
    owner: JSON.stringify(['core', 'project', 'thread', 'page']) });
  const pending = preview.convergeInput(page);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, []); assert.equal(page.control, 'transferring');
  finish(); await pending;
  assert.deepEqual(log, [['Input.dispatchKeyEvent', 'keyUp'], ['Input.dispatchMouseEvent', 'mouseReleased'], ['detach']]);
  assert.equal(page.control, 'human');
  assert.equal(page.heldKeys.size + page.heldButtons.size + page.inputPending.size, 0);
});
