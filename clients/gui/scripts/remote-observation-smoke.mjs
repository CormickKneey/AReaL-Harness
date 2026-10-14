import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { RemoteControl } = require("../app/src/core/remote.cjs");
const WebSocket = require("ws");
const { byteChannel, createIdentity, identityId, secureChannel } =
  await import("../packages/remote/src/channel.mjs");
const hostIdentity = await createIdentity();
const deviceIdentity = await createIdentity();
const devicePeerId = identityId(deviceIdentity);
const backend = {
  home: "/private/tmp/remote-observation-fixture",
  saved: [
    { id: "project-a", root: "/private/tmp/secret-root" },
    { id: "project-b", root: "/private/tmp/other-root" },
    { id: "project-c", root: "/private/tmp/third-root" },
  ],
  library: {
    value: {
      projects: {
        "project-a": { name: "Alpha" },
        "project-b": { name: "Beta" },
        "project-c": { name: "Gamma" },
      },
    },
  },
  providers: { redact: (value) => value },
};
const service = { backend, schedule() {} };
const remote = new RemoteControl(service, {});
remote.crypto = { byteChannel, createIdentity, identityId, secureChannel };
remote.config = {
  enabled: false,
  directEnabled: true,
  identity: hostIdentity,
  deviceGrants: [
    {
      devicePeerId,
      displayName: "Fixture browser",
      projectIds: ["project-a", "project-c"],
      capabilities: ["observe"],
      revision: 1,
      status: "active",
    },
  ],
};
const address = await remote.startDirect();

async function connect(pin = identityId(hostIdentity), origin = address.origin) {
  const socket = new WebSocket(address.ws, { origin });
  await once(socket, "open");
  const wire = byteChannel(
    (bytes) => socket.send(bytes),
    () => socket.close(),
  );
  socket.on("message", (bytes) => wire.receive(bytes));
  socket.on("close", () => wire.close());
  const secure = await secureChannel(wire, deviceIdentity, pin);
  return { secure, socket, messages: secure.messages() };
}
try {
  const page = await fetch(address.origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Remote/);
  const { secure, messages } = await connect();
  secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "fixture",
    displayName: "Fixture browser",
  });
  const ready = (await messages.next()).value;
  assert.equal(ready.event, "ready");
  assert.equal(ready.hostId, identityId(hostIdentity));
  assert.deepEqual(ready.capabilities, ["observe"]);
  for (const method of ["session.open", "session.history", "subscription.close"])
    assert.ok(ready.methods.includes(method), `Remote advertises ${method}`);
  secure.send({
    id: "one",
    method: "project.list",
    context: { projectId: "project-a" },
    params: { limit: 1 },
  });
  const projects = (await messages.next()).value;
  assert.deepEqual(
    projects.result.projects.map((project) => project.projectId),
    ["project-a"],
  );
  assert.equal(projects.result.nextCursor, "1");
  secure.send({ id: "next", method: "project.list", params: { cursor: "1", limit: 1 } });
  assert.deepEqual(
    (await messages.next()).value.result.projects.map((project) => project.projectId),
    ["project-c"],
  );
  assert.equal(JSON.stringify([ready, projects]).includes("/private/tmp"), false);
  secure.send({
    id: "two",
    method: "project.list",
    context: { projectId: "project-b" },
    params: {},
  });
  assert.equal((await messages.next()).value.error.code, "FORBIDDEN");
  secure.send({
    id: "three",
    method: "no.such.method",
    context: { projectId: "project-a" },
    params: {},
  });
  assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
  secure.send({ id: "four", method: "host.describe", params: {}, extra: true });
  assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
  secure.send({ id: "five", method: "project.list", params: { limit: 101 } });
  assert.equal((await messages.next()).value.error.code, "INVALID_PARAMS");
  secure.close();
  const old = await connect();
  old.secure.send({
    method: "hello",
    apiVersion: "areal.remote.v1",
    clientVersion: "fixture",
    displayName: "Fixture browser",
  });
  assert.equal((await old.messages.next()).value.error.code, "PROTOCOL_UNSUPPORTED");
  old.secure.close();
  const invalidHello = await connect();
  invalidHello.secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "fixture",
    displayName: "Fixture browser",
    extra: true,
  });
  assert.equal((await invalidHello.messages.next()).value.error.code, "INVALID_PARAMS");
  invalidHello.secure.close();
  const wrongPin = identityId(await createIdentity());
  await assert.rejects(() => connect(wrongPin));
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(address.ws, { origin: "https://evil.example" });
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
  );
  const oversized = new WebSocket(address.ws, { origin: address.origin });
  await once(oversized, "open");
  oversized.send(Buffer.alloc(600 * 1024));
  await once(oversized, "close");
  const oversizedJson = await connect();
  oversizedJson.secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "fixture",
    displayName: "Fixture browser",
    padding: "x".repeat(260 * 1024),
  });
  await once(oversizedJson.socket, "close");
  const burst = await connect();
  burst.secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "fixture",
    displayName: "Fixture browser",
  });
  assert.equal((await burst.messages.next()).value.event, "ready");
  for (let index = 0; index < 21; index++)
    burst.secure.send({ id: `invalid-${index}`, method: "project.list", params: {}, extra: true });
  const burstCodes = [];
  for (let index = 0; index < 21; index++)
    burstCodes.push((await burst.messages.next()).value.error.code);
  assert.equal(burstCodes.filter((code) => code === "INVALID_PARAMS").length, 20);
  assert.equal(burstCodes.at(-1), "LIMIT_EXCEEDED");
  burst.secure.close();
  const survivor = await connect();
  survivor.secure.send({
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "fixture",
    displayName: "Fixture browser",
  });
  assert.equal((await survivor.messages.next()).value.event, "ready");
  survivor.secure.send({ id: "alive", method: "host.describe", params: {} });
  assert.equal((await survivor.messages.next()).value.result.hostId, identityId(hostIdentity));
  survivor.secure.close();
  const management = await fetch(address.origin + "/service.json");
  assert.equal(management.status, 404);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "fixture Noise observation and pagination",
        "wrong Host pin",
        "unknown protocol, fields and method",
        "wrong Origin and management route",
        "oversized raw and encrypted frames close only the offending connection",
        "invalid-request burst is rate-limited without blocking another connection",
      ],
    }),
  );
} finally {
  remote.close();
}
