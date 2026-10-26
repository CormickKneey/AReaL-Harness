import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { makeTempDir } from "./support/temp.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import {
  digest,
  sampleSummary,
  saveScheduleEvidence,
} from "./support/schedule-reliability-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gui = resolve(process.env.AREAL_SCHEDULE_GUI_ROOT || join(root, "clients/gui"));
const require = createRequire(join(root, "clients/gui/app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection, waitForServiceExit } = require(
  join(gui, "app/src/core/service-client.cjs"),
);
const binary = resolve(process.env.AREAL_CORE_BIN || join(root, "target/debug/areal"));
const mode = process.env.AREAL_SCHEDULE_MODE || "accept";
assert.ok(["baseline", "accept"].includes(mode));
const scratch = await makeTempDir("areal-sl-");
const evidence = await mkdtemp(join(root, ".scratch/schedule-reliability-lifecycle-"));
const requests = [],
  checks = [],
  errors = [],
  cleanup = [],
  samples = [],
  owners = [];
const traceFile = join(evidence, "trace.jsonl");
await writeFile(traceFile, "");
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const isoSeconds = (seconds) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const model = createServer((request, response) => {
  void (async () => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ at: Date.now(), body });
    if (body.stream === false) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fixture" } }] }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const contexts = (body.messages ?? [])
      .map(text)
      .filter((value) => value.includes("Current authoritative goal: "));
    const goal = contexts.length
      ? JSON.parse(contexts.at(-1).split("Current authoritative goal: ").at(-1))
      : null;
    const tool = goal?.goal?.limitsPending
      ? { name: "goal_set_limits", args: { expectedRevision: goal.revision, sources: {} } }
      : goal && goal.goal.report?.status !== "complete"
        ? {
            name: "goal_update",
            args: {
              expectedRevision: goal.revision,
              status: "complete",
              summary: "SCHEDULE_LIFECYCLE_DONE",
              evidence: ["Deterministic local fixture completed."],
              remaining: [],
            },
          }
        : null;
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: "function",
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            },
          ],
        }
      : { content: "SCHEDULE_LIFECYCLE_DONE" };
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  })().catch((error) => {
    errors.push(error.stack);
    response.destroy(error);
  });
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await mkdir(join(scratch, "user"));
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n[permissions]\nmode="YOLO"\n`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
});
const fixture = await applicationFixture(
  gui,
  join(scratch, "app"),
  `
const fs=require("node:fs");
const {CoreBackend}=require(${JSON.stringify(join(gui, "app/src/core/backend.cjs"))});
const start=CoreBackend.prototype.startProject;
CoreBackend.prototype.startProject=function(projectId){fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({kind:"owner_start",projectId,at:Date.now(),pid:process.pid})+"\\n");return start.call(this,projectId);};
`,
);
const identity = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  diffSha256: digest(execFileSync("git", ["diff"], { cwd: root })),
  harnessSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  binary,
  binarySha256: digest(await readFile(binary)),
  gui,
  node: process.version,
  electron: require("electron/package.json").version,
};
let app, page, failure, primaryId;
async function until(read, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`Timeout ${label}`);
}
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, request) {
  const reply = await page.evaluate(
    ({ name, request }) => window.arealDesktop.command(name, request),
    { name, request },
  );
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
async function check(name, run) {
  try {
    checks.push({ name, passed: true, detail: await run() });
  } catch (error) {
    checks.push({ name, passed: false, error: error.stack });
  }
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require("electron"),
    args: [fixture.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => {
    void appendFile(join(evidence, "electron.stderr.log"), chunk);
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "Desktop ready");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1488, 1056);
    w.show();
    w.focus();
  });
}
async function stopFixture() {
  if (!app) return;
  const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await until(async () => {
      const hello = await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      if (hello.service.activeCommands || hello.service.starting) return false;
      try {
        await connection.request(
          "stopService",
          {
            protocol: metadata.protocol,
            cancel: true,
            expectedDesktopGeneration: metadata.desktopGeneration,
            expectedTargets: hello.service.targets,
          },
          true,
        );
        return true;
      } catch (error) {
        if (!/请等待已提交操作完成|请等待项目启动完成/.test(error.message)) throw error;
        return false;
      }
    }, "fixture stop accepted after commands settle");
    await waitForServiceExit(join(scratch, "core"), metadata);
  } finally {
    connection.close();
  }
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closeSmokeApplication(app);
  app = null;
  await assertApplicationStopped(binary, env, metadata);
  cleanup.push({ pid: metadata.pid, stopped: true, kind: "fixture teardown" });
}
async function quit() {
  const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  const closed = app.waitForEvent("close", { timeout: 60000 });
  await app
    .evaluate(({ app, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
      app.quit();
    })
    .catch((error) => {
      if (!/closed|destroyed|Target/.test(error.message)) throw error;
    });
  await closed;
  app = null;
  await assertApplicationStopped(binary, env, metadata);
  cleanup.push({ pid: metadata.pid, stopped: true, kind: "product app.quit" });
}
async function persisted(owner) {
  const directory = join(scratch, "core", owner.projectId, "state/desktop");
  const bytes = await readFile(join(directory, "task-mode.json"));
  const catalog = JSON.parse(bytes);
  const head = catalog.tasks[digest(owner.taskId)];
  assert.ok(head, "committed catalog retains task identity");
  const body = await readFile(join(directory, "task-ledger", head.body));
  assert.equal(digest(body), head.body, "immutable task body checksum");
  assert.equal(body.length, head.hot_bytes, "immutable task body bounds");
  const task = JSON.parse(body);
  assert.equal(task.id, owner.taskId);
  return { task, rootDigest: digest(bytes), readAt: Date.now() };
}
async function newOwner(objective, at, misfire = { kind: "coalesce" }) {
  const owner = await call("projectless", { operation: "prepare", requestId: randomUUID() });
  await call("connect", { projectId: owner.projectId });
  const source = await call("create", { projectId: owner.projectId, requestId: randomUUID() });
  const task = await call("manage", {
    operation: "taskCreate",
    projectId: owner.projectId,
    requestId: randomUUID(),
    mode: "scheduled",
    objective,
    sourceThreadId: source.threadId,
    interactionMode: "interactive",
    scheduleV2: {
      version: 1,
      rule: { kind: "onceIso", atIso: isoSeconds(at) },
      misfire,
      overlap: "skip",
    },
  });
  return { projectId: owner.projectId, root: owner.cwd, taskId: task.id, at };
}
try {
  await launch();
  const primary = join(scratch, "primary");
  await mkdir(primary);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, primary);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  primaryId = (
    await until(
      async () =>
        (await snapshot()).projects.find(
          (project) => project.root === primary && project.state?.connected,
        ),
      "primary ready",
    )
  ).id;
  const firstDue = Math.floor(Date.now() / 1000) + 60;
  for (let index = 0; index < 5; index++)
    owners.push(await newOwner(`SCHEDULE_UNOPENED_${index}`, firstDue + index * 8));
  await page.evaluate((id) => localStorage.setItem("areal-gui:project", id), primaryId);
  await stopFixture();
  await launch();
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await check("unopened-due-admission", async () => {
    for (const owner of owners) {
      const committed = await until(
        async () => {
          const read = await persisted(owner);
          return read.task.runs.length && read;
        },
        `unopened owner ${owner.projectId} admitted`,
        Math.max(1000, owner.at * 1000 + 8000 - Date.now()),
      );
      const run = committed.task.runs[0];
      samples.push({
        ms: committed.readAt - owner.at * 1000,
        scheduledAt: owner.at,
        observedAt: committed.readAt,
        taskId: owner.taskId,
        runId: run.id,
        rootDigest: committed.rootDigest,
      });
      assert.equal(
        committed.task.runCount,
        1,
        "one scheduled occurrence admits exactly one durable Run",
      );
      assert.equal(run.scheduledAt, owner.at);
      assert.ok(
        samples.at(-1).ms <= 5000,
        "ready owner due-to-observed durable admission must be within5s",
      );
    }
    return sampleSummary(samples);
  });
  await check("all-five-exactly-once", async () => {
    const rows = await Promise.all(owners.map(persisted));
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.task.runCount === 1));
    assert.ok(requests.length > 0, "deterministic model actually received admitted work");
    return rows.map((row) => ({
      id: row.task.id,
      runCount: row.task.runCount,
      rootDigest: row.rootDigest,
    }));
  });
  const owner = owners[0];
  await call("connect", { projectId: owner.projectId });
  await until(
    async () =>
      (await persisted(owner)).task.runs.every((run) =>
        ["completed", "failed", "cancelled"].includes(run.status),
      ),
    "first owner settled",
  );
  await check("explicit-stop-is-respected", async () => {
    let task = await call("manage", {
      operation: "task",
      projectId: owner.projectId,
      taskId: owner.taskId,
    });
    task = await call("manage", {
      operation: "taskPause",
      projectId: owner.projectId,
      taskId: task.id,
      expectedRevision: task.revision,
    });
    task = await call("manage", {
      operation: "taskUpdate",
      projectId: owner.projectId,
      taskId: task.id,
      expectedRevision: task.revision,
      scheduleV2: {
        version: 1,
        rule: {
          kind: "intervalIso",
          atIso: isoSeconds(Math.ceil(Date.now() / 1000) + 15),
          intervalSeconds: 2,
        },
        misfire: { kind: "coalesce" },
        overlap: "skip",
      },
    });
    task = await call("manage", {
      operation: "taskResume",
      projectId: owner.projectId,
      taskId: task.id,
      expectedRevision: task.revision,
    });
    assert.equal(task.paused, false);
    assert.ok(
      task.nextRunAt !== null,
      "stopped owner would otherwise remain eligible for startup activation",
    );
    const beforeCount = task.runCount;
    const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      const hello = await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      const target = hello.service.targets.find((target) => target.projectId === owner.projectId);
      assert.ok(target);
      const receipt = await connection.request(
        "lifecycleRequest",
        {
          protocol: metadata.protocol,
          requestId: randomUUID(),
          kind: "stopProject",
          mode: "cancel",
          expectedDesktopGeneration: metadata.desktopGeneration,
          expectedTargets: [
            {
              projectId: target.projectId,
              serviceId: target.serviceId,
              generation: target.generation,
            },
          ],
        },
        true,
      );
      assert.equal(receipt.phase, "completed");
      const stoppedAt = Date.now();
      assert.ok(
        stoppedAt < task.nextRunAt * 1000,
        "stop must finish before the scheduled occurrence",
      );
      await call("tasks", { operation: "observe", limit: 1024 });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, task.nextRunAt * 1000 + 3000 - Date.now())),
      );
      const trace = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      assert.deepEqual(
        trace.filter((event) => event.projectId === owner.projectId && event.at > stoppedAt),
        [],
        "passive directory and coordinator do not undo explicitstop",
      );
      assert.equal(
        (await persisted(owner)).task.runCount,
        beforeCount,
        "stopped generation admits no further due Run",
      );
      return { receipt, stoppedAt, beforeCount };
    } finally {
      connection.close();
    }
  });
  const quitAt = Math.floor(Date.now() / 1000) + 30;
  const offline = await newOwner("SCHEDULE_QUIT_COALESCE", quitAt);
  const skipped = await newOwner("SCHEDULE_QUIT_SKIP", quitAt, {
    kind: "skip",
    maxLatenessSeconds: 0,
  });
  await page.evaluate((id) => localStorage.setItem("areal-gui:project", id), primaryId);
  await quit();
  assert.ok(Date.now() < quitAt * 1000, "app quit before the scheduled occurrence");
  await until(
    () => Date.now() > quitAt * 1000 + 2500,
    "offline occurrence elapsed",
    Math.max(1000, quitAt * 1000 + 5000 - Date.now()),
  );
  await check("quit-has-no-new-admission", async () => {
    const read = await Promise.all([persisted(offline), persisted(skipped)]);
    assert.ok(read.every((value) => value.task.runCount === 0));
    return read.map((value) => ({
      id: value.task.id,
      runCount: value.task.runCount,
      rootDigest: value.rootDigest,
    }));
  });
  await launch();
  await check("reopen-applies-saved-misfire", async () => {
    const coalesced = await until(
      async () => {
        const read = await persisted(offline);
        return read.task.runCount === 1 && read;
      },
      "coalesced unopened owner after reopen",
      10000,
    );
    const missed = await until(
      async () => {
        const read = await persisted(skipped);
        return read.task.nextRunAt === null && read;
      },
      "saved skip policy after reopen",
      10000,
    );
    assert.equal(missed.task.runCount, 0);
    assert.equal(missed.task.lastTriggerDecision?.outcome?.kind, "missedWindow");
    assert.equal(coalesced.task.runCount, 1);
    return { coalesced: coalesced.task, skipped: missed.task };
  });
  await page.screenshot({ path: join(evidence, "final.png") });
  await writeFile(join(evidence, "final.aria.txt"), await page.locator("body").ariaSnapshot());
} catch (error) {
  failure = error.stack;
  if (page) await page.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
} finally {
  await stopFixture().catch((error) => {
    failure ??= error.stack;
  });
  await fixture.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (digest(await readFile(binary)) !== identity.binarySha256)
    failure ??= "Core binary changed during run";
  const result = {
    passed: !failure && errors.length === 0 && checks.every((check) => check.passed),
    mode,
    failure,
    identity,
    scratch,
    evidence,
    owners,
    samples,
    summary: sampleSummary(samples),
    checks,
    errors,
    cleanup,
    boundaries: [
      "Real source Electron/Desktop/Core with local deterministic model and public project/task/lifecycle commands.",
      "No task read command is issued while observing unopened-owner admission. Immutable body/root hashes are read without starting Core.",
      "Due latency is an upper bound from scheduled wall time to observer seeing a Run in committed root, including25ms observation polling.",
      "First5future owners have staggered due times8s apart to avoid concurrent model work.",
      "UNKNOWN/no-replay and unsettled tool cleanup are covered only by separately executed recovery regressions, not this script.",
    ],
  };
  await saveScheduleEvidence(evidence, "manifest", result);
  await saveScheduleEvidence(evidence, "model-requests", requests);
  console.log(`Evidence: ${evidence}`);
  console.log(
    JSON.stringify({ passed: result.passed, summary: result.summary, checks, failure }, null, 2),
  );
  if (failure || (mode === "accept" && !result.passed)) process.exitCode = 1;
}
