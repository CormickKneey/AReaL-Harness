// M1 公开路径：SCF-01 至 05 集成且 GUI、Core 构建完成后运行一次。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
const scratch = await mkdtemp("/private/tmp/areal-scf-m1-");
const workspace = join(scratch, "workspace");
const userHome = join(scratch, "user-home");
await mkdir(workspace);
await mkdir(userHome);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const fixturePath = join(workspace, "shared.txt");
await writeFile(fixturePath, "current shared workspace\n");
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const workspaceBefore = await hash(fixturePath);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const head = `SCF_HEAD_${randomUUID()}`;
const future = `SCF_FUTURE_${randomUUID()}`;
const forkQuestion = `SCF_BRANCH_${randomUUID()}`;
const activeQuestion = `SCF_ACTIVE_${randomUUID()}`;
const requests = [];
const events = [];
const checks = [];
const frames = [];
const pageErrors = [];
const electronStderr = [];
let app, page, server, passed = false, failure;
let sourceThreadId, targetThreadId, anchorTurnId, projectId, sandbox;
let beforeThreadId, activeTurnId, releaseActive;
const activeBarrier = new Promise(resolve => { releaseActive = resolve; });

const sse = answer => [
  { id: "scf-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] },
  { id: "scf-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";

async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function until(predicate, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function shot(name) {
  await page.screenshot({ path: join(scratch, name), scale: "css", animations: "disabled" });
  frames.push(name);
}
async function send(text, threadId) {
  const previousCount = threadId ? (await state()).projects[0]?.state?.threads?.[threadId]?.turns?.length ?? 0 : 0;
  const previousRequests = requests.length;
  await page.getByTestId("chat-input").fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(id => {
    const active = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
    return active && (!id || active === id);
  }, threadId);
  const activeId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(activeId);
  if (threadId) assert.equal(activeId, threadId);
  const snapshot = await until(s => {
    const turns = s.projects[0]?.state?.threads?.[activeId]?.turns;
    return turns?.length > previousCount && turns.at(-1)?.status === "completed" && requests.length > previousRequests;
  }, `completed send ${text}`);
  const turns = snapshot.projects[0].state.threads[activeId].turns;
  assert.ok(turns.at(-1)?.id);
  return { threadId: activeId, turnId: turns.at(-1).id };
}
async function stopService(env) {
  // 优先显式停止 Core；失败时只终止此隔离目录注册的服务。
  try {
    const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
    const { ServiceConnection } = require(join(desktop, "src/core/service-client.cjs"));
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request("stopService", { protocol: "areal.desktop-service.v1" }, true);
      checks.push("isolated Core service stopped");
      return;
    } finally { connection.close(); }
  } catch (error) { events.push({ cleanupStopError: error.message }); }
  try {
    const instances = JSON.parse(execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 30000 }));
    for (const instance of instances) if (instance.workspace === workspace && instance.state !== "stopped") {
      execFileSync(binary, ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"], { env, timeout: 30000, stdio: "pipe" });
    }
  } catch (error) { events.push({ cleanupCliError: error.message }); }
  try {
    const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
    if (Number.isInteger(metadata.pid)) process.kill(metadata.pid, "SIGTERM");
  } catch {}
}

console.log("GUI evidence:", scratch);
const env = {
  ...process.env,
  AREAL_GUI: "workbench", AREAL_BACKEND: "areal", AREAL_CORE_BIN: binary,
  AREAL_DEV_CONVERSATION_DERIVATION: "1",
  AREAL_CORE_HOME: join(scratch, "core"), AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
try {
  server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ sequence: requests.length + 1, method: req.method, path: req.url, body });
      const lastUser = body.messages?.findLast(message => message.role === "user");
      const answer = `FIXTURE_OK_${requests.length}: ${typeof lastUser?.content === "string" ? lastUser.content : "received"}`;
      // 固定活动轮次的完成时机，验证创建轮前分支不会等待或取消来源。
      if (lastUser?.content === activeQuestion) await activeBarrier;
      if (body.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(answer));
    } catch (error) {
      events.push({ fixtureError: error.message });
      res.writeHead(400); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const config = join(scratch, "config.toml");
  await writeFile(config, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\n`);
  env.AREAL_CORE_CONFIG = config;
  const deployment = join(scratch, "desktop.json");
  await writeFile(deployment, JSON.stringify({ profiles: [{ id: "standard", revision: "v1", displayName: "标准", instructions: "Reply with plain text", allowThreadProcesses: true, approvalTools: [], skills: [] }] }));
  env.AREAL_CORE_DESKTOP_CONFIG = deployment;
  app = await electron.launch({ executablePath: require("electron"), args: [desktop], env, timeout: 120000 });
  app.process().stderr.on("data", chunk => {
    electronStderr.push(String(chunk));
    if (String(chunk).includes("Error")) process.stderr.write(chunk);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  sandbox = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(sandbox, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(s => s.projects[0]?.state?.connected, "project connection");
  projectId = (await state()).projects[0].id;
  // 共享后台独立运行；在真实连接的返回边界记录 Core 已确认的创建键。
  await app.evaluate((_electron, connectionPath) => {
    const { ServiceConnection } = require(connectionPath);
    const original = ServiceConnection.prototype.request;
    globalThis.__scfMutations = [];
    ServiceConnection.prototype.request = async function (method, parameters, mutation) {
      if (method !== "command" || !["fork", "send"].includes(parameters?.name)) {
        return original.call(this, method, parameters, mutation);
      }
      const entry = { command: parameters.name, parameters: parameters.request, accepted: false };
      globalThis.__scfMutations.push(entry);
      try {
        const result = await original.call(this, method, parameters, mutation);
        entry.accepted = true;
        entry.requestId = result?.requestId ?? parameters.request?.requestId ?? null;
        entry.resultThreadId = result?.threadId ?? result?.thread?.id ?? null;
        return result;
      } catch (error) { entry.error = error.message; throw error; }
    };
  }, join(desktop, "src/core/service-client.cjs"));
  const first = await send(head);
  sourceThreadId = first.threadId;
  anchorTurnId = first.turnId;
  const second = await send(future, sourceThreadId);
  assert.notEqual(second.turnId, anchorTurnId);
  assert.equal(requests.length, 2, "plain-text source should require exactly two fixture requests");
  await shot("01-source.png");
  const sourceTurns = (await state()).projects[0].state.threads[sourceThreadId].turns.map(turn => turn.id);
  const beforeCreation = { modelRequests: requests.length, workspaceSha256: await hash(fixturePath) };
  assert.equal(beforeCreation.workspaceSha256, workspaceBefore);
  const anchor = page.locator(`[data-turn-id="${anchorTurnId}"]`);
  await anchor.getByRole("button", { name: /^轮次操作 / }).click();
  const forkButton = page.getByRole("menuitem", { name: "在此轮之后分支", exact: true });
  await forkButton.click();
  const forkDialog = page.getByRole("dialog", { name: "创建独立分支", exact: true });
  await forkDialog.waitFor();
  const confirmation = await forkDialog.innerText();
  assert.match(confirmation, /共享当前工作区/);
  assert.match(confirmation, /文件不会回滚/);
  events.push({ confirmation });
  assert.equal(await forkDialog.getByLabel("分支目标配置").inputValue(), "inherit");
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await page.getByRole("region", { name: "继承的对话历史", exact: true }).waitFor();
  targetThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  assert.ok(targetThreadId && targetThreadId !== sourceThreadId);
  assert.equal(requests.length, beforeCreation.modelRequests, "fork creation must not call the model");
  assert.equal(await hash(fixturePath), beforeCreation.workspaceSha256, "fork creation must not change files");
  const target = (await state()).projects[0].state.threads[targetThreadId];
  assert.equal(target.conversation?.kind, "fork");
  assert.equal(target.conversation?.origin?.sourceThreadId, sourceThreadId);
  assert.equal(target.conversation?.origin?.sourceTurnId, anchorTurnId);
  assert.equal(target.turns?.length, 0, "target starts with empty local turns");
  const inherited = page.getByRole("region", { name: "继承的对话历史", exact: true });
  await inherited.getByText(head, { exact: false }).waitFor();
  assert.equal(await inherited.getByText(future, { exact: false }).count(), 0, "future source Turn must not appear in inherited history");
  assert.match(await inherited.innerText(), /共享工作区/);
  assert.equal((await page.getByTestId("chat-input").innerText()).trim(), "");
  await shot("02-fork-empty.png");
  checks.push("AC01/02/06: older Turn GUI fork is idle, empty, source-owned, current shared workspace and bounded inherited history");
  await send(forkQuestion, targetThreadId);
  const branchRequest = requests.at(-1)?.body;
  const branchInput = JSON.stringify(branchRequest?.messages ?? []);
  assert.ok(branchInput.includes(head) && branchInput.includes(forkQuestion), "model input must include selected source prefix and explicit new input");
  assert.ok(!branchInput.includes(future), "model input must exclude future source Turn");
  assert.deepEqual((await state()).projects[0].state.threads[sourceThreadId].turns.map(turn => turn.id), sourceTurns);
  assert.equal(await hash(fixturePath), workspaceBefore);
  await shot("03-fork-sent.png");
  checks.push("AC06: actual model input excludes the future sentinel; explicit send leaves source Turn IDs and workspace bytes unchanged");
  await selectConversation(page, sourceThreadId);
  await page.getByTestId("chat-input").fill(activeQuestion);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const running = await until(s => {
    const turn = s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1);
    return turn && !sourceTurns.includes(turn.id) && turn.status === "inProgress"
      && JSON.stringify(requests.at(-1)?.body?.messages ?? []).includes(activeQuestion);
  }, "source active Turn at model barrier");
  activeTurnId = running.projects[0].state.threads[sourceThreadId].turns.at(-1).id;
  const activeAnchor = page.locator(`[data-turn-id="${activeTurnId}"]`);
  await activeAnchor.getByRole("button", { name: /^轮次操作 / }).click();
  const afterActive = page.getByRole("menuitem", { name: "在此轮之后分支", exact: true });
  assert.ok(await afterActive.isDisabled(), "after an active Turn must explain that it is disabled");
  await page.getByText("此轮仍在运行；可选择轮次之前", { exact: true }).waitFor();
  const requestsBeforeActiveFork = requests.length;
  await page.getByRole("menuitem", { name: "在此轮之前分支", exact: true }).click();
  await forkDialog.waitFor();
  const beforeConfirmation = await forkDialog.innerText();
  assert.match(beforeConfirmation, /此轮之前/);
  events.push({ beforeConfirmation });
  await forkDialog.getByRole("button", { name: "创建分支", exact: true }).click();
  await page.waitForFunction(id => {
    const current = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
    return current && current !== id;
  }, sourceThreadId);
  beforeThreadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const beforeSnapshot = await state();
  const beforeThread = beforeSnapshot.projects[0].state.threads[beforeThreadId];
  assert.equal(beforeThread.conversation?.origin?.sourceTurnId, activeTurnId);
  assert.equal(beforeThread.conversation?.origin?.boundary, "before");
  assert.equal(beforeThread.turns?.length, 0);
  assert.equal(beforeSnapshot.projects[0].state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  assert.equal(requests.length, requestsBeforeActiveFork);
  const beforeHistory = page.getByRole("region", { name: "继承的对话历史", exact: true });
  await beforeHistory.getByText(future, { exact: false }).waitFor();
  assert.equal(await beforeHistory.getByText(activeQuestion, { exact: false }).count(), 0);
  await shot("04-before-active.png");
  releaseActive();
  await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1)?.status === "completed", "source completes independently");
  assert.equal(await hash(fixturePath), workspaceBefore);
  checks.push("AC18/19: active Turn after is disabled, before creates an idle exact prefix, and the source completes independently");
  const observed = await app.evaluate(() => globalThis.__scfMutations);
  const forkResults = observed.filter(entry => entry.command === "fork" && entry.accepted);
  assert.deepEqual(forkResults.map(entry => entry.resultThreadId), [targetThreadId, beforeThreadId]);
  assert.ok(forkResults.every(entry => typeof entry.requestId === "string" && entry.requestId.length > 0));
  assert.equal(new Set(forkResults.map(entry => entry.requestId)).size, 2);
  assert.deepEqual(pageErrors, []);
  passed = true;
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(error);
  await writeFile(join(scratch, "failure.log"), [failure, ...electronStderr, ...pageErrors].join("\n"));
  if (page) frames.push(...(await captureSmokeFailure(page, scratch, error)).filter(name => name.endsWith(".png")));
  process.exitCode = 1;
} finally {
  releaseActive();
  let mutations = [];
  if (app) {
    try { mutations = await app.evaluate(() => globalThis.__scfMutations ?? []); } catch (error) { events.push({ requestCaptureError: error.message }); }
    try {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      await app.close();
    } catch (error) {
      events.push({ electronCloseError: error.message }); process.exitCode = 1;
      try { app.process()?.kill("SIGTERM"); } catch {}
    }
  }
  await stopService(env);
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const manifest = {
    passed, failure, checks, events, pageErrors, electronStderr, frames, sourceCommit,
    command: "pnpm --dir clients/gui run test:conversation-derivation",
    runtime: "real sandboxed Electron + Rust Core + deterministic local HTTP/SSE model; no native tool execution in this journey",
    sandbox, binary, binarySha256: await hash(binary).catch(() => null),
    smokeScriptSha256: await hash(fileURLToPath(import.meta.url)),
    sourceThreadId, targetThreadId, beforeThreadId, anchorTurnId, activeTurnId, projectId,
    fixture: { head, future, forkQuestion, activeQuestion, workspace, workspaceSha256Before: workspaceBefore, workspaceSha256After: await hash(fixturePath) },
    requests, mutations,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, scratch, checks, failure }));
}
