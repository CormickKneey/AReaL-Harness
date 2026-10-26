import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const {
  ServiceConnection,
  waitForServiceProcessExit,
} = require("../app/src/core/service-client.cjs");
const { DesktopLifecycle } = require("../app/src/core/lifecycle.cjs");
const {
  restoreLegacySchedules,
  cancelLegacyService,
  pauseLegacySchedules,
  legacyBusy,
} = require("../app/src/core/legacy-service-cancel.cjs");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary, "Set AREAL_CORE_BIN to the current fixed binary");
const oldBinary = process.env.AREAL_LEGACY_CORE_BIN;
assert.ok(
  oldBinary,
  "Set AREAL_LEGACY_CORE_BIN to a verified old Core with legacy schedule counting",
);
const scratch = await makeTempDir("areal-legacy-lifecycle-");
const legacyRef = "d7d2f8bda75f1147a85e36e4e99ad3d8e3086f80";
const legacySource = join(scratch, "legacy-source");
await mkdir(legacySource);
execFileSync("tar", ["-xf", "-", "-C", legacySource], {
  input: execFileSync("git", ["archive", legacyRef, "clients/gui/app"], {
    cwd: resolve(gui, "../.."),
    maxBuffer: 32 * 1024 * 1024,
  }),
});
const legacyApp = join(legacySource, "clients/gui/app");
await symlink(join(gui, "app/node_modules"), join(legacyApp, "node_modules"), "dir");
await symlink(join(gui, "renderer"), join(legacySource, "clients/gui/renderer"), "dir");
const workspace = join(scratch, "workspace"),
  home = join(scratch, "core");
await mkdir(workspace);
await mkdir(join(scratch, "user/.areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const checks = [],
  errors = [],
  requests = [];
const model = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const text = (m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((p) => p.text ?? "").join("\n");
    const context = body.messages
      .map(text)
      .filter((t) => t.includes("Current authoritative goal: "))
      .at(-1);
    const view = JSON.parse(context.split("Current authoritative goal: ").at(-1));
    const name = view.goal.limitsPending
      ? "goal_set_limits"
      : body.messages.some((m) =>
            m.tool_calls?.some((c) => c.function.name === "ask_user_question"),
          )
        ? "task_wait"
        : "ask_user_question";
    const args =
      name === "goal_set_limits"
        ? { expectedRevision: view.revision, sources: {} }
        : name === "task_wait"
          ? {}
          : {
              mode: "async",
              questions: [{ id: "continue", title: "Continue?", options: ["Continue", "Wait"] }],
            };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
      { delta: {}, finish_reason: "tool_calls" },
    ])
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push(error.stack);
    res.destroy(error);
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const env = {
  ...process.env,
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_HOME: home,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[key];
const testApp = join(scratch, "app");
await mkdir(testApp);
await writeFile(
  join(testApp, "package.json"),
  JSON.stringify({ name: "areal-legacy-lifecycle-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(testApp, "bootstrap.cjs"),
  `
const {dialog} = require('electron'); globalThis.__legacyDialogs = [];
if (process.env.AREAL_LEGACY_PAUSE_UNKNOWN === '1') {
  const {ServiceConnection} = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
  const original = ServiceConnection.prototype.request;
  ServiceConnection.prototype.request = async function(method, params, mutation) {
    const result = await original.call(this, method, params, mutation);
    if (method === 'command' && params.request.operation === 'taskPause') {
      globalThis.__legacyPauseWrites = (globalThis.__legacyPauseWrites ?? 0) + 1;
      if (globalThis.__legacyPauseWrites === 1) throw Object.assign(Error('injected lost pause response'), {submissionUnknown:true});
    }
    return result;
  };
}
{
  const {ServiceConnection} = require(${JSON.stringify(join(gui, "app/src/core/service-client.cjs"))});
  const original = ServiceConnection.prototype.request;
  ServiceConnection.prototype.request = async function(method, params, mutation) {
    try { return await original.call(this, method, params, mutation); }
    catch (error) { if (method === 'stopService') (globalThis.__legacyStopErrors ??= []).push(error.message); throw error; }
  };
}
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1); globalThis.__legacyDialogs.push(options);
  if (options.message === '确认取消后台任务？') return {response:1};
  const action = options.buttons.includes('取消任务并重启') ? options.buttons.indexOf('取消任务并重启') : options.buttons.indexOf('重启后台并继续');
  if (action < 0 || globalThis.__legacyDialogs.length > 4) throw Error('Unexpected recovery dialog: '+options.message+' '+options.detail);
  return {response:action};
};
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
);
const until = async (fn, label) => {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (errors.length) throw Error(errors[0]);
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timeout: " + label);
};
let app,
  page,
  passed = false;
const connection = new ServiceConnection();
const call = async (name, request) => {
  const reply = await page.evaluate(
    ({ name, request }) => window.arealDesktop.command(name, request),
    { name, request },
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
};
console.log("Legacy lifecycle evidence:", scratch);
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [legacyApp],
    env: { ...env, AREAL_CORE_BIN: oldBinary },
    timeout: 120000,
  });
  page = await app.firstWindow();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const projectId = (
    await until(
      async () =>
        (await page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
          (p) => p.root === workspace && p.state?.connected,
        ),
      "old project",
    )
  ).id;
  const created = await call("manage", {
    projectId,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "Wait for legacy lifecycle confirmation",
    interactionMode: "asynchronous",
    schedule: { at: Math.floor(Date.now() / 1000) + 2, intervalSeconds: 86400 },
  });
  const taskRequest = { projectId, operation: "task", taskId: created.id };
  const original = await until(async () => {
    const task = await call("manage", taskRequest);
    return task.runs.at(-1)?.status === "waitingForInput" && task;
  }, "legacy waiting Run");
  const old = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  await connection.connect(old);
  const oldPacket = await connection.request("hello", {
    protocol: old.protocol,
    identity: old.identity,
  });
  assert.equal(oldPacket.service.cancelStop, undefined);
  assert.equal(oldPacket.service.lifecycleVersion, undefined);
  connection.close();
  const status = await call("manage", { projectId, operation: "server" });
  assert.equal(status.lifecycle, undefined);
  assert.equal(status.activeTurns.length, 0);
  assert.equal(status.activeTasks, 1);
  checks.push(
    "archived legacy Desktop and real historical Core have no lifecycle or cancelStop and a waiting Run with zero active Turns",
  );
  await page.screenshot({ path: join(scratch, "01-legacy-wait.png") });
  await app.close();
  app = null;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [testApp],
    env: { ...env, AREAL_CORE_BIN: binary },
    timeout: 120000,
  });
  page = await app.firstWindow();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  if (env.AREAL_LEGACY_PAUSE_UNKNOWN === "1") {
    await until(
      async () =>
        (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state ===
        "unavailable",
      "unknown pause stops automatic recovery",
    );
    const pending = JSON.parse(await readFile(join(home, "legacy-schedule-recovery.json")));
    assert.equal(pending.entries[0].phase, "pausePending");
    assert.equal(await app.evaluate(() => globalThis.__legacyPauseWrites), 1);
    process.kill(old.pid, 0);
    await writeFile(join(scratch, "unknown-pause.json"), JSON.stringify(pending, null, 2));
    await page.getByRole("button", { name: "重新连接后台", exact: true }).click();
    checks.push(
      "lost pause response preserves original identity and intent, leaves old backend alive, and requires explicit reconnect without pause/cancel replay",
    );
  }
  await until(
    async () =>
      (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === "ready",
    "new source ready after legacy recovery",
  );
  await waitForServiceProcessExit(home, old);
  const restored = await until(async () => {
    const task = await call("manage", taskRequest);
    return !task.paused && task;
  }, "original arrangement enabled after restoration");
  assert.equal(restored.paused, false);
  assert.deepEqual(restored.schedule, original.schedule);
  assert.equal(restored.nextRunAt, original.nextRunAt);
  assert.deepEqual(
    restored.runs.map((r) => r.id),
    original.runs.map((r) => r.id),
  );
  assert.equal(restored.runs.at(-1).status, "paused");
  await assert.rejects(readFile(join(home, "legacy-schedule-recovery.json")), { code: "ENOENT" });
  const nativeDialogs = await app.evaluate(() => globalThis.__legacyDialogs);
  assert.equal(nativeDialogs.filter((d) => d.message === "确认取消后台任务？").length, 1);
  const stopErrors = await app.evaluate(() => globalThis.__legacyStopErrors ?? []);
  if (env.AREAL_LEGACY_EXPECT_SCHEDULE_BUSY === "1")
    assert.equal(
      stopErrors.length,
      2,
      "both initial work and post-cancel future arrangement must be rejected by the old normal stop",
    );
  await writeFile(
    join(scratch, "recovery.json"),
    JSON.stringify({ original, restored, dialogs: nativeDialogs, stopErrors }, null, 2),
  );
  checks.push(
    "real legacy busy envelope reaches cancel, preserves schedule enablement through old-process exit and restores it without resuming the Run",
  );
  if (env.AREAL_LEGACY_EXPECT_SCHEDULE_BUSY === "1")
    checks.push(
      "observed compatibility combination rejects normal stop again after cancel; temporary pause makes final safe stop possible",
    );

  const current = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
  await connection.connect(current);
  await connection.request("hello", { protocol: current.protocol, identity: current.identity });
  const paused = await call("manage", {
    ...taskRequest,
    operation: "taskPause",
    expectedRevision: restored.revision,
  });
  const journal = {
    version: 1,
    home,
    source: { pid: old.pid, identity: old.identity },
    entries: [
      {
        projectId,
        root: workspace,
        taskId: created.id,
        revision: paused.revision,
        phase: "paused",
        fingerprint: {
          threadId: paused.threadId,
          schedule: paused.schedule,
          nextRunAt: paused.nextRunAt ?? null,
          runIds: paused.runs.map((r) => r.id),
        },
      },
    ],
  };
  await writeFile(join(home, "legacy-schedule-recovery.json"), JSON.stringify(journal), {
    mode: 0o600,
  });
  let writes = 0;
  const proxy = {
    request: async (method, params, mutation) => {
      const result = await connection.request(method, params, mutation);
      if (method === "command" && params.request.operation === "taskResume") {
        writes++;
        throw Object.assign(Error("injected lost resume response"), { submissionUnknown: true });
      }
      return result;
    },
  };
  const unknown = await restoreLegacySchedules({ connection: proxy, home, metadata: current });
  assert.equal(unknown.attention.length, 1);
  assert.equal(writes, 1);
  const checked = await restoreLegacySchedules({ connection: proxy, home, metadata: current });
  assert.deepEqual(checked, { restored: 0, attention: [] });
  assert.equal(writes, 1);
  checks.push(
    "lost real Core resume response retains recovery intent and is confirmed by reading revision; no second write",
  );
  const enabled = await call("manage", taskRequest);
  const pausedAgain = await call("manage", {
    ...taskRequest,
    operation: "taskPause",
    expectedRevision: enabled.revision,
  });
  journal.entries[0].revision = pausedAgain.revision;
  journal.entries[0].phase = "paused";
  await writeFile(join(home, "legacy-schedule-recovery.json"), JSON.stringify(journal), {
    mode: 0o600,
  });
  await call("manage", {
    ...taskRequest,
    operation: "taskUpdate",
    expectedRevision: pausedAgain.revision,
    objective: "Explicitly changed while restoration was pending",
  });
  const changed = await restoreLegacySchedules({ connection: proxy, home, metadata: current });
  assert.equal(changed.attention.length, 1);
  assert.equal(writes, 1);
  assert.equal((await call("manage", taskRequest)).paused, true);
  assert.equal(
    JSON.parse(await readFile(join(home, "legacy-schedule-recovery.json"))).entries.length,
    1,
  );
  checks.push(
    "concurrent task revision change refuses automatic resume and retains the original arrangement recovery for inspection",
  );
  await page.screenshot({ path: join(scratch, "02-recovered.png") });
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack);
  process.exitCode = 1;
  if (app)
    await writeFile(
      join(scratch, "failure-observation.json"),
      JSON.stringify(
        {
          dialogs: await app.evaluate(() => globalThis.__legacyDialogs ?? []).catch(() => []),
          snapshot: await page.evaluate(() => window.arealDesktop.snapshot()).catch(() => null),
        },
        null,
        2,
      ),
    );
  if (page) await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
} finally {
  connection.close();
  if (app) await app.close().catch((error) => errors.push(error.message));
  const cleanup = new ServiceConnection();
  try {
    const metadata = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
    await cleanup.connect(metadata);
    const packet = await cleanup.request("hello", {
      protocol: metadata.protocol,
      identity: metadata.identity,
    });
    if (packet.service.lifecycleVersion === 1)
      await new DesktopLifecycle({
        connection: cleanup,
        metadata,
        home,
        notify: async () => ({ response: 1 }),
      }).stop({ mode: "cancel" });
    else {
      await cancelLegacyService({ connection: cleanup, home });
      await cleanup
        .request("stopService", { protocol: metadata.protocol, forUpdate: true }, true)
        .catch(async (error) => {
          if (!legacyBusy(error, packet.service)) throw error;
          await pauseLegacySchedules({ connection: cleanup, home, metadata });
          await cleanup.request(
            "stopService",
            { protocol: metadata.protocol, forUpdate: true },
            true,
          );
        });
      await waitForServiceProcessExit(home, metadata);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      errors.push("cleanup: " + error.message);
      passed = false;
    }
  } finally {
    cleanup.close();
  }
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
  if (!passed) process.exitCode = 1;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        revision: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        binary,
        oldBinary,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        oldBinarySha256: createHash("sha256")
          .update(await readFile(oldBinary))
          .digest("hex"),
        legacyRef,
        coreFixture:
          env.AREAL_LEGACY_EXPECT_SCHEDULE_BUSY === "1"
            ? "historical Core with documented preserve-schedule mutation retaining old activeTasks counting"
            : "unmodified historical Core",
        scope:
          "archived legacy adapter + real Core compatibility fixture → current source Electron/Core, shared current renderer/dependencies; local model; no install/update/signing",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
