import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CoreBackend } = require('../app/src/core/backend.cjs');
const home = await mkdtemp(join(tmpdir(), 'areal-fork-recovery-'));
try {
  const backend = Object.create(CoreBackend.prototype);
  backend.home = home;
  backend.saves = new Map();
  backend.awaitingResponses = new WeakSet();
  backend.onChange = () => {};
  backend.closing = false;
  const entry = { method: 'areal/thread/fork', params: {
    requestId: 'fork-key', sourceThreadId: 'source', anchor: { turnId: 'turn', boundary: 'after' }, workspaceMode: 'sharedCurrent',
  } };
  let receipt;
  const requests = [];
  const client = { closed: false, request: async (method, params) => {
    requests.push([method, params]);
    assert.equal(method, 'areal/request/read');
    return { data: receipt ? [{ method: entry.method, result: { threadId: 'created-fork' } }] : [] };
  } };
  const project = { id: 'project', pending: [entry], outcomes: {}, client };
  const opened = [];
  backend.openThread = async (_project, id) => { opened.push(id); };
  backend.listThreads = async () => {};

  // 查不到账不代表创建未发生；本地日志和原业务键必须保留。
  await backend.reconcile(project);
  assert.equal(project.pending.length, 1);
  assert.equal(project.outcomes['fork-key'], undefined);
  assert.deepEqual(opened, []);
  await assert.rejects(() => backend.submit(project, 'areal/thread/fork', {
    sourceThreadId: 'source', anchor: { turnId: 'turn', boundary: 'after' }, workspaceMode: 'sharedCurrent',
  }, { requestId: '12345678-1234-1234-1234-123456789abc' }), /查询受理结果/);
  assert.equal(project.pending.length, 1);
  assert.equal(requests.length, 1, '未知时没有重发创建请求');

  receipt = true;
  await backend.reconcile(project);
  assert.equal(project.pending.length, 0);
  assert.equal(project.outcomes['fork-key'].threadId, 'created-fork');
  assert.equal(project.outcomes['fork-key'].sourceThreadId, 'source');
  assert.deepEqual(opened, ['created-fork']);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'project-pending.json'), 'utf8')), []);
  assert.equal(requests.length, 2);
} finally {
  await rm(home, { recursive: true, force: true });
}
