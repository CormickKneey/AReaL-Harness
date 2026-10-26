import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
const relayUrl = process.env.AREAL_NAMING_RELAY_URL;
const scenario = "completed";
const responseMode = relayUrl ? "real-provider-relay" : "plain";
if (relayUrl)
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(relayUrl).hostname),
    "Naming relay must be loopback",
  );
assert.ok(isAbsolute(binary), "Core binary must be absolute");
const title = "单字符回复测试";
const prompt = `${"1".repeat(41)} 只回复1`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
await mkdir(join(root, ".scratch/session-name"), { recursive: true });
const evidence = await mkdtemp(join(root, ".scratch/session-name/run-"));
const state = await makeTempDir("av-");
const run = { evidence, state, owner: randomUUID(), scenario, responseMode };
await writeFile(join(state, ".owner"), run.owner);
await json(join(evidence, "run.json"), run);
console.log(`Evidence: ${evidence}`);
console.log(
  "Failure modes: completed title remains raw prompt; naming includes tools; sidebar/header differ from Core; isolated cleanup fails.",
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_GUI_USER_DATA: join(state, "electron"),
  AREAL_CORE_HOME: join(state, "core"),
  AREAL_CORE_USER_HOME: join(state, "user"),
  AREAL_HARNESS_HOME: join(state, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(state, "registry"),
  AREAL_CORE_CONFIG: join(state, "config.toml"),
  AREAL_CORE_DESKTOP_CONFIG: join(state, "desktop.json"),
});
env.NO_PROXY = env.no_proxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1,localhost,::1"]
  .filter(Boolean)
  .join(",");
const requests = [],
  actions = [],
  errors = [],
  stderr = [];
let app, page, server, application, threadId, failure, cleanup, identity;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (value) => value.projects.find((item) => item.root === join(state, "workspace"));
const thread = (value) => project(value)?.state?.threads?.[threadId];
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timeout: ${label}`);
}
async function record(action) {
  actions.push({ at: new Date().toISOString(), action });
  await json(join(evidence, "actions.json"), actions);
}
async function capture(name) {
  const value = await snapshot();
  await json(join(evidence, `${name}.snapshot.json`), value);
  await json(join(evidence, `${name}.titles.json`), {
    core: thread(value),
    sidebar: threadId
      ? await page
          .getByTestId(`task-item-${threadId}`)
          .locator(".navigation-task-title")
          .textContent()
      : null,
    header: threadId ? await page.locator(".header-task").textContent() : null,
  });
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
}
async function sourceIdentity() {
  const files = [
    "app/src/core/main.cjs",
    "app/src/core/preload.cjs",
    "renderer/src/App.tsx",
    "scripts/session-name-smoke.mjs",
    "renderer/dist/index.html",
  ];
  for (const file of await readdir(join(gui, "renderer/dist"), { recursive: true }))
    if (/\.(js|css)$/.test(file)) files.push(`renderer/dist/${file}`);
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    diffSHA256: sha(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root })),
    files: Object.fromEntries(
      await Promise.all(files.map(async (file) => [file, sha(await readFile(join(gui, file)))])),
    ),
    binary,
    coreSHA256: sha(await readFile(binary)),
    coreVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
    electron: require("electron/package.json").version,
    playwright: require("playwright-core/package.json").version,
  };
}
const chunk = (delta) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
const finish = (reason) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
try {
  identity = await sourceIdentity();
  await json(join(evidence, "identity.json"), identity);
  await mkdir(join(state, "workspace"));
  await mkdir(join(state, "user/.areal"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: join(state, "workspace"), stdio: "ignore" });
  server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      const kind = body.messages?.some(
        (message) =>
          message.role === "system" &&
          JSON.stringify(message.content).includes("Generate a concise semantic session title"),
      )
        ? "sessionName"
        : "turn";
      requests.push({ kind, body });
      await json(join(evidence, "model-requests.json"), requests);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (kind === "sessionName") {
        assert.equal(body.tools?.length ?? 0, 0, "Naming request must exclude tools");
        if (relayUrl) {
          const upstream = await fetch(relayUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
          });
          assert.equal(upstream.ok, true, "Naming relay accepted synthetic data");
          response.end(await upstream.text());
        } else response.end(chunk({ content: title }) + finish("stop"));
      } else {
        response.write(chunk({ content: "1" }));
        response.end(finish("stop"));
      }
    } catch (error) {
      errors.push(error.stack);
      response.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\nreasoning_effort="high"\n[model.providers.fixture]\nname="Fixture"\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
  );
  await json(env.AREAL_CORE_DESKTOP_CONFIG, {
    profiles: [
      {
        id: "naming",
        revision: "v1",
        displayName: "Naming fixture",
        instructions: "Reply to the user.",
      },
    ],
  });
  await mkdir(env.AREAL_CORE_HOME, { recursive: true });
  await json(join(env.AREAL_CORE_HOME, "projects.json"), [
    { id: sha(join(state, "workspace")).slice(0, 24), root: join(state, "workspace") },
  ]);
  application = await applicationFixture(gui, join(state, "application"));
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (part) => stderr.push(String(part)));
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "desktop ready");
  const doctor = await app.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      pid: process.pid,
      userData: app.getPath("userData"),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    };
  });
  assert.equal(doctor.userData, env.AREAL_GUI_USER_DATA);
  assert.deepEqual(
    [doctor.sandbox, doctor.contextIsolation, doctor.nodeIntegration],
    [true, true, false],
  );
  const metadata = JSON.parse(await readFile(join(state, "core/service.json"), "utf8"));
  const observer = new ServiceConnection();
  try {
    await observer.connect(metadata);
    await observer.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
  } finally {
    observer.close();
  }
  await json(join(evidence, "doctor.json"), {
    ...doctor,
    adapterPid: metadata.pid,
    coreSHA256: identity.coreSHA256,
  });
  await app.evaluate(
    ({ BrowserWindow, dialog }, workspace) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 960);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    },
    join(state, "workspace"),
  );
  await record("Use isolated registered project and create conversation through GUI");
  await until(async () => project(await snapshot())?.state?.connected, "project connected");
  await createProjectConversation(page, "workspace");
  await page.getByTestId("chat-input").fill(prompt);
  await capture("01-before-send");
  await record("Send repeated-digit reply request through Composer");
  await page.getByTestId("chat-send-button").click();
  await until(async () => {
    threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    return threadId && thread(await snapshot())?.turns?.length === 1;
  }, "first turn accepted");
  await capture("02-after-send");
  await until(
    async () => thread(await snapshot())?.turns?.[0]?.status === "completed",
    "first turn completed",
  );
  await page.getByText("1", { exact: true }).waitFor();
  await capture("03-completed-turn");
  await until(
    async () => thread(await snapshot())?.name === title,
    "semantic title replaces raw prompt",
  );
  await capture("04-named");
  assert.equal(
    await page.getByTestId(`task-item-${threadId}`).locator(".navigation-task-title").textContent(),
    title,
  );
  assert.equal(await page.locator(".header-task").textContent(), title);
  assert.equal(
    requests.filter((request) => request.kind === "sessionName").length,
    1,
    "One automatic naming attempt",
  );
  assert.equal(
    requests.filter((request) => request.kind === "turn").length,
    1,
    "One submitted turn",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(failure);
  if (page) {
    await capture("failure").catch(() => {});
    await captureSmokeFailure(page, evidence, error);
    await json(join(evidence, "failure.snapshot.json"), await snapshot().catch(() => null));
  }
} finally {
  if (app) {
    await app
      .evaluate(({ BrowserWindow, app }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
        app.exit(0);
      })
      .catch((error) => errors.push(`GUI close: ${error.message}`));
    await app.close().catch(() => {});
  }
  await application?.close().catch((error) => errors.push(`Application close: ${error.message}`));
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    const metadata = await readFile(join(state, "core/service.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    await assertApplicationStopped(binary, env, metadata);
    await rm(state, { recursive: true });
    cleanup = { adapterExited: true, coreStopped: true, stateRemoved: true };
  } catch (error) {
    cleanup = { failed: true, stateRetained: state, error: error.message };
    errors.push(`Cleanup: ${error.message}`);
  }
  const after = await sourceIdentity().catch((error) => ({ error: error.message }));
  const coreUnchanged = identity?.coreSHA256 === after.coreSHA256;
  if (!coreUnchanged) errors.push("Core binary changed during verification");
  await json(join(evidence, "model-requests.json"), requests);
  await writeFile(join(evidence, "electron.stderr.log"), stderr.join(""));
  await json(join(evidence, "cleanup.json"), cleanup);
  const passed = !failure && errors.length === 0 && cleanup?.stateRemoved === true;
  await json(join(evidence, "manifest.json"), {
    passed,
    scenario,
    responseMode,
    title,
    prompt,
    threadId,
    failure,
    errors,
    cleanup,
    identity,
    identityAfter: after,
    coreUnchanged,
    namingBudgets: requests
      .filter((request) => request.kind === "sessionName")
      .map(({ body }) => ({
        model: body.model,
        reasoningEffort: body.reasoning_effort,
        maxTokens: body.max_tokens,
        maxCompletionTokens: body.max_completion_tokens,
        tools: body.tools ?? [],
      })),
    scope: `Source Electron/Core; registered isolated project; actual new-conversation/send UI. ${relayUrl ? "Real naming provider via loopback relay, synthetic solving." : "Synthetic SSE model."} No package or physical input verification.`,
  });
  console.log(JSON.stringify({ passed, scenario, responseMode, evidence, cleanup }));
  if (!passed) process.exitCode = 1;
}
