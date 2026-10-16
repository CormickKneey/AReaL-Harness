import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { CoreBackend } = require('../app/src/core/backend.cjs');
const { SharedCoreBackend } = require('../app/src/core/service-client.cjs');
const { PROTOCOL } = require('../app/src/core/service-protocol.cjs');
const { serviceIdentity } = require('../app/src/core/service-config.cjs');
const { WebSocketServer } = require('../app/node_modules/ws');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'the existing compatible backend must reconnect automatically');
    await sleep(10);
  }
}

async function fixture(t, { commandContract = 'areal.desktop-commands.v1', commandResult, service = {}, resources = [], onStop } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'areal-service-observer-')));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const metadata = { protocol: PROTOCOL, endpoint: `ws://127.0.0.1:${server.address().port}`,
    token: 'a'.repeat(64), identity: 'fixture', pid: 2147483000 };
  const calls = [];
  let connections = 0, stop = 'success', sequence = 0;
  const packet = () => ({ sequence: ++sequence, snapshot: {
    library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
    desktopCapabilities: { currentCommands: commandContract !== 'areal.desktop-commands.v1' },
    projects: [{ id: 'p', root: home, state: { threads: {} }, desktopCapabilities: { currentCommands: commandContract !== 'areal.desktop-commands.v1' } }],
  }, service: { connected: true, clients: 1, busy: false, providerUpdating: false, activeCommands: 0, starting: 0,
    pid: metadata.pid, lifecycleVersion: 1, targets: [], ...service, ...(commandContract === null ? {} : { commandContract }) } });
  server.on('connection', (socket, request) => {
    connections++;
    assert.equal(request.headers.authorization, `Bearer ${metadata.token}`);
    socket.on('message', async bytes => {
      const message = JSON.parse(String(bytes)); calls.push(message);
      if (message.method === 'hello' && message.params.identity !== metadata.identity) {
        socket.send(JSON.stringify({ id: message.id, error: { code: 'SERVICE_INCOMPATIBLE', message: 'fixture identity changed' } }));
        return;
      }
      if ((message.method === 'command' && commandResult === undefined) || (message.method === 'stopService' && stop === 'unknown')) {
        socket.terminate(); return;
      }
      if (message.method === 'stopService' && stop === 'refused') {
        socket.send(JSON.stringify({ id: message.id, error: { code: 'LIFECYCLE_BLOCKED', message: 'fixture work started during inspection' } }));
        return;
      }
      let result = message.method === 'command' ? commandResult : message.method === 'resources' ? resources : packet();
      if (message.method === 'stopService') {
        await onStop?.({ home, metadata });
        await rm(join(home, 'service.json')); result = { stopped: true };
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const backend = new SharedCoreBackend({ app: { getPath: () => home }, home });
  const publish = () => writeFile(join(home, 'service.json'), JSON.stringify(metadata), { mode: 0o600 });
  const drop = () => { for (const socket of server.clients) socket.terminate(); };
  t.after(async () => {
    await backend.shutdown(); drop();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return { home, backend, metadata, calls, publish, drop, service, connections: () => connections,
    updateContract: value => {
      commandContract = value;
      const params = packet();
      for (const socket of server.clients) socket.send(JSON.stringify({ method: 'state', params }));
    },
    setStop: value => { stop = value; } };
}

async function journalFixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'areal-correlated-receipt-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const reload = async () => {
    const backend = new CoreBackend({ binary: process.execPath, home });
    backend.saved = [{ id: 'p', root: home }];
    const project = await backend.loadProjectJournal('p');
    project.client = { ready: true, request: async (method, params) => {
      calls.push({ method, params });
      if (['thread/list', 'areal/request/read'].includes(method)) return { data: [] };
      assert.ok(['areal/turn/start', 'areal/turn/enqueue'].includes(method), `unexpected Core request ${method}`);
      return { turn: { id: 'accepted-turn' } };
    } };
    return { backend, project };
  };
  return { home, calls, reload, ...await reload() };
}

for (const method of ['areal/turn/start', 'areal/turn/enqueue']) {
  test(`caller-correlated ${method} survives a lost outer response and journal reload`, async t => {
    const f = await journalFixture(t);
    const requestId = 'f12a0dbc-3375-43f8-a3f1-36f204ed4e8a';
    const parameters = { threadId: 't', input: [{ type: 'text', text: 'send once' }] };
    await assert.rejects(async () => {
      await f.backend.submit(f.project, method, parameters, { requestId });
      throw Object.assign(Error('outer response lost'), { submissionUnknown: true, requestId });
    }, error => error.submissionUnknown === true && error.requestId === requestId);
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'p-outcomes.json'), 'utf8')), {
      [requestId]: { accepted: true, method, threadId: 't' },
    });
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'p-pending.json'), 'utf8')), []);
    const recovered = await f.reload();
    assert.deepEqual(await recovered.backend.command('reconcile', { projectId: 'p' }), {
      outcomes: { [requestId]: { accepted: true, method, threadId: 't' } },
    });
    assert.deepEqual(f.calls, [
      { method, params: { ...parameters, requestId } },
      { method: 'thread/list', params: { limit: 100 } },
    ]);
  });

  test(`caller-correlated ${method} keeps its unknown journal when acceptance cannot persist`, async t => {
    const f = await journalFixture(t);
    const requestId = 'f12a0dbc-3375-43f8-a3f1-36f204ed4e8a';
    const parameters = { threadId: 't', input: [{ type: 'text', text: 'send once' }] };
    await mkdir(join(f.home, 'p-outcomes.json'));
    await assert.rejects(f.backend.submit(f.project, method, parameters, { requestId }), error => {
      assert.equal(error.submissionUnknown, true);
      assert.equal(error.requestId, requestId);
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'p-pending.json'), 'utf8')), [
      { method, params: { ...parameters, requestId } },
    ]);
    await rm(join(f.home, 'p-outcomes.json'), { recursive: true });
    const recovered = await f.reload();
    assert.deepEqual(await recovered.backend.command('reconcile', { projectId: 'p' }), { outcomes: {} });
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'p-pending.json'), 'utf8')), [
      { method, params: { ...parameters, requestId } },
    ]);
    assert.deepEqual(f.calls, [
      { method, params: { ...parameters, requestId } },
      { method: 'areal/request/read', params: { requestId, threadId: 't' } },
      { method: 'thread/list', params: { limit: 100 } },
    ]);
  });

  test(`uncorrelated ${method} does not retain a generated acceptance receipt`, async t => {
    const f = await journalFixture(t);
    const parameters = { threadId: 't', input: [{ type: 'text', text: 'send once' }] };
    assert.deepEqual(await f.backend.submit(f.project, method, parameters), { turn: { id: 'accepted-turn' } });
    assert.deepEqual(JSON.parse(await readFile(join(f.home, 'p-pending.json'), 'utf8')), []);
    await assert.rejects(readFile(join(f.home, 'p-outcomes.json'), 'utf8'), { code: 'ENOENT' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, method);
    assert.deepEqual(f.calls[0].params.input, [{ type: 'text', text: 'send once' }]);
  });
}

test('public command availability comes only from the current service contract', async t => {
  const f = await fixture(t, { commandContract: null }); await f.publish(); await f.backend.attach();
  const capabilities = () => {
    const snapshot = f.backend.snapshot();
    return [snapshot.desktopCapabilities, snapshot.projects[0].desktopCapabilities];
  };
  assert.deepEqual(capabilities(), [{ currentCommands: false }, { currentCommands: false }]);
  f.updateContract('areal.desktop-commands.v1');
  await until(() => f.backend.status.commandContract === 'areal.desktop-commands.v1');
  assert.deepEqual(capabilities(), [{ currentCommands: true }, { currentCommands: true }]);
  f.updateContract('areal.desktop-commands.v2');
  await until(() => f.backend.status.commandContract === 'areal.desktop-commands.v2');
  assert.deepEqual(capabilities(), [{ currentCommands: false }, { currentCommands: false }]);
  f.updateContract(null);
  await until(() => f.backend.status.commandContract === undefined);
  assert.deepEqual(capabilities(), [{ currentCommands: false }, { currentCommands: false }]);
  assert.deepEqual(f.calls.map(c => c.method), ['hello']);
});

test('an unadvertised backend rejects current commands before sending or inventing a receipt', async t => {
  const f = await fixture(t, { commandContract: null }); await f.publish(); await f.backend.attach();
  const thread = { projectId: 'p', threadId: 't' };
  const requests = [
    ['send', { ...thread, text: 'keep my draft' }],
    ['continue', { ...thread, expectedTurnId: 'turn' }],
    ['prepareCreator', { projectId: 'p' }],
    ['feedback', { operation: 'status' }],
    ['feedback', { operation: 'preference', enabled: true }],
    ['feedback', { ...thread, operation: 'prepare', turnId: 'turn', itemId: 'answer', rating: 'down' }],
    ...['read', 'draft', 'refine', 'submit', 'close'].map(operation => ['feedback', { ...thread, operation, id: 'saved-draft' }]),
    ['trajectory', { operation: 'setEnabled', enabled: true, expectedRevision: 'a'.repeat(64) }],
    ['providers', { operation: 'defaultAndApply', id: 'provider' }],
    ['steer', { ...thread, expectedTurnId: 'turn', mcpContent: [{ type: 'text', text: 'MCP input' }] }],
    ['queueEdit', { ...thread, operation: 'replace', mcpContent: [{ type: 'text', text: 'MCP input' }] }],
    ['manage', { ...thread, operation: 'pluginInstall', id: 'plugin', scope: 'project', source: '/fixture/plugin', expectedDigest: 'a'.repeat(64), expectedRevision: 1 }],
    ['manage', { ...thread, operation: 'marketplaceUpdate', expectedRevision: 1 }],
    ...['plugins', 'marketplaces', 'mcpApps', 'mcpAppOpen', 'mcpForms', 'mcpFormRespond',
      'mcpExtensionCall', 'mcpToolResult'].map(operation => ['manage', { ...thread, operation }]),
    ...['connectorConfigure', 'connectorCredential'].map(operation => ['manage', { ...thread, operation,
      id: 'plugin', connectorId: 'github', provider: 'github', expectedDigest: 'a'.repeat(64),
      requestId: 'connector-request', credentialRef: 'saved-ref', secret: 'fixture-secret' }]),
    ['manage', { ...thread, operation: 'hookAcknowledge', requestId: 'hook-request', invocationId: 'invocation', inspection: 'reviewed' }],
  ];
  for (const [name, request] of requests) {
    await assert.rejects(f.backend.command(name, request), error => {
      assert.equal(error.code, 'SERVICE_COMMAND_UNSUPPORTED', `${name}.${request.operation ?? ''}`);
      assert.equal(error.message, '当前运行中的后台不支持此操作。现有任务继续运行，输入已保留；请在任务完成后安全停止后台并重新连接。');
      assert.notEqual(error.submissionUnknown, true);
      assert.equal(Object.hasOwn(error, 'requestId'), false);
      return true;
    });
  }
  assert.equal(f.backend.status.connected, true);
  assert.deepEqual(f.calls.map(c => c.method), ['hello']);
});

test('an unadvertised backend keeps compatible observation and control commands', async t => {
  const f = await fixture(t, { commandContract: null, commandResult: { accepted: true } });
  await f.publish(); await f.backend.attach();
  const thread = { projectId: 'p', threadId: 't' };
  const requests = [
    ['list', { projectId: 'p' }], ['open', thread], ['stop', thread],
    ['reconcile', { projectId: 'p' }], ['queue', thread],
    ['steer', { ...thread, text: 'compatible text', expectedTurnId: 'turn', mcpContent: [] }],
    ['configure', { ...thread, options: { readOnly: true } }],
    ['providers', { operation: 'save', id: 'provider' }],
    ['trajectory', { operation: 'status' }], ['manage', { ...thread, operation: 'processes' }],
  ];
  for (const [name, request] of requests) assert.deepEqual(await f.backend.command(name, request), { accepted: true });
  assert.deepEqual(f.calls.filter(c => c.method === 'command').map(c => c.params),
    requests.map(([name, request]) => ({ name, request })));
});

test('legacy queue edits retain the original receipt after disconnect without replay', async t => {
  const f = await fixture(t, { commandContract: null }); await f.publish(); await f.backend.attach();
  const requestId = '62bedfab-f198-4d6a-b66d-46760b04e214';
  const request = { projectId: 'p', threadId: 't', operation: 'replace', itemId: 'queued', text: 'edited', requestId };
  await assert.rejects(f.backend.command('queueEdit', request), error => {
    assert.equal(error.submissionUnknown, true);
    assert.equal(error.requestId, requestId);
    return true;
  });
  await until(() => f.backend.status.connected);
  assert.deepEqual(f.calls.filter(c => c.method === 'command').map(c => c.params), [{ name: 'queueEdit', request }]);
  assert.equal(f.calls.filter(c => c.method === 'hello').length, 2);
});

test('a backend published after startup timeout attaches without launching again', async t => {
  const f = await fixture(t); let launches = 0;
  // 启动器的外部边界注入超时；之后的发现、认证和快照使用真实 WebSocket。
  f.backend.initialize = async () => { launches++; f.backend.identity = 'fixture'; throw Object.assign(Error('not ready yet'), { code: 'SERVICE_NOT_READY' }); };
  await assert.rejects(f.backend.init(), /not ready yet/);
  await f.publish();
  await until(() => f.backend.status.connected);
  assert.equal(launches, 1);
  assert.deepEqual(f.calls.map(c => c.method), ['hello']);
});

test('an unknown command is never replayed when its observer reconnects', async t => {
  const f = await fixture(t); await f.publish(); await f.backend.attach();
  const requestId = 'e99d906b-7912-4e95-81dc-a3fd3c967779';
  const request = { projectId: 'p', threadId: 't', text: 'once', requestId };
  await assert.rejects(f.backend.command('send', request), error => error.submissionUnknown === true && error.requestId === requestId);
  await until(() => f.backend.status.connected);
  assert.deepEqual(f.calls.filter(c => c.method === 'command').map(c => c.params), [{ name: 'send', request }]);
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


async function startupFixture(t, options = {}) {
  let replacementIdentity, controlAtStop;
  const f = await fixture(t, { ...options, onStop: async ({ home, metadata }) => {
    controlAtStop = JSON.parse(await readFile(join(home, 'service-control.json'), 'utf8'));
    const capabilities = await readFile(join(home, 'capabilities.log'), 'utf8');
    assert.ok(capabilities.includes('config models --help'), 'inspect the replacement before stopping the retained service');
    metadata.identity = replacementIdentity;
  } });
  const binary = join(f.home, 'areal');
  await writeFile(binary, `#!/bin/sh
printf '%s\n' "$*" >> '${join(f.home, 'capabilities.log')}'
printf 'fixture model help\n'
`, { mode: 0o700 });
  for (const name of ['areal-runtime', 'areal-runtime-fs']) await writeFile(join(f.home, name), name);
  f.backend.options = { home: f.home, binary, configHome: join(f.home, 'config') };
  replacementIdentity = await serviceIdentity(f.backend.options);
  const launcher = join(f.home, 'desktop-fixture.cjs');
  await writeFile(launcher, `const fs = require('node:fs');
const home = ${JSON.stringify(f.home)};
fs.appendFileSync(home + '/launches.log', 'launch\\n');
fs.writeFileSync(home + '/service.json', fs.readFileSync(home + '/replacement.json'));
`);
  await writeFile(join(f.home, 'replacement.json'), JSON.stringify({ ...f.metadata, identity: replacementIdentity }));
  f.backend.app.getAppPath = () => launcher;
  await f.publish();
  return { ...f, binary, identity: replacementIdentity, controlAtStop: () => controlAtStop,
    launches: async () => {
      try { return (await readFile(join(f.home, 'launches.log'), 'utf8')).trim().split('\n').length; }
      catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    } };
}

test('deployment identity tracks actual executable content and ignores mtime alone', async t => {
  const f = await startupFixture(t);
  for (const name of ['areal', 'areal-runtime', 'areal-runtime-fs']) {
    const path = join(f.home, name), before = await stat(path);
    const identity = await serviceIdentity(f.backend.options);
    await utimes(path, before.atime, new Date(before.mtimeMs + 10_000));
    assert.equal(await serviceIdentity(f.backend.options), identity, `${name} timestamp is not deployment content`);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('changed content')]));
    await utimes(path, before.atime, before.mtime);
    assert.notEqual(await serviceIdentity(f.backend.options), identity, `${name} same-path replacement must change identity`);
    await writeFile(path, original);
  }
});

test('automatic same-deployment reopen silently retains the existing service', async t => {
  const f = await startupFixture(t); f.metadata.identity = f.identity; await f.publish();
  await f.backend.init({ automatic: true });
  assert.deepEqual(f.backend.snapshot().connection, { state: 'ready' });
  assert.equal(f.backend.snapshot().backendUpdate, undefined);
  assert.equal(await f.launches(), 0);
  assert.deepEqual(f.calls.map(call => call.method), ['hello']);
});

test('automatic idle replacement persists stop intent and starts only after confirmed exit', async t => {
  const f = await startupFixture(t);
  await f.backend.init({ automatic: true });
  assert.equal(f.controlAtStop().state, 'unconfirmed');
  assert.equal(f.backend.metadata.identity, f.identity);
  assert.equal(await f.launches(), 1);
  assert.deepEqual(f.backend.snapshot().connection, { state: 'ready' });
  assert.equal(f.backend.snapshot().backendUpdate, undefined);
  assert.deepEqual(f.calls.filter(call => call.method === 'stopService').map(call => call.params), [
    { protocol: PROTOCOL, forUpdate: true, cancel: false, expectedTargets: [] },
  ]);
  await assert.rejects(readFile(f.backend.controlPath), { code: 'ENOENT' });
});

for (const [label, service, resources] of [
  ['active Turn', { busy: true }, []],
  ['other GUI', { clients: 2 }, []],
  ['pending Queue', {}, [{ projectId: 'p', root: '/fixture', restartSafe: true, resources: [], waitingMessages: 1 }]],
  ['UNKNOWN', {}, [{ projectId: 'p', root: '/fixture', restartSafe: false, resources: [], unresolvedTools: 1 }]],
]) {
  test(`automatic changed deployment retains ${label} and never watches for idle`, async t => {
    const f = await startupFixture(t, { service, resources });
    await f.backend.init({ automatic: true });
    assert.equal(f.backend.status.connected, true);
    assert.deepEqual(f.backend.snapshot().backendUpdate, { state: 'pending' });
    assert.equal(f.backend.metadata.identity, 'fixture');
    Object.assign(f.service, { busy: false, clients: 1 });
    await f.backend.init({ automatic: true });
    await sleep(30);
    assert.equal(f.calls.some(call => call.method === 'stopService'), false);
    assert.equal(await f.launches(), 0);
  });
}

test('explicit connect observes a changed deployment without automatic replacement', async t => {
  const f = await startupFixture(t);
  await f.backend.init();
  assert.equal(f.backend.status.connected, true);
  assert.deepEqual(f.backend.snapshot().backendUpdate, { state: 'pending' });
  assert.equal(f.calls.some(call => call.method === 'stopService'), false);
  assert.equal(await f.launches(), 0);
});

test('replacement capability failure keeps the original connected service', async t => {
  const f = await startupFixture(t);
  await writeFile(f.binary, '#!/bin/sh\nprintf "unrecognized subcommand\\n"\n');
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().connection.state, 'ready');
  assert.equal(f.backend.snapshot().backendUpdate.state, 'failed');
  assert.match(f.backend.snapshot().backendUpdate.message, /当前 Core 不支持/);
  assert.equal(f.calls.some(call => call.method === 'stopService'), false);
  assert.equal(await f.launches(), 0);
});

test('identity read failure leaves a retained observer usable with an update error', async t => {
  const f = await startupFixture(t); await rm(f.binary);
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().connection.state, 'ready');
  assert.equal(f.backend.snapshot().backendUpdate.state, 'failed');
  assert.equal(f.calls.some(call => call.method === 'stopService'), false);
  assert.equal(await f.launches(), 0);
});

test('a known replacement refusal keeps the original connected service and removes tentative intent', async t => {
  const f = await startupFixture(t); f.setStop('refused');
  await f.backend.init({ automatic: true });
  assert.equal(f.backend.status.connected, true);
  assert.deepEqual(f.backend.snapshot().backendUpdate, { state: 'pending' });
  assert.equal(await f.launches(), 0);
  assert.equal(f.calls.filter(call => call.method === 'stopService').length, 1);
  await assert.rejects(readFile(f.backend.controlPath), { code: 'ENOENT' });
});

test('unknown replacement stop remains check-only across explicit connection and missing descriptor', async t => {
  const f = await startupFixture(t); f.setStop('unknown');
  await assert.rejects(f.backend.init({ automatic: true }), error => error.submissionUnknown === true);
  assert.equal(f.backend.snapshot().connection.state, 'unavailable');
  assert.equal(f.backend.snapshot().connection.recovery, 'check');
  assert.equal(JSON.parse(await readFile(f.backend.controlPath, 'utf8')).state, 'unconfirmed');
  assert.equal(await f.launches(), 0);
  const journalPath = join(f.home, 'legacy-schedule-recovery.json');
  await writeFile(journalPath, 'untouched schedule recovery fixture');
  await f.backend.init();
  assert.equal(f.backend.status.connected, true);
  assert.equal(f.backend.snapshot().connection.recovery, 'check');
  assert.equal(await readFile(journalPath, 'utf8'), 'untouched schedule recovery fixture');
  assert.equal(JSON.parse(await readFile(f.backend.controlPath, 'utf8')).state, 'unconfirmed');
  assert.equal(f.calls.filter(call => call.method === 'stopService').length, 1);
  assert.equal(f.calls.some(call => call.method === 'command'), false);
  assert.equal(await f.launches(), 0);
  await assert.rejects(f.backend.command('send', { projectId: 'p', threadId: 't', text: 'must remain held' }),
    error => error.code === 'LIFECYCLE_INCOMPLETE');
  assert.equal(f.calls.some(call => call.method === 'command'), false);
  assert.equal((await f.backend.serviceStatus()).connected, true);
  await assert.rejects(f.backend.addProject('/fixture/new-project'), error => error.code === 'LIFECYCLE_INCOMPLETE');
  assert.equal(f.calls.some(call => call.method === 'addProject'), false);
  f.drop(); await until(() => !f.backend.status.connected); await rm(join(f.home, 'service.json'));
  await assert.rejects(f.backend.init(), /未确认|核查/);
  assert.equal(await f.launches(), 0);
  assert.equal(f.calls.filter(call => call.method === 'stopService').length, 1);
  assert.equal(JSON.parse(await readFile(f.backend.controlPath, 'utf8')).state, 'unconfirmed');
});

test('confirmed replacement stop followed by launch failure retains stopped intent', async t => {
  const f = await startupFixture(t);
  f.backend.app.getAppPath = () => { throw Error('replacement launch unavailable'); };
  await assert.rejects(f.backend.init({ automatic: true }), /replacement launch unavailable/);
  assert.equal(JSON.parse(await readFile(f.backend.controlPath, 'utf8')).state, 'stopped');
  await f.backend.init({ automatic: true });
  assert.equal(f.calls.filter(call => call.method === 'stopService').length, 1);
  assert.equal(await f.launches(), 0);
});
