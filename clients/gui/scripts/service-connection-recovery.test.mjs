import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { SharedCoreBackend } = require('../app/src/core/service-client.cjs');
const { PROTOCOL } = require('../app/src/core/service-protocol.cjs');
const { WebSocketServer } = require('../app/node_modules/ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'the existing compatible backend must reconnect automatically');
    await sleep(10);
  }
}

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'areal-service-observer-')));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const metadata = { protocol: PROTOCOL, endpoint: `ws://127.0.0.1:${server.address().port}`,
    token: 'a'.repeat(64), identity: 'fixture', pid: 2147483000 };
  const calls = [];
  let connections = 0, recoveries = 0, stop = 'success';
  const packet = () => ({ sequence: 1, snapshot: { library: { projects: {}, threads: {}, settings: {} }, projects: [] },
    service: { connected: true, clients: 1, busy: false, activeCommands: 0, starting: 0, lifecycleVersion: 1, targets: [] } });
  server.on('connection', (socket, request) => {
    connections++;
    assert.equal(request.headers.authorization, `Bearer ${metadata.token}`);
    socket.on('message', async bytes => {
      const message = JSON.parse(String(bytes)); calls.push(message);
      if (message.method === 'hello' && message.params.identity !== metadata.identity) {
        socket.send(JSON.stringify({ id: message.id, error: { code: 'SERVICE_INCOMPATIBLE', message: 'fixture identity changed' } }));
        return;
      }
      if (message.method === 'command' || (message.method === 'stopService' && stop === 'unknown')) {
        socket.terminate(); return;
      }
      let result = message.method === 'resources' ? [] : packet();
      if (message.method === 'stopService') {
        await rm(join(home, 'service.json')); result = { stopped: true };
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const backend = new SharedCoreBackend({ app: { getPath: () => home }, home,
    recoverIncompatible: async () => { recoveries++; throw Error('passive recovery must not retire another backend'); } });
  backend.identity = 'fixture';
  const publish = () => writeFile(join(home, 'service.json'), JSON.stringify(metadata), { mode: 0o600 });
  const drop = () => { for (const socket of server.clients) socket.terminate(); };
  t.after(async () => {
    await backend.shutdown(); drop();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return { backend, metadata, calls, publish, drop, connections: () => connections,
    recoveries: () => recoveries, setStop: value => { stop = value; } };
}

test('a backend published after startup timeout attaches without launching again', async t => {
  const f = await fixture(t); let launches = 0;
  // 启动器的外部边界注入超时；之后的发现、认证和快照使用真实 WebSocket。
  f.backend.initialize = async () => { launches++; throw Object.assign(Error('not ready yet'), { code: 'SERVICE_NOT_READY' }); };
  await assert.rejects(f.backend.init(), /not ready yet/);
  await f.publish();
  await until(() => f.backend.status.connected);
  assert.equal(launches, 1);
  assert.deepEqual(f.calls.map(c => c.method), ['hello']);
});

test('an unknown command is never replayed when its observer reconnects', async t => {
  const f = await fixture(t); await f.publish(); await f.backend.attach();
  await assert.rejects(f.backend.command('send', { projectId: 'p', text: 'once' }), e => e.submissionUnknown === true);
  await until(() => f.backend.status.connected);
  assert.equal(f.calls.filter(c => c.method === 'command').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'hello').length, 2);
});

for (const state of ['stopped', 'unconfirmed']) {
  test(`persisted ${state} intent prevents passive reconnection`, async t => {
    const f = await fixture(t); await f.publish(); await f.backend.attach();
    await f.backend.saveControl(state); f.drop();
    await sleep(700);
    assert.equal(f.backend.status.connected, false);
    assert.equal(f.connections(), 1);
  });
}

test('a changed backend identity needs explicit recovery instead of automatic retirement', async t => {
  const f = await fixture(t); await f.publish(); await f.backend.attach();
  f.metadata.identity = 'other-build'; await f.publish(); f.drop();
  await until(() => f.connections() === 2);
  await sleep(700);
  assert.equal(f.backend.status.connected, false);
  assert.equal(f.recoveries(), 0);
  assert.equal(f.connections(), 2);
  assert.equal(f.calls.filter(c => c.method !== 'hello').length, 0);
});

for (const forUpdate of [false, true]) {
  for (const outcome of ['success', 'unknown']) {
    test(`${outcome} explicit stop (forUpdate=${forUpdate}) blocks automatic attachment`, async t => {
      const f = await fixture(t); await f.publish(); await f.backend.attach(); f.setStop(outcome);
      if (outcome === 'unknown') await assert.rejects(f.backend.stopService(forUpdate), e => e.submissionUnknown === true);
      else await f.backend.stopService(forUpdate);
      // 即使相同身份的服务随后可见，停止意图也不能被观察恢复撤销。
      await f.publish(); f.drop(); await sleep(700);
      assert.equal(f.backend.status.connected, false);
      assert.equal(f.connections(), 1);
      assert.equal(f.calls.filter(c => c.method === 'stopService').length, 1);
    });
  }
}

test('closing the GUI cancels pending observer recovery', async t => {
  const f = await fixture(t); await f.publish(); await f.backend.attach(); f.drop();
  await sleep(25); await f.backend.shutdown(); await sleep(700);
  assert.equal(f.connections(), 1);
});

test('an explicit reconnect can reopen observation after a persisted user stop', async t => {
  const f = await fixture(t); await f.publish(); await f.backend.attach();
  await f.backend.saveControl('stopped'); f.drop(); await sleep(25);
  let starts = 0;
  f.backend.initialize = async () => { starts++; assert.equal(await f.backend.attach(), true); };
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, false); assert.equal(starts, 0);
  await f.backend.init();
  assert.equal(f.backend.status.connected, true); assert.equal(starts, 1);
});
