import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopService, PROTOCOL } = require('../app/src/core/service-protocol.cjs');
const { ServiceConnection } = require('../app/src/core/service-client.cjs');
const { ProjectionEncoder, ProjectionReader } = require('../packages/workbench/client/state-projection.cjs');

function fixture() {
  let thread = { id: 't', turns: [{ id: 'turn', items: [{ id: 'item', type: 'historyDeferred' }] }] };
  const backend = { projects: new Map(), starting: new Map(), analytics: { sample() {}, async flush() {} },
    providers: { redact: value => value }, library: { value: { settings: {} } }, hasWork: () => false,
    snapshot: () => ({ projects: [{ id: 'p', state: { threads: { t: thread } } }] }),
    async command(_name, request) {
      if (request.operation === 'acquire') return { supported: true };
      thread = { ...thread, turns: [{ id: 'turn', items: [request.operation === 'release'
        ? { id: 'item', type: 'historyDeferred' }
        : { id: 'item', type: 'agentMessage', text: 'X'.repeat(70 * 1024 * 1024) }] }] };
      return { loaded: request.operation !== 'release' };
    } };
  return new DesktopService(backend, 'large-projection-fixture');
}

test('socket and pane release fence a late history acquire without releasing another client', async () => {
  const service = fixture(), views = new Set(), pending = [];
  service.backend.command = async (_name, request) => {
    if (request.operation === 'acquire') { await new Promise(resolve => pending.push(resolve)); views.add(request.viewId); }
    if (request.operation === 'release') views.delete(request.viewId);
    return { supported: true };
  };
  const connections = [new ServiceConnection(() => {}, () => {}), new ServiceConnection(() => {}, () => {})];
  const wait = async predicate => { for (let i = 0; !predicate(); i++) { assert.ok(i < 200); await new Promise(resolve => setTimeout(resolve, 5)); } };
  try {
    const metadata = await service.listen();
    for (const connection of connections) { await connection.connect(metadata); await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity }); }
    const request = { projectId: 'p', threadId: 't', viewId: 'shared-user-id', operation: 'acquire' };
    const first = connections[0].request('command', { name: 'history', request });
    await wait(() => pending.length === 1); pending.shift()(); await first;
    const second = connections[1].request('command', { name: 'history', request });
    await wait(() => pending.length === 1);
    await connections[1].request('command', { name: 'history', request: { ...request, operation: 'release' } });
    pending.shift()(); await second;
    assert.equal(views.size, 1, 'pane cleanup cancels a late acquire while preserving the other socket');
    const late = connections[1].request('command', { name: 'history', request }).catch(() => {});
    await wait(() => pending.length === 1); connections[1].close();
    await wait(() => service.clients.size === 1); pending.shift()(); await late;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(views.size, 1, 'a disconnected acquire cannot pin a view');
    connections[0].close(); await wait(() => !service.clients.size);
    await wait(() => !views.size);
  } finally { for (const connection of connections) connection.close(); service.close(); }
});

test('real Desktop service delivers an explicit 70MiB item, command receipt and release without disconnect', async () => {
  const service = fixture();
  let last, closed = false;
  const connection = new ServiceConnection(packet => { last = packet; }, () => { closed = true; });
  try {
    const metadata = await service.listen(); await connection.connect(metadata);
    await connection.request('hello', { protocol: PROTOCOL, identity: metadata.identity });
    await connection.request('command', { name: 'history', request: { projectId: 'p', threadId: 't', viewId: 'v', operation: 'acquire' } });
    const request = { projectId: 'p', threadId: 't', viewId: 'v', operation: 'loadItem', itemId: 'item' };
    assert.equal((await connection.request('command', { name: 'history', request })).loaded, true);
    assert.equal(last.snapshot.projects[0].state.threads.t.turns[0].items[0].text.length, 70 * 1024 * 1024);
    assert.equal(closed, false);
    assert.equal((await connection.request('command', { name: 'history', request: { ...request, operation: 'release', itemId: undefined } })).loaded, false);
    assert.equal(last.snapshot.projects[0].state.threads.t.turns[0].items[0].type, 'historyDeferred');
    assert.equal(closed, false);
  } finally { connection.close(); service.close(); }
});

function heldSocket() {
  return { readyState: 1, bufferedAmount: 0, sent: [],
    projection: new ProjectionEncoder('held'),
    send(text, callback) { this.sent.push({ value: JSON.parse(text), callback }); },
    terminate() { this.readyState = 3; this.terminated = true; } };
}

test('a blocked frame coalesces state without projection gaps and keeps command replies ordered', () => {
  const service = fixture(), socket = heldSocket(), decoder = new ProjectionReader();
  service.send(socket, { method: 'state', params: service.packet() });
  service.send(socket, { method: 'state', params: service.packet() });
  service.send(socket, { id: 1, result: 'first' });
  service.send(socket, { method: 'state', params: service.packet() });
  service.send(socket, { id: 2, result: 'second' });
  assert.equal(socket.sent.length, 1, 'one frame is in flight until its callback');
  decoder.read(socket.sent[0].value.params.snapshot);
  socket.sent[0].callback();
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1].value.id, 1);
  socket.sent[1].callback(); socket.sent[2].callback(); socket.sent[3].callback();
  decoder.read(socket.sent[2].value.params.snapshot);
  assert.equal(socket.sent[2].value.params.sequence, 3, 'only latest pending state is encoded');
  assert.deepEqual(socket.sent.filter(frame => frame.value.id).map(frame => frame.value.id), [1, 2]);
});

test('a blocked response queue above 32MiB terminates and cannot send after failure', () => {
  const service = fixture(), socket = heldSocket();
  service.send(socket, { id: 0, result: 'in flight' });
  service.send(socket, { id: 1, result: 'x'.repeat(17 * 1024 * 1024) });
  service.send(socket, { id: 2, result: 'y'.repeat(17 * 1024 * 1024) });
  assert.equal(socket.terminated, true);
  socket.sent[0].callback?.();
  assert.equal(socket.sent.length, 1, 'queued replies are discarded on termination');
});

test('coalescing state cannot move a newer packet before an already queued full snapshot reply', () => {
  const service = fixture(), socket = heldSocket(), reader = new ProjectionReader();
  const original = service.backend.snapshot;
  let version = 1;
  service.backend.snapshot = () => ({ ...original(), version });
  service.send(socket, { method: 'state', params: service.packet() });
  version = 2; service.send(socket, { method: 'state', params: service.packet() });
  version = 3; service.send(socket, { id: 8, result: service.packet() }, true);
  version = 4; service.send(socket, { method: 'state', params: service.packet() });
  for (let i = 0; i < socket.sent.length; i++) socket.sent[i].callback();
  const packets = socket.sent.map(frame => frame.value.params ?? frame.value.result);
  assert.deepEqual(packets.map(packet => packet.sequence), [1, 3, 4], 'packet order and actual projection order must agree');
  for (const packet of packets) reader.read(packet.snapshot);
  assert.equal(reader.value.version, 4, 'the reader retains the latest state after all queued frames');
});
