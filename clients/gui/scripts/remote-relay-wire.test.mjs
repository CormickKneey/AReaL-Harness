import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createRemoteWire, remoteLocator, publicLocator } from "../packages/remote/src/wire.mjs";
import {
  decodeRelayMessage,
  decodeRelayData,
  encodeRelayData,
} from "../packages/remote/src/relay-codec.mjs";
const channel = "11111111-1111-4111-8111-111111111111";
const room = "a".repeat(64);
class Socket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  sent = [];
  send(value) {
    this.sent.push(value);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data) {
    const event = new Event("message");
    event.data = data;
    this.dispatchEvent(event);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

test("public reconnect locator retains only Host pin and validated room, never invitation or endpoint override", () => {
  const host = "12D3KooW" + "a".repeat(44);
  const value = new URLSearchParams({
    host,
    room,
    invite: "secret",
    capability: "long-secret",
    relay: "https://foreign.example",
  });
  assert.deepEqual(remoteLocator(value), { host, room });
  assert.equal(publicLocator(remoteLocator(value)), `host=${host}&room=${room}`);
  assert.throws(() => remoteLocator(new URLSearchParams({ host, room: "bad" })));
  assert.throws(() => remoteLocator(new URLSearchParams({ room })));
  assert.throws(() =>
    remoteLocator(new URLSearchParams({ host: "https://foreign.example", room })),
  );
});

test("Relay client waits for ready-channel and chunks byte stream within outer JSON/base64 budget", async () => {
  const socket = new Socket(),
    { wire, ready } = createRemoteWire(socket, { room });
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    protocol: "areal.relay.v1",
    role: "client",
    room,
  });
  socket.receive(JSON.stringify({ type: "ready", channel }));
  await ready;
  const bytes = randomBytes(700000);
  await wire.stream.sink(
    (async function* () {
      yield bytes;
    })(),
  );
  const frames = socket.sent.slice(1).map((text) => {
    assert.ok(Buffer.byteLength(text) < 512 * 1024);
    const frame = decodeRelayMessage(text);
    assert.equal(frame.channel, channel);
    return Buffer.from(decodeRelayData(frame.data));
  });
  assert.ok(frames.length > 1);
  assert.deepEqual(Buffer.concat(frames), bytes);
  socket.receive(encodeRelayData(channel, Uint8Array.of(1, 2, 3)));
  assert.deepEqual(Buffer.from((await wire.stream.source.next()).value), Buffer.from([1, 2, 3]));
  socket.close();
});

test("foreign-channel, noncanonical base64 and full send buffer close the client wire", async () => {
  for (const message of [
    { type: "data", channel: "22222222-2222-4222-8222-222222222222", data: "Zg==" },
    { type: "data", channel, data: "Zh==" },
    { type: "ready", channel },
    { type: "data", channel, data: "Zg==", room },
  ]) {
    const socket = new Socket(),
      { ready } = createRemoteWire(socket, { room });
    socket.open();
    socket.receive(JSON.stringify({ type: "ready", channel }));
    await ready;
    socket.receive(JSON.stringify(message));
    assert.equal(socket.readyState, 3);
  }
  const socket = new Socket(),
    { wire, ready } = createRemoteWire(socket, { room });
  socket.open();
  socket.receive(JSON.stringify({ type: "ready", channel }));
  await ready;
  socket.bufferedAmount = 1024 * 1024;
  await assert.rejects(
    wire.stream.sink(
      (async function* () {
        yield Uint8Array.of(1);
      })(),
    ),
  );
  assert.equal(socket.readyState, 3);
});

test("Host ready requires exact bounded advertised service budgets without a ceiling fallback", () => {
  const limits = {
    framesPerSecond: 12,
    bytesPerSecond: 524288,
    maxFrameBytes: 131072,
    heartbeatIntervalMs: 15000,
  };
  assert.deepEqual(decodeRelayMessage(JSON.stringify({ type: "ready", limits })).limits, limits);
  for (const message of [
    { type: "ready" },
    { type: "ready", limits: {} },
    { type: "ready", channel, limits },
    ...[
      { framesPerSecond: 81 },
      { framesPerSecond: 0 },
      { bytesPerSecond: 0 },
      { maxFrameBytes: 524289 },
      { heartbeatIntervalMs: 0 },
      { heartbeatIntervalMs: "15000" },
      { unknown: 1 },
    ].map((change) => ({ type: "ready", limits: { ...limits, ...change } })),
  ])
    assert.throws(() => decodeRelayMessage(JSON.stringify(message)), /帧无效/);
});
