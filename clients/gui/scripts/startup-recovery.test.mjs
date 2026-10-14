import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const require = createRequire(import.meta.url);
const { DesktopService } = require("../app/src/core/service-protocol.cjs");
const { PROTOCOL } = require("../app/src/core/service-protocol.cjs");
const { recoverStartupService } = require("../app/src/core/startup-recovery.cjs");
const { WebSocketServer } = require("../app/node_modules/ws");

test("force stop drains active Core turns before the normal shutdown checks", async () => {
  const calls = [];
  let busy = true;
  const backend = {
    hasWork: () => busy,
    providerUpdating: false,
    starting: new Map(),
    library: { writes: Promise.resolve() },
    saves: new Map(),
    projects: new Map([
      [
        "project",
        {
          client: {
            ready: true,
            request: async (method, params) => {
              calls.push({ method, params });
              if (method === "areal/server/drain") busy = false;
              if (method === "areal/server/status")
                return { restartSafe: true, resources: [], activeTurns: [] };
              if (method === "areal/process/list") return { data: [] };
            },
          },
        },
      ],
    ]),
    shutdown: async (options) => calls.push({ method: "shutdown", options }),
  };
  const service = new DesktopService(backend, "fixture-identity");
  await service.stop({ cancel: true });
  assert.deepEqual(calls, [
    { method: "areal/server/drain", params: { strategy: "cancel", timeoutMs: 30_000 } },
    { method: "areal/server/status", params: undefined },
    { method: "shutdown", options: { requireSafe: true } },
  ]);
});

test("normal stop still refuses a busy Core without cancellation", async () => {
  const backend = {
    hasWork: () => true,
    providerUpdating: false,
    starting: new Map(),
    projects: new Map(),
  };
  const service = new DesktopService(backend, "fixture-identity");
  await assert.rejects(service.stop(), /后台仍有任务/);
});

async function legacyFixture(
  t,
  { stopUnknown = false, drainUnknown = false, cancelStop = false, confirm = true } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "areal-startup-recovery-"));
  const core = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const desktop = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const server of [core, desktop]) {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(home, { recursive: true, force: true });
  });
  await Promise.all([once(core, "listening"), once(desktop, "listening")]);
  const endpoint = `ws://127.0.0.1:${core.address().port}`;
  const projectId = "1234567890abcdef12345678";
  const state = join(home, projectId, "state");
  await mkdir(join(state, "launcher-state", ".run-fixture"), { recursive: true });
  await mkdir(join(state, "security"), { recursive: true });
  await writeFile(join(state, "launcher-state", ".run-fixture", "ready"), endpoint);
  await writeFile(
    join(state, "security", "auth.json"),
    JSON.stringify({ principals: [{ permissions: ["manage"], token: "fixture-core-token" }] }),
  );
  const metadata = {
    protocol: PROTOCOL,
    endpoint: `ws://127.0.0.1:${desktop.address().port}`,
    token: "a".repeat(64),
    identity: "old-fixture",
  };
  await writeFile(join(home, "service.json"), JSON.stringify(metadata));
  const calls = [],
    dialogs = [];
  let busy = true;
  core.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer fixture-core-token");
    let initialized = false;
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      calls.push(message);
      if (message.method === "initialized") {
        initialized = true;
        return;
      }
      if (message.method === "areal/server/drain") {
        assert.equal(initialized, true);
        assert.deepEqual(message.params, { strategy: "cancel", timeoutMs: 30_000 });
        busy = false;
        if (drainUnknown) {
          socket.terminate();
          return;
        }
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  desktop.on("connection", (socket) => {
    socket.on("message", async (bytes) => {
      const message = JSON.parse(String(bytes));
      calls.push(message);
      let result;
      if (["hello", "snapshot"].includes(message.method)) {
        result = {
          service: {
            busy,
            cancelStop,
            clients: 1,
            activeCommands: 0,
            starting: 0,
            providerUpdating: false,
            browserControlEndpoints: [endpoint],
          },
        };
      } else if (message.method === "resources") {
        result = [{ projectId, restartSafe: !busy, resources: [], activeTurns: busy ? 1 : 0 }];
      } else if (message.method === "stopService") {
        if (busy) {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                message: "后台仍有任务、可执行的排队消息或操作，完成或暂停队列后重试",
                ...(stopUnknown ? { submissionUnknown: true } : {}),
              },
            }),
          );
          return;
        }
        result = { stopped: true };
        await rm(join(home, "service.json"));
      } else throw new Error(`Unexpected desktop method ${message.method}`);
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  return {
    calls,
    dialogs,
    run: () =>
      recoverStartupService({
        metadata,
        home,
        notify: async (dialog) => {
          dialogs.push(dialog);
          if (dialog.message === "确认取消后台任务？") return { response: confirm ? 1 : 0 };
          return { response: dialogs.length === 1 ? dialog.buttons.indexOf("取消任务并重启") : 0 };
        },
      }),
  };
}

test("new GUI cancels through Core when an old backend ignores cancel, then safely stops", async (t) => {
  const fixture = await legacyFixture(t);
  await fixture.run();
  assert.equal(fixture.dialogs.length, 2);
  const stops = fixture.calls.filter((call) => call.method === "stopService");
  assert.equal(stops.length, 2);
  assert.equal(stops[0].params.cancel, true);
  assert.equal(stops[1].params.cancel, undefined);
  assert.equal(fixture.calls.filter((call) => call.method === "areal/server/drain").length, 1);
});

test("declining confirmation leaves the old backend and its Core tasks running", async (t) => {
  const fixture = await legacyFixture(t, { confirm: false });
  await assert.rejects(fixture.run(), { code: "STARTUP_CANCELLED" });
  assert.equal(
    fixture.calls.some((call) => ["stopService", "areal/server/drain"].includes(call.method)),
    false,
  );
});

test("unconfirmed stop results never trigger the legacy cancellation fallback", async (t) => {
  const fixture = await legacyFixture(t, { stopUnknown: true });
  await assert.rejects(fixture.run(), { submissionUnknown: true });
  assert.equal(fixture.calls.filter((call) => call.method === "stopService").length, 1);
  assert.equal(
    fixture.calls.some((call) => call.method === "areal/server/drain"),
    false,
  );
});

test("a lost Core cancellation response prevents automatic stop or cancellation replay", async (t) => {
  const fixture = await legacyFixture(t, { drainUnknown: true });
  await assert.rejects(fixture.run(), { submissionUnknown: true });
  assert.equal(fixture.calls.filter((call) => call.method === "stopService").length, 1);
  assert.equal(fixture.calls.filter((call) => call.method === "areal/server/drain").length, 1);
});

test("a backend with cancelStop never falls back after rejecting cancellation", async (t) => {
  const fixture = await legacyFixture(t, { cancelStop: true });
  await assert.rejects(fixture.run(), { code: "STARTUP_CANCELLED" });
  assert.equal(fixture.calls.filter((call) => call.method === "stopService").length, 1);
  assert.equal(
    fixture.calls.some((call) => call.method === "areal/server/drain"),
    false,
  );
});
