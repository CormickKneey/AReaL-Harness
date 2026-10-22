import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { CoreClient } from '../packages/runtime-client/core.js';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = require('ws');

async function fixture(run, capabilities = { methods: [] }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let peer;
  const received = [];
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const request = JSON.parse(raw);
      received.push(request);
      if (request.method === 'initialize' || request.method === 'areal/capabilities')
        socket.send(JSON.stringify({ id: request.id, result: capabilities }));
    });
  });
  const client = new CoreClient({ createSocket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`) });
  try {
    await client.connect();
    await run(client, () => peer, received);
  } finally {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

test('lost history reads are disconnected reads while writes retain unknown outcomes', async () => {
  await fixture(async (client, peer) => {
    const read = client.request('areal/thread/observe', { threadId: 'history' }).catch(error => error);
    const write = client.request('turn/start', { threadId: 'history' }).catch(error => error);
    const unknown = client.request('future/method', {}).catch(error => error);
    peer().terminate();
    const [readError, writeError, unknownError] = await Promise.all([read, write, unknown]);
    assert.equal(readError.code, 'DISCONNECTED');
    assert.equal(readError.submissionUnknown, false, 'history observation has no submission to reconcile');
    assert.equal(writeError.code, 'RESPONSE_UNKNOWN');
    assert.equal(writeError.submissionUnknown, true);
    assert.equal(unknownError.submissionUnknown, true, 'unclassified operations remain conservative');
  });
});

test('history timeouts are read failures and never replay the request', async () => {
  await fixture(async (client, _peer, received) => {
    await assert.rejects(client.request('thread/read', { threadId: 'history', includeTurns: true }, { timeoutMs: 20 }), error => {
      assert.notEqual(error.code, 'RESPONSE_UNKNOWN');
      assert.equal(error.submissionUnknown, false);
      return true;
    });
    assert.equal(received.filter(request => request.method === 'thread/read').length, 1);
    assert.equal(client.ready, true, 'one read timeout does not close the shared observer');
  });
});

test('mutation timeouts remain unknown and never replay the request', async () => {
  await fixture(async (client, _peer, received) => {
    await assert.rejects(client.request('turn/start', { threadId: 'history' }, { timeoutMs: 20 }), error => {
      assert.equal(error.code, 'RESPONSE_UNKNOWN');
      assert.equal(error.submissionUnknown, true);
      return true;
    });
    assert.equal(received.filter(request => request.method === 'turn/start').length, 1);
  });
});

test('bounded response ceiling rejects before snapshot installation and leaves legacy reads usable', async () => {
  await fixture(async (client, peer, received) => {
    let installed = false;
    const pending = client.request('areal/thread/observe', { threadId: 'history', mode: 'bounded', maxBytes: 1024 },
      { maxResponseBytes: 1024, onResult: () => { installed = true; } }).catch(error => error);
    await once(peer(), 'message');
    peer().send(JSON.stringify({ id: received.at(-1).id, result: { text: '雪'.repeat(600) } }));
    const error = await pending;
    assert.equal(error.code, 'RESPONSE_TOO_LARGE');
    assert.equal(error.data.limitBytes, 1024);
    assert.equal(error.submissionUnknown, false);
    assert.equal(error.recovery.kind, 'none');
    assert.equal(installed, false);
    assert.equal(client.ready, true);
    const legacy = client.request('thread/read', { threadId: 'legacy', includeTurns: true });
    await once(peer(), 'message');
    peer().send(JSON.stringify({ id: received.at(-1).id, result: { text: '雪'.repeat(600) } }));
    assert.equal((await legacy).text.length, 600);
  });
});


test('negotiated Core method semantics classify newly advertised reads and preserve mutation admission', async () => {
  await fixture(async (client, peer, received) => {
    const read = client.request('areal/plugin/read', {}, { timeoutMs: 20 }).catch(error => error);
    assert.equal((await read).submissionUnknown, false);
    const pending = client.request('areal/provider/upsert', { requestId: 'original-id' }).catch(error => error);
    const operation = { requestId: 'original-id', method: 'areal/provider/upsert', target: { kind: 'project' } };
    await once(peer(), 'message');
    const request = received.find(item => item.method === operation.method);
    peer().send(JSON.stringify({ id: request.id, error: { code: -32011, message: 'completion persistence failed', data: {
      reason: 'COMPLETION_UNCONFIRMED', outcome: { kind: 'admitted', operation }, recovery: { kind: 'queryOriginal' }, secret: 'must not escape',
    } } }));
    const error = await pending;
    assert.equal(error.submissionUnknown, true);
    assert.deepEqual(error.outcome, { kind: 'admitted', operation });
    const { desktopError } = require('../packages/workbench/client/desktop-contract.cjs');
    const publicError = desktopError(error);
    assert.deepEqual(publicError.outcome, { kind: 'admitted', operation });
    assert.deepEqual(publicError.recovery, { kind: 'queryOriginal' });
    assert.equal(JSON.stringify(publicError).includes('must not escape'), false);
    assert.equal(publicError.requestId, 'original-id');
    for (const data of [{ reason: 'RESPONSE_TOO_LARGE', retryable: false, delivery: 'resultUnavailable' }, {}]) {
      const pendingRead = client.request('areal/plugin/read', {}).catch(failure => failure);
      await once(peer(), 'message');
      peer().send(JSON.stringify({ id: received.at(-1).id, error: { code: -32602, message: 'read unavailable', data } }));
      const failure = await pendingRead;
      assert.equal(failure.submissionUnknown, false);
      assert.equal(failure.recovery.kind, 'none');
      if (data.delivery) {
        assert.equal(failure.code, 'RESPONSE_TOO_LARGE');
        assert.equal(desktopError(failure).delivery, 'resultUnavailable');
      }
    }

    client.close();
    for (const method of ['areal/plugin/read', 'areal/thread/observe']) {
      const unavailable = await client.request(method, {}).catch(failure => failure);
      assert.equal(unavailable.outcome.kind, 'noMutation');
      assert.equal(unavailable.recovery.kind, 'retryRead');
      assert.equal(unavailable.submissionUnknown, false);
    }
    const unsent = await client.request('areal/provider/upsert', { requestId: 'unsent' }).catch(failure => failure);
    assert.equal(unsent.outcome.kind, 'rejected');
    assert.equal(unsent.recovery.kind, 'none');
  }, { methods: ['areal/plugin/read', 'areal/provider/upsert', 'areal/thread/observe'], methodSemantics: {
    'areal/plugin/read': { effect: 'read' }, 'areal/provider/upsert': { effect: 'mutation', receipt: 'management' },
    'areal/thread/observe': { effect: 'subscription' },
  } });
});

test('generic received mutation errors do not prove non-admission', async () => {
  await fixture(async (client, peer, received) => {
    const pending = client.request('areal/provider/upsert', { requestId: 'received-error' }).catch(error => error);
    await once(peer(), 'message');
    const request = received.find(item => item.method === 'areal/provider/upsert');
    peer().send(JSON.stringify({ id: request.id, error: { code: -32602, message: 'storage failure' } }));
    const error = await pending;
    assert.equal(error.submissionUnknown, true);
    assert.equal(error.outcome.kind, 'unconfirmed');
    assert.equal(error.requestId, 'received-error');
    const rejected = client.request('areal/provider/upsert', { requestId: 'rejected' }).catch(error => error);
    await once(peer(), 'message');
    const last = received.at(-1);
    peer().send(JSON.stringify({ id: last.id, error: { code: -32602, message: 'invalid request', data: {
      outcome: { kind: 'rejected' }, recovery: { kind: 'none' },
    } } }));
    const rejection = await rejected;
    assert.equal(rejection.submissionUnknown, false);
    assert.equal(rejection.outcome.kind, 'rejected');

  });
});
