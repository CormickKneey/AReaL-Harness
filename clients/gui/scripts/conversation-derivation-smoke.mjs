// M1/M2 公开路径：集成且 GUI、Core 构建完成后运行一次。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
const evidenceRoot = join(root, ".scratch", "gui-evidence");
await mkdir(evidenceRoot, { recursive: true });
const scratch = await mkdtemp(join(evidenceRoot, "conversation-derivation-"));
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
const unicodeExcerpt = `旁路选区🌊汉字_${randomUUID()}`;
const sideQuestion = `SCF_SIDE_${randomUUID()}`;
const sideFollowUp = `SCF_SIDE_FOLLOW_${randomUUID()}`;
const lateSentinel = `SCF_LATE_${randomUUID()}`;
const mainDraftSentinel = `SCF_MAIN_DRAFT_${randomUUID()}`;
const toolStarted = join(workspace, "source-tool-started.txt");
const toolRelease = join(workspace, "source-tool-release.txt");
const requests = [];
const events = [];
const checks = [];
const frames = [];
const pageErrors = [];
const electronStderr = [];
let app, page, server, passed = false, failure;
let sourceThreadId, targetThreadId, anchorTurnId, projectId, sandbox, sideThreadId, windowBounds, videoPath, restartVideoPath, firstMutations = [];
let beforeThreadId, activeTurnId;

const sse = answer => [
  { id: "scf-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] },
  { id: "scf-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
const toolSse = (name, args) => [
  { id: "scf-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `scf-call-${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { id: "scf-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
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
async function untilFile(path, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await stat(path).then(() => true, () => false)) return;
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
      // 来源长工具必须由 Core/Runtime 真正执行，文件标记确认其已启动。
      if (lastUser?.content === activeQuestion && !body.messages.some(message => message.role === "tool")) {
        const command = `printf started > '${toolStarted}'; while [ ! -f '${toolRelease}' ]; do sleep 0.1; done; printf finished`;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(toolSse("run_command", { argv: ["/bin/sh", "-c", command], cwd: "workspace://repo", timeoutMs: 120000 }));
        return;
      }
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
  const videoDir = join(scratch, "video");
  await mkdir(videoDir);
  const launchOptions = { executablePath: require("electron"), args: [desktop], env, timeout: 120000,
    recordVideo: { dir: videoDir, size: { width: 1440, height: 960 } } };
  app = await electron.launch(launchOptions);
  app.process().stderr.on("data", chunk => {
    electronStderr.push(String(chunk));
    if (String(chunk).includes("Error")) process.stderr.write(chunk);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  windowBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
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
  await app.evaluate(({ app }, connectionPath) => {
    const read = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
    const { ServiceConnection } = read(connectionPath);
    const original = ServiceConnection.prototype.request;
    globalThis.__scfMutations = [];
    ServiceConnection.prototype.request = async function (method, parameters, mutation) {
      globalThis.__scfConnection = this;
      if (method !== "command") {
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
  const first = await send(`${head} ${unicodeExcerpt}`);
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
  // 用户原文与模型回显都含 head；只断言持久来源用户消息这一项。
  await inherited.locator(".fork-history-item").filter({ has: page.getByText("原提问", { exact: true }) })
    .locator("[data-inherited-content]").getByText(`${head} ${unicodeExcerpt}`, { exact: true }).waitFor();
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
  await untilFile(toolStarted, "Core/Runtime source command marker");
  const sourceProject = (await state()).projects[0];
  const sourceConfig = sourceProject.configurations?.[sourceThreadId];
  assert.ok(Number.isInteger(sourceConfig?.revision) && sourceConfig.revision > 0,
    "source must have an actual Core configuration before retention check");
  assert.equal(requests.at(-1)?.body?.model, "fixture", "the running source request must use the configured fixture model");
  const mainConfigBefore = JSON.stringify(sourceConfig);
  await page.getByTestId("chat-input").fill(mainDraftSentinel);
  await page.locator('.composer-dock input[type="file"]').setInputFiles({ name: "main-attachment.txt", mimeType: "text/plain", buffer: Buffer.from("keep this main attachment") });
  await page.getByTestId("composer-attachments").getByText("main-attachment.txt").waitFor();
  assert.equal(running.projects[0].state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  checks.push("AC30: source run_command entered the real Core/Runtime process and remains held while Side begins");
  await shot("04-source-tool-running.png");
  // Select a Unicode substring from the persisted first Turn, through the actual message selection UI.
  await page.evaluate(({ turnId, excerpt }) => {
    const turn = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    const body = turn?.querySelector("[data-side-item-id] .conversation-markdown");
    if (!body) throw Error("source message body missing");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(excerpt);
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + excerpt.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw Error("Unicode selection was not in one persisted text node");
  }, { turnId: anchorTurnId, excerpt: unicodeExcerpt });
  await page.getByRole("button", { name: "在旁路中询问所选内容" }).click();
  const sidePane = page.getByRole("region", { name: "旁路讨论" });
  await sidePane.locator("blockquote.notice").filter({ hasText: unicodeExcerpt }).waitFor();
  assert.match(await sidePane.innerText(), /已持久化选区/);
  await sidePane.getByLabel("文件访问范围").selectOption("none");
  assert.equal(await sidePane.getByLabel("文件访问范围").inputValue(), "none");
  await sidePane.getByRole("textbox", { name: "旁路问题" }).fill(sideQuestion);
  const composingRequests = requests.length;
  await sidePane.getByRole("textbox", { name: "旁路问题" }).evaluate(element => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
  });
  assert.equal(requests.length, composingRequests, "IME composition Enter must not submit Side");
  assert.equal(await sidePane.getByRole("textbox", { name: "旁路问题" }).inputValue(), sideQuestion);
  assert.ok(await sidePane.getByRole("textbox", { name: "旁路问题" }).evaluate(element => document.activeElement === element),
    "composition must retain focus in Side editor");
  const narrowBounds = await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(980, 800); return win.getBounds(); });
  events.push({ narrowBounds });
  assert.equal(narrowBounds.width, 980, "native window should reach its configured minimum width");
  assert.ok(await sidePane.getByRole("textbox", { name: "旁路问题" }).isVisible());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  const sideStartRequests = requests.length;
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  const sideStarted = await until(s => Object.values(s.projects[0]?.state?.threads ?? {}).some(t =>
    t.conversation?.kind === "side" && t.conversation.origin?.sourceThreadId === sourceThreadId &&
    t.turns?.at(-1)?.status === "completed"), "Side first answer during source Runtime tool");
  const side = Object.values(sideStarted.projects[0].state.threads).find(t => t.conversation?.kind === "side" && t.conversation.origin?.sourceThreadId === sourceThreadId);
  sideThreadId = side.id;
  assert.equal(side.conversation.policy?.workspaceAccess, "none", "frozen evidence journey uses session-only Side policy");
  assert.equal(side.conversation.selection?.text, unicodeExcerpt);
  assert.equal(side.conversation.selection?.verified, true);
  assert.equal(sideStarted.projects[0].state.threads[sourceThreadId].turns.at(-1).status, "inProgress");
  assert.ok((await readFile(toolStarted, "utf8")).includes("started"));
  const sideModelInput = JSON.stringify(requests.slice(sideStartRequests).flatMap(r => r.body.messages ?? []));
  assert.ok(sideModelInput.includes(sideQuestion) && sideModelInput.includes(unicodeExcerpt));
  assert.ok(!sideModelInput.includes(lateSentinel));
  await sidePane.getByRole("button", { name: "查看冻结证据" }).click();
  await sidePane.getByRole("region", { name: "冻结证据" }).locator("pre").filter({ hasText: unicodeExcerpt }).first().waitFor();
  await shot("05-side-answered-frozen.png");
  checks.push("AC30/39: Side answers during a live source Runtime command; Unicode source selection is verified and frozen evidence is visible");
  const beforeBring = { requests: requests.length, commands: (await app.evaluate(() => globalThis.__scfMutations)).length,
    sourceTurns: sideStarted.projects[0].state.threads[sourceThreadId].turns.length,
    sideTurns: side.turns.length, workspaceSha256: await hash(fixturePath) };
  await sidePane.getByRole("button", { name: "带回整条回复" }).first().click();
  const preview = sidePane.getByRole("region", { name: "带回预览" });
  await preview.waitFor();
  const brought = await preview.getByRole("textbox", { name: "编辑带回文字" }).inputValue();
  assert.ok(brought.includes(sideQuestion));
  await preview.getByRole("button", { name: "确认插入主草稿" }).click();
  await sidePane.getByText(/已插入主会话草稿/).waitFor();
  const mainDraft = await page.evaluate(key => localStorage.getItem(key), `areal-gui:draft:${projectId}:${sourceThreadId}`);
  assert.ok(mainDraft?.includes(mainDraftSentinel) && mainDraft.includes(brought),
    "actual main Composer draft must retain its previous text and append the confirmed Side answer");
  assert.equal(requests.length, beforeBring.requests, "bring-back must not send or steer");
  assert.equal((await app.evaluate(() => globalThis.__scfMutations)).length, beforeBring.commands,
    "bring-back must not issue any Core command, including queue or steer");
  assert.equal((await state()).projects[0].state.threads[sourceThreadId].turns.length, beforeBring.sourceTurns);
  assert.equal((await state()).projects[0].state.threads[sideThreadId].turns.length, beforeBring.sideTurns);
  assert.equal(await hash(fixturePath), beforeBring.workspaceSha256);
  await shot("06-bring-back-draft.png");
  await page.getByRole("button", { name: "关闭面板", exact: true }).click();
  await page.getByTestId("composer-attachments").getByText("main-attachment.txt").waitFor();
  const mainImeRequests = requests.length;
  await page.getByTestId("chat-input").evaluate(element => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
  });
  assert.equal(requests.length, mainImeRequests, "IME composition Enter must not send, steer, or queue main draft");
  assert.ok((await page.getByTestId("chat-input").innerText()).includes(brought));
  assert.equal(JSON.stringify((await state()).projects[0].configurations?.[sourceThreadId] ?? null), mainConfigBefore,
    "main model configuration must survive Side and bring-back");
  await page.getByRole("button", { name: "打开侧边面板标签页" }).click();
  await page.getByRole("menuitem", { name: "旁路讨论" }).click();
  await sidePane.getByRole("region", { name: "相关讨论" }).getByRole("button", { name: new RegExp(sideQuestion) }).waitFor();
  assert.equal((await state()).projects[0].state.threads[sideThreadId].id, sideThreadId);
  checks.push("AC46/47/54: bring-back changed only the main local draft; hiding and reopening preserved the same Side identity");
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
  await beforeHistory.getByText(future, { exact: true }).waitFor();
  assert.equal(await beforeHistory.getByText(activeQuestion, { exact: false }).count(), 0);
  await shot("07-before-active.png");
  await writeFile(toolRelease, "release\n");
  await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.at(-1)?.status === "completed", "source completes independently");
  assert.ok(JSON.stringify((await state()).projects[0].state.threads[sourceThreadId].turns.at(-1)).includes("finished"));
  assert.equal(await hash(fixturePath), workspaceBefore);
  checks.push("AC18/19: active Turn after is disabled, before creates an idle exact prefix, and the source completes independently");
  await selectConversation(page, sourceThreadId);
  const late = await send(lateSentinel, sourceThreadId);
  assert.ok(late.turnId);
  assert.match(await sidePane.innerText(), /来源已推进/);
  const previousSideTurns = (await state()).projects[0].state.threads[sideThreadId].turns.length;
  const followStart = requests.length;
  await sidePane.getByRole("textbox", { name: "旁路问题" }).fill(sideFollowUp);
  await sidePane.getByRole("button", { name: "发送", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sideThreadId]?.turns?.length > previousSideTurns &&
    s.projects[0].state.threads[sideThreadId].turns.at(-1).status === "completed", "Side follow-up from frozen history");
  const followInput = JSON.stringify(requests.slice(followStart).flatMap(request => request.body.messages ?? []));
  assert.ok(followInput.includes(sideFollowUp) && followInput.includes(sideQuestion));
  assert.ok(!followInput.includes(lateSentinel), "later source Turn must never enter old Side model context");
  await sidePane.getByRole("button", { name: "查看冻结证据" }).click();
  const frozen = await sidePane.getByRole("region", { name: "冻结证据" }).innerText();
  assert.ok(frozen.includes(unicodeExcerpt) && !frozen.includes(lateSentinel));
  await shot("08-side-after-source-progress.png");
  checks.push("AC39: later source sentinel is excluded from old Side follow-up model request and paged frozen evidence");
  const related = sidePane.getByRole("region", { name: "相关讨论" });
  await related.getByRole("button", { name: "刷新" }).click();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await related.getByRole("button", { name: "归档", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sideThreadId]?.desktop?.archived === true, "Side archived");
  assert.ok(await sidePane.getByRole("textbox", { name: "旁路问题" }).isDisabled());
  await related.getByRole("checkbox", { name: "包含已归档" }).check();
  await related.getByRole("button", { name: /已归档/ }).waitFor();
  await related.getByRole("button", { name: "恢复", exact: true }).click();
  await until(s => s.projects[0]?.state?.threads?.[sideThreadId]?.desktop?.archived === false, "Side unarchived");
  assert.equal((await state()).projects[0].state.threads[sideThreadId].turns.length, previousSideTurns + 1);
  checks.push("AC48/51: archived Side is listed under related discussions and explicitly restored without a new Turn");
  const beforeDisconnect = (await state()).projects[0];
  await app.evaluate(() => globalThis.__scfConnection.socket.terminate());
  await until(s => s.connection?.state === "unavailable", "GUI-to-Core transport disconnect");
  await page.getByRole("button", { name: "重新连接后台" }).click();
  const reconnected = await until(s => s.connection?.state === "ready" && s.projects[0]?.state?.connected &&
    s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.length === beforeDisconnect.state.threads[sourceThreadId].turns.length &&
    s.projects[0]?.state?.threads?.[sideThreadId]?.turns?.length === beforeDisconnect.state.threads[sideThreadId].turns.length,
  "GUI-to-Core reconnection and authoritative source/Side snapshot");
  assert.equal(reconnected.projects[0].state.threads[sideThreadId].conversation.origin.sourceThreadId, sourceThreadId);
  assert.equal(reconnected.projects[0].state.threads[sourceThreadId].conversation?.kind ?? "main", "main");
  checks.push("AC49: real GUI transport disconnect/reconnect restored distinct source and Side identities without duplicate Turns");
  // Restart is a second, explicitly identified video segment using the same isolated state roots.
  const preRestart = { sourceTurns: (await state()).projects[0].state.threads[sourceThreadId].turns.length,
    sideTurns: (await state()).projects[0].state.threads[sideThreadId].turns.length, requests: requests.length };
  firstMutations = await app.evaluate(() => globalThis.__scfMutations);
  const forkResults = firstMutations.filter(entry => entry.command === "fork" && entry.accepted);
  assert.deepEqual(forkResults.map(entry => entry.resultThreadId), [targetThreadId, beforeThreadId]);
  assert.ok(forkResults.every(entry => typeof entry.requestId === "string" && entry.requestId.length > 0));
  assert.equal(new Set(forkResults.map(entry => entry.requestId)).size, 2);
  videoPath = await page.video()?.path();
  await app.close();
  app = await electron.launch(launchOptions);
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(s => s.projects.some(project => project.id === projectId && project.state?.connected), "restarted Core connection");
  await selectConversation(page, sourceThreadId);
  const restored = await until(s => s.projects[0]?.state?.threads?.[sourceThreadId]?.turns?.length === preRestart.sourceTurns &&
    s.projects[0]?.state?.threads?.[sideThreadId]?.turns?.length === preRestart.sideTurns, "restarted source and Side identity");
  await page.getByRole("tab", { name: "旁路讨论" }).click();
  await page.getByRole("region", { name: "旁路讨论" }).getByRole("region", { name: "相关讨论" })
    .getByRole("button", { name: new RegExp(sideQuestion) }).waitFor();
  assert.equal(restored.projects[0].state.threads[sideThreadId].conversation.origin.sourceThreadId, sourceThreadId);
  assert.equal(requests.length, preRestart.requests, "restart must not repeat unknown Side submission");
  restartVideoPath = await page.video()?.path();
  await shot("09-restarted-identities.png");
  checks.push("AC47: Electron restart restored the same sent Side and source Turn IDs without another model request");
  assert.deepEqual(pageErrors, []);
  passed = true;
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(error);
  await writeFile(join(scratch, "failure.log"), [failure, ...electronStderr, ...pageErrors].join("\n"));
  if (page) frames.push(...(await captureSmokeFailure(page, scratch, error)).filter(name => name.endsWith(".png")));
  process.exitCode = 1;
} finally {
  await writeFile(toolRelease, "cleanup\n");
  if (app) {
    if (!firstMutations.length) try { firstMutations = await app.evaluate(() => globalThis.__scfMutations ?? []); } catch (error) { events.push({ requestCaptureError: error.message }); }
    try {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      if (videoPath) restartVideoPath = await page?.video()?.path();
      else videoPath = await page?.video()?.path();
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
  const videos = await readdir(join(scratch, "video")).catch(() => []);
  if (!videoPath && videos.length === 1) videoPath = join(scratch, "video", videos[0]);
  const sourceDiff = execFileSync("git", ["diff", "--binary"], { cwd: root });
  const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
  const manifest = {
    passed, failure, checks, events, pageErrors, electronStderr, frames, sourceCommit,
    command: "pnpm --dir clients/gui run test:conversation-derivation",
    runtime: "source Electron renderer + Rust Core + actual Runtime run_command + deterministic local HTTP/SSE model",
    limitations: ["local fixture model, not a real provider", "source build, not a copied installed package", "native project chooser and archive confirmation are fixtures and have no native-dialog acceptance claim", "Browser preview is outside this journey", "IME is a synthetic composition key event, not a physical input method", "Electron minimum window width is 980px, so the 900px layout breakpoint is not exercised"],
    operatingSystem: { platform: process.platform, release: (await import("node:os")).release(), architecture: process.arch },
    windowBounds, videoPath, videoSegments: [{ path: videoPath, process: "initial Electron run", continuous: true },
      { path: restartVideoPath, process: "restarted Electron run", continuous: true }],
    framePredicates: {
      "01-source.png": "two completed source Turns with persisted head and future",
      "02-fork-empty.png": "idle Fork with inherited prefix and no future Turn",
      "03-fork-sent.png": "Fork explicit answer; model input excludes future",
      "04-source-tool-running.png": "Core/Runtime command marker exists and source Turn remains inProgress",
      "05-side-answered-frozen.png": "Side first answer completed while source tool remains active; Unicode selection verified",
      "06-bring-back-draft.png": "preview confirmed; local main draft includes Side text and no Core command was issued",
      "07-before-active.png": "before-active Fork has idle bounded inherited history",
      "08-side-after-source-progress.png": "old Side model request and frozen evidence exclude later source sentinel",
      "09-restarted-identities.png": "second Electron process restored source and Side identities without a new model request",
    },
    sourceDirtyStatus: sourceStatus, sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
    sandbox, binary, binarySha256: await hash(binary).catch(() => null),
    smokeScriptSha256: await hash(fileURLToPath(import.meta.url)),
    sourceThreadId, targetThreadId, beforeThreadId, sideThreadId, anchorTurnId, activeTurnId, projectId,
    fixture: { head, future, forkQuestion, activeQuestion, unicodeExcerpt, sideQuestion, sideFollowUp, lateSentinel, mainDraftSentinel,
      workspace, workspaceSha256Before: workspaceBefore, workspaceSha256After: await hash(fixturePath), toolStarted, toolRelease },
    requests, mutations: firstMutations,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, scratch, checks, failure }));
}
