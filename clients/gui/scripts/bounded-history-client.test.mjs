import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { CoreTaskModel } from '../packages/workbench/client/core-model.js';
import { createHash } from 'node:crypto';
import { CoreClient } from '../packages/runtime-client/core.js';
const require = createRequire(import.meta.url);
const { CoreBackend } = require('../app/src/core/backend.cjs');
const { validateCommand, commandSemantics } = require('../packages/workbench/client/desktop-contract.cjs');
const { workspaceCommand } = require('../app/src/core/workspace.cjs');

const item = (id, text = id) => ({ id, type: 'agentMessage', text });
const turn = (id, items, status = 'completed') => ({ id, items, status });
const entry = (turnId, value) => ({ sourceThreadId: 'thread', sourceTurnId: turnId,
  sourceItemId: value.id, sourceTurnStatus: 'completed', turn: { id: turnId, status: 'completed' }, item: value });
const baseline = (archived = false) => ({ thread: { id: 'thread', status: { type: 'idle' },
  turns: [turn('t2', [item('i2')])], desktop: { archived, configuration: { revision: 1 }, queue: { revision: 1, items: [] }, interactions: [], interactionRevision: 1 } },
  history: { snapshotId: 'snapshot', nextCursor: 'older', complete: false } });
function fixture(read, { archived = false, bounded = true, afterResult = () => {} } = {}) {
  const calls = [];
  const project = { id: 'project', model: new CoreTaskModel(), configurations: {}, summaries: [{ id: 'thread', desktop: { archived } }], connectionGeneration: 1 };
  const backend = Object.assign(Object.create(CoreBackend.prototype), { projects: new Map([['project', project]]), starting: new Map(),
    onChange() {}, providers: { redact: value => value }, lifecycleOperations: { activeTargets: new Set(), blocking: () => false },
    start: async () => project });
  project.client = { ready: true, closed: false,
    capabilities: { methods: ['areal/thread/observe', 'areal/conversation/history', 'areal/subscription/remove'], features: { boundedObservation: bounded, boundedHistory: bounded } },
    request: async (method, params, options) => {
      calls.push({ method, params, maxResponseBytes: options?.maxResponseBytes });
      const value = method === 'areal/interaction/list' ? { revision: 1, data: [] }
        : method === 'areal/thread/inspect' ? { configuration: { revision: 1 } }
        : method === 'areal/queue/list' ? { revision: 1, items: [] }
        : await read(method, params, options);
      options?.onResult?.(value);
      afterResult(method, value);
      return value;
    } };
  const history = (operation, extra = {}) => backend.executeCommand('history', { projectId: 'project', threadId: 'thread', viewId: 'view-a', operation, ...extra });
  return { backend, project, calls, history };
}

test('history capability is a validated read with an explicit view owner', () => {
  assert.equal(commandSemantics('history', { operation: 'loadOlder' }).effect, 'read');
  validateCommand('history', { projectId: 'p', threadId: 't', viewId: 'v', operation: 'acquire' });
  for (const extra of [{ viewId: '' }, { operation: 'execute' }, { maxBytes: 2 ** 21 }, { cursor: 'unowned-cursor' }])
    assert.throws(() => validateCommand('history', { projectId: 'p', threadId: 't', viewId: 'v', operation: 'loadOlder', ...extra }));
});

test('completing more live history re-bounds a view even after an explicit old item was loaded', async () => {
  const f = fixture(async () => baseline());
  await f.backend.openThread(f.project, 'thread'); await f.history('acquire');
  const window = f.backend.historyWindow(f.project, 'thread');
  window.loaded.set('i2', { bytes: 2000000, placeholder: { id: 'i2', type: 'historyDeferred' } });
  f.project.model.replace({ ...baseline().thread, turns: [turn('t2', [item('i2', 'x'.repeat(2000000))])] });
  f.project.client.close = () => {};
  const request = f.project.client.request, originalConnect = CoreClient.prototype.connect;
  Object.assign(f.backend, { stopReconciliation() {}, scheduleReconciliation() {}, listThreads: async () => {},
    analytics: { observe() {} }, notifications: { observe() {} }, library: { value: {}, recordThreadActivity: async () => {} },
    providers: { ...f.backend.providers, requestReconciliation() {} } });
  CoreClient.prototype.connect = async () => { throw new Error('fixture stops before transport'); };
  try { await assert.rejects(f.backend.connect(f.project), /fixture stops/); }
  finally { CoreClient.prototype.connect = originalConnect; }
  const client = f.project.client;
  Object.assign(client, { ready: true, capabilities: { methods: ['areal/thread/observe'], features: { boundedObservation: true, boundedHistory: true } }, request });
  for (const notify of client.listeners) notify('turn/completed', { threadId: 'thread', turn: turn('next', [item('next', 'y'.repeat(2000000))]) });
  await new Promise(resolve => setImmediate(resolve));
  await f.project.observationReads?.get('thread')?.promise;
  assert.ok(Buffer.byteLength(JSON.stringify(f.project.model.state.threads.thread)) < 1048576, 'completed live history cannot bypass the bound because another item was loaded');
  assert.equal(f.backend.historyWindow(f.project, 'thread').loaded.size, 0, 'refresh returns explicit content to the Core-owned read window');
});

test('a requested loaded tool can be reviewed while an unrelated tool remains deferred', async () => {
  const f = fixture(async () => baseline());
  f.backend.saved = [{ id: 'project', root: '/fixture' }];
  f.project.model.replace({ ...baseline().thread, turns: [turn('t2', [
    { id: 'loaded', type: 'dynamicToolCall', tool: 'fs_create', status: 'completed', success: true,
      execution: { backend: 'runtime', outcome: 'succeeded' }, arguments: { path: 'workspace://repo/test.txt', text: 'hello' },
      contentItems: [{ type: 'text', text: JSON.stringify({ path: 'workspace://repo/test.txt', size: 5, sha256: createHash('sha256').update('hello').digest('hex') }) }] },
    { id: 'other', type: 'historyDeferred', originalType: 'dynamicToolCall' },
  ])] });
  const request = { operation: 'turnReview', projectId: 'project', threadId: 'thread', turnId: 't2' };
  assert.equal((await workspaceCommand(f.backend, { ...request, itemId: 'loaded' })).files[0].afterText, 'hello');
  await assert.rejects(workspaceCommand(f.backend, request), /完整工具内容/);
});

for (const archived of [false, true]) test(`bounded baseline is negotiated before synchronous install (archived=${archived})`, async () => {
  const f = fixture(async (method, params) => {
    assert.equal(method, 'areal/thread/observe');
    assert.equal(params.mode, 'bounded');
    assert.ok(params.maxBytes <= 1048576);
    return baseline(archived);
  }, { archived, afterResult(method) {
    if (method !== 'areal/thread/observe') return;
    f.project.model.event('turn/started', { threadId: 'thread', turn: turn('t3', [], 'inProgress') });
    f.project.model.event('item/agentMessage/delta', { threadId: 'thread', turnId: 't3', itemId: 'i3', delta: 'live' });
  } });
  await f.backend.openThread(f.project, 'thread');
  assert.equal(f.project.model.state.threads.thread.turns.at(-1).items[0].text, 'live');
  assert.equal(f.calls.some(call => call.method === 'thread/read'), false);
});

test('older own page merges by IDs without overwriting a live delta', async () => {
  const f = fixture(async (method, params) => {
    if (method === 'areal/thread/observe') return baseline();
    assert.equal(method, 'areal/conversation/history'); assert.equal(params.view, 'own');
    f.project.model.event('item/agentMessage/delta', { threadId: 'thread', turnId: 't2', itemId: 'i2', delta: ':new' });
    return { snapshotId: 'snapshot', data: [entry('t1', item('i0')), entry('t1', item('i1'))], nextCursor: null, complete: true };
  });
  await f.backend.openThread(f.project, 'thread'); await f.history('acquire'); await f.history('loadOlder');
  assert.deepEqual(f.project.model.state.threads.thread.turns.flatMap(t => t.items.map(i => i.id)), ['i0', 'i1', 'i2']);
  assert.equal(f.project.model.state.threads.thread.turns.at(-1).items[0].text, 'i2:new');
});

test('explicit item loading validates UTF8 fragments and release does not discard another view', async () => {
  const value = entry('t2', item('i2', '雪\\\"🙂'.repeat(90000)));
  const bytes = Buffer.from(JSON.stringify(value));
  let offset = 0, reads = 0;
  const f = fixture(async (method, params) => {
    if (method === 'areal/thread/observe') {
      const result = baseline(); result.thread.turns[0].items = [{ type: 'historyDeferred', id: 'i2', originalType: 'agentMessage', version: 'v1', cursor: 'item:0', totalBytes: bytes.length }]; return result;
    }
    assert.equal(method, 'areal/conversation/history'); assert.equal(params.maxBytes, 1048576, 'explicit content uses the negotiated maximum fragment budget'); reads++;
    let end = Math.min(offset + 20000, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const text = bytes.subarray(offset, end).toString();
    const fragment = { version: 'v1', offsetUtf8: offset, totalBytes: bytes.length, text };
    offset = end;
    return { snapshotId: 'snapshot', data: [{ sourceThreadId: 'thread', sourceTurnId: 't2', sourceItemId: 'i2', fragment }], nextCursor: offset < bytes.length ? `item:${offset}` : null, complete: offset === bytes.length };
  });
  await f.backend.openThread(f.project, 'thread'); await f.history('acquire');
  await f.history('acquire', { viewId: 'view-b' });
  assert.equal(reads, 0, 'opening a view must not eagerly materialize huge content');
  await f.history('loadItem', { itemId: 'i2' });
  assert.deepEqual(f.project.model.state.threads.thread.turns[0].items[0], value.item);
  await f.history('release');
  assert.equal(f.calls.some(call => call.method === 'areal/subscription/remove'), false);
  assert.deepEqual(f.project.model.state.threads.thread.turns[0].items[0], value.item);
  await f.history('release', { viewId: 'view-b' });
  assert.equal(f.project.model.state.threads.thread.turns[0].items[0].type, 'historyDeferred');
});

test('metadata budget retries exactly once at the supported maximum', async () => {
  let observations = 0;
  const f = fixture(async (method, params) => {
    assert.equal(method, 'areal/thread/observe'); observations++;
    assert.equal(params.maxBytes, observations === 1 ? 262144 : 1048576);
    throw Object.assign(new Error('metadata too large'), { code: -32012, reason: 'HISTORY_BUDGET_TOO_SMALL', recovery: { kind: 'none' } });
  });
  await assert.rejects(f.backend.openThread(f.project, 'thread'), /metadata too large/);
  assert.equal(observations, 2);
});

test('stale old page resets its display window without retrying a mutation', async () => {
  let observations = 0;
  const f = fixture(async method => {
    if (method === 'areal/thread/observe') { observations++; const value = baseline(); if (observations > 1) value.thread.turns = [turn('edited', [item('edited')])]; return value; }
    assert.equal(method, 'areal/conversation/history');
    throw Object.assign(new Error('history edited'), { code: -32012, reason: 'HISTORY_CURSOR_STALE', data: { reset: true, reason: 'HISTORY_CURSOR_STALE' } });
  });
  await f.backend.openThread(f.project, 'thread'); await f.history('acquire');
  await f.history('loadOlder').catch(() => {});
  assert.deepEqual(f.project.model.state.threads.thread.turns.flatMap(t => t.items.map(i => i.id)), ['edited']);
  assert.equal(f.calls.some(call => /submit|start|steer/.test(call.method)), false);
});

test('changed item restarts once and never mixes two serialized versions', async () => {
  const value = entry('t2', item('i2', '新版本🙂'));
  const json = JSON.stringify(value);
  let reads = 0;
  const f = fixture(async (method, params) => {
    if (method === 'areal/thread/observe') {
      const result = baseline(); result.thread.turns[0].items = [{ type: 'historyDeferred', id: 'i2', originalType: 'agentMessage', version: 'old', cursor: 'old:0', totalBytes: 1000 }]; return result;
    }
    reads++;
    if (reads === 1) throw Object.assign(new Error('changed'), { code: -32012, reason: 'HISTORY_ITEM_CHANGED', data: { restartCursor: 'new:0', reason: 'HISTORY_ITEM_CHANGED' } });
    assert.equal(params.cursor, 'new:0');
    return { snapshotId: 'snapshot', data: [{ sourceThreadId: 'thread', sourceTurnId: 't2', sourceItemId: 'i2', fragment: { offsetUtf8: 0, version: 'new', totalBytes: Buffer.byteLength(json), text: json } }], complete: true, nextCursor: null };
  });
  await f.backend.openThread(f.project, 'thread'); await f.history('acquire'); await f.history('loadItem', { itemId: 'i2' });
  assert.equal(reads, 2);
  assert.deepEqual(f.project.model.state.threads.thread.turns[0].items[0], value.item);
});

test('retained old-page window stays finite and reports its omitted interval', async () => {
  let reads = 0;
  const f = fixture(async method => {
    if (method === 'areal/thread/observe') return baseline();
    reads++;
    return { snapshotId: 'snapshot', data: [entry(`old-${reads}`, item(`old-${reads}`, 'x'.repeat(100000)))], nextCursor: `page:${reads}`, complete: false };
  });
  await f.backend.openThread(f.project, 'thread'); await f.history('acquire');
  for (let n = 0; n < 12; n++) await f.history('loadOlder');
  const thread = f.project.model.state.threads.thread;
  assert.ok(Buffer.byteLength(JSON.stringify(thread)) < 5 * 262144);
  assert.equal(thread.displayHistory.omitted, true);
  assert.equal(thread.turns.at(-1).items[0].id, 'i2', 'latest live window remains visible');
  await f.history('release');
  assert.deepEqual(f.project.model.state.threads.thread.turns.flatMap(t => t.items.map(i => i.id)), ['i2']);
});
