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

test("cancel shutdown preserves pending input and reaches the backend with its intent", async () => {
  let shutdown;
  const backend = {
    hasWork: () => false, providerUpdating: false, starting: new Map(),
    projects: new Map([["project", { client: { ready: true, request: async () => ({
      restartSafe: true, resources: [], activeTurns: [], activeGoals: [], activeTasks: 0, pendingQueueItems: 1,
    }) } }]]),
    shutdown: async options => { shutdown = options; },
  };
  const service = new DesktopService(backend, "fixture-identity");
  await service.stop({ cancel: true });
  assert.deepEqual(shutdown, { requireSafe: true, cancel: true });
});

test("an incomplete cancel keeps the desktop in recovery instead of reopening admission", async () => {
  const backend = {
    hasWork: () => false, providerUpdating: false, starting: new Map(), projects: new Map(),
    shutdown: async () => { throw Object.assign(new Error("settlement incomplete"), {
      code: "CORE_RESOURCES", lifecycle: { phase: "incomplete", projects: [{ projectId: "p", phase: "draining" }] },
    }); },
  };
  const service = new DesktopService(backend, "fixture-identity");
  await assert.rejects(service.stop({ cancel: true }), /settlement incomplete/);
  assert.equal(service.stopReport.phase, "incomplete");
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
  { stopUnknown = false, drainUnknown = false, cancelStop = false, confirm = true, idleWork = false, peers = false, wrappedBusy = false } = {},
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
    identity: "old-fixture", pid: 2147483000,
  };
  await writeFile(join(home, "service.json"), JSON.stringify(metadata));
  const calls = [],
    dialogs = [];
  const task = { id: 'schedule', threadId: 'schedule-thread', revision: 1, mode: 'scheduled', paused: false,
    cancelled: false, schedule: { at: 4070908800 }, nextRunAt: 4070908800, runs: [{ id: 'run', status: 'waitingForInput' }] };
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
        task.runs[0].status = 'paused'; task.revision++;
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
            busy: !idleWork && busy,
            cancelStop,
            clients: peers ? 2 : 1,
            activeCommands: 0,
            starting: 0,
            providerUpdating: false,
            browserControlEndpoints: [endpoint],
          },
        };
      } else if (message.method === "resources") {
        result = [{ projectId, root: home, restartSafe: idleWork || !busy, resources: [], activeTurns: !idleWork && busy ? 1 : 0,
          ...(idleWork ? { goalThreads: busy ? ['idle-goal'] : [], activeTasks: busy ? 1 : 0,
            tasks: busy ? [{ id: 'schedule', mode: 'scheduled', paused: false, running: false }] : [] } : {}) }];
      } else if (message.method === 'command') {
        assert.equal(message.params.request.operation, 'task');
        result = structuredClone(task);
      } else if (message.method === "stopService") {
        if (busy) {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                message: wrappedBusy ? 'Core 服务请求失败：{"error":{"code":"localServiceError","message":"service is busy; wait for work to settle or stop with --cancel"}}\n' : "后台仍有任务、可执行的排队消息或操作，完成或暂停队列后重试",
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

test("idle goal and scheduled work still offer confirmed cancellation through the old Core", async (t) => {
  const fixture = await legacyFixture(t, { idleWork: true });
  await fixture.run();
  assert.equal(fixture.dialogs[0].buttons.includes("暂停定时安排…"), false);
  assert.ok(fixture.dialogs[0].buttons.includes("取消任务并重启"));
  assert.equal(fixture.dialogs[1].message, "确认取消后台任务？");
  assert.equal(fixture.calls.filter(call => call.method === "areal/server/drain").length, 1);
  assert.equal(fixture.calls.filter(call => call.method === "stopService").length, 2);
});

test("the real legacy localServiceError envelope permits cancellation only after a known busy rejection", async (t) => {
  const fixture = await legacyFixture(t, { wrappedBusy: true });
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.method === 'areal/server/drain').length, 1);
  assert.equal(fixture.calls.filter(call => call.method === 'stopService').length, 2);
});

test("an unknown legacy localServiceError response never falls back", async (t) => {
  const fixture = await legacyFixture(t, { wrappedBusy: true, stopUnknown: true });
  await assert.rejects(fixture.run(), { submissionUnknown: true });
  assert.equal(fixture.calls.some(call => call.method === 'areal/server/drain'), false);
});

test("idle background work remains untouched when confirmation is declined or another GUI is connected", async (t) => {
  for (const options of [{ idleWork: true, confirm: false }, { idleWork: true, peers: true }]) {
    const fixture = await legacyFixture(t, options);
    await assert.rejects(fixture.run(), { code: "STARTUP_CANCELLED" });
    assert.equal(fixture.calls.some(call => ["stopService", "areal/server/drain", "command"].includes(call.method)), false);
    if (options.peers) assert.equal(fixture.dialogs[0].buttons.includes("取消任务并重启"), false);
  }
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
