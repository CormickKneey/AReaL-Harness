import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSmokeFailure, createProjectConversation, selectConversation } from "./smoke-navigation.mjs";
import { CoreClient } from "../packages/runtime-client/core.js";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection, waitForServiceProcessExit, waitForProcessExit } = require("../app/src/core/service-client.cjs");
const WebSocket = require("ws");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && resolve(binary) === binary, "Set AREAL_CORE_BIN to an existing absolute fixed Core build");
assert.equal(process.env.AREAL_GUI_EXECUTABLE, undefined, "This runner validates the source Electron application");
const sha = value => createHash("sha256").update(value).digest("hex");
const sourceFiles = ["app/src/core/providers.cjs", "app/src/core/model-config.cjs", "app/src/core/backend.cjs",
  "renderer/src/settings/ModelSettings.tsx", "scripts/provider-hot-apply-smoke.mjs", "renderer/dist/index.html"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(join(gui, file)))])));
const coreHashes = Object.fromEntries(await Promise.all(["areal", "areal-runtime", "areal-runtime-fs"].map(async name => [name, sha(await readFile(join(dirname(binary), name)))])));
const scratch = await mkdtemp("/private/tmp/areal-provider-hot-");
const workspace = join(scratch, "workspace");
const userHome = join(scratch, "user");
const config = join(userHome, ".areal/config.toml");
await mkdir(workspace);
await mkdir(dirname(config), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const secrets = { first: `fixture-hot-first-${randomUUID()}`, second: `fixture-hot-second-${randomUUID()}` };
const requests = [], checks = [], errors = [], identities = [], receipts = [], guiProcesses = [];
const ownedPids = new Set();
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions", "Only the local model endpoint is available");
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const credential = Object.keys(secrets).find(label => request.headers.authorization === `Bearer ${secrets[label]}`) ?? "unknown";
    const kind = payload.messages?.some(message => message.role === "system" && JSON.stringify(message.content).includes("Generate a concise semantic session title")) ? "sessionName" : "turn";
    const markers = JSON.stringify(payload.messages).match(/HOT_(?:FIRST_CONVERSATION|OLD_CONVERSATION_AFTER_ROTATION|NEW_CONVERSATION_AFTER_ROTATION|EXPLICIT_SEND_AFTER_REOPEN)/g);
    requests.push({ model: payload.model, credential, kind, marker: markers?.at(-1) ?? null });
    assert.notEqual(credential, "unknown", "A request must use one of this runner's synthetic credentials");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "HOT_APPLY_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    errors.push(`Model fixture: ${error.message}`);
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic model request rejected" } }));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await writeFile(config, `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture-model"\n[model.providers.fixture]\nname="Hot apply fixture"\nenabled=true\nendpoint="${baseUrl}/chat/completions"\nprotocol="chat-completions"\napi_key_env="AREAL_CREDENTIAL_HOT_MISSING"\nmodels=[{id="fixture-model",enabled=true}]\n`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, { AREAL_CORE_BIN: binary, AREAL_CORE_USER_HOME: userHome,
  AREAL_GUI_USER_DATA: join(scratch, "electron"), AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry") });
env.NO_PROXY = env.no_proxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
let app, page, observer, metadata, projectId, passed = false, cleanup;
const button = name => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = snapshot => snapshot.projects.find(item => item.root === workspace);
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const cli = args => JSON.parse(execFileSync(binary, [...args, "--json"], { env, encoding: "utf8", timeout: 20000 }));
async function settled() {
  const { service, snapshot } = await observer.request("snapshot");
  return service.starting === 0 && service.activeCommands === 0 && !service.providerUpdating && !service.busy
    && project(snapshot)?.state?.connected && snapshot.projects.every(item => !item.core?.instanceId || item.state?.connected);
}
async function coreRead() {
  const snapshot = await state();
  const descriptor = cli(["service", "status", "--instance", project(snapshot).core.instanceId]);
  assert.equal(descriptor.workspace, workspace);
  assert.equal(descriptor.dataDir, join(env.AREAL_CORE_HOME, projectId, "state"));
  assert.equal(descriptor.state, "ready");
  const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const token = auth.principals.find(principal => ["observe", "interact", "manage"].every(permission => principal.permissions?.includes(permission)))?.token;
  assert.equal(typeof token, "string");
  const client = new CoreClient({ createSocket: () => new WebSocket(descriptor.endpoint,
    { headers: { Authorization: `Bearer ${token}` }, followRedirects: false, maxPayload: 4 * 1024 * 1024 }) });
  try {
    await client.connect();
    const status = await client.request("areal/server/status");
    const catalog = await client.request("areal/model/list");
    const providers = await client.request("areal/provider/list");
    return { descriptor, status, catalog, providers };
  } finally { client.close(); }
}
function runtimePids(hostPid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), parent: Number(match[2]), executable: basename(match[3]) } : null;
  }).filter(Boolean);
  const descendants = new Set([hostPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.parent) && !descendants.has(row.pid)) {
      descendants.add(row.pid); changed = true;
    }
  }
  return rows.filter(row => descendants.has(row.pid) && row.executable === "areal-runtime").map(row => row.pid).sort((a, b) => a - b);
}
async function identity(label) {
  await until(settled, `${label} backend settles`);
  const { service } = await observer.request("snapshot");
  const { descriptor, status } = await coreRead();
  const value = { desktopPid: service.pid, desktopGeneration: service.lifecycle?.desktopGeneration,
    instanceId: descriptor.serviceId, coreGeneration: descriptor.generation, hostPid: descriptor.hostPid,
    corePid: descriptor.corePid, runtimePids: runtimePids(descriptor.hostPid), runtimeEpoch: status.runtime?.runtimeEpoch };
  assert.equal(typeof value.desktopGeneration, "string", "Read the actual desktop generation");
  assert.equal(typeof value.runtimeEpoch, "string", "Read the actual Runtime epoch");
  assert.equal(value.runtimePids.length, 1, "Observe exactly the Runtime owned by this Core Host");
  assert.equal(service.targets.find(target => target.projectId === projectId)?.generation, value.coreGeneration);
  for (const pid of [value.desktopPid, value.hostPid, value.corePid, ...value.runtimePids]) {
    process.kill(pid, 0); ownedPids.add(pid);
  }
  identities.push({ label, ...value });
  await writeFile(join(scratch, "process-identities.json"), JSON.stringify(identities, null, 2));
  return value;
}
function unchanged(before, after, label) {
  for (const key of ["desktopPid", "desktopGeneration", "instanceId", "coreGeneration", "hostPid", "corePid", "runtimeEpoch"])
    assert.equal(after[key], before[key], `${label} must hot apply without changing ${key}`);
  assert.deepEqual(after.runtimePids, before.runtimePids, `${label} must preserve the actual owned Runtime PID`);
  for (const pid of [before.desktopPid, before.hostPid, before.corePid, ...before.runtimePids]) process.kill(pid, 0);
}
async function openSettings() {
  await button("设置").click();
  await page.getByRole("heading", { name: "模型设置", exact: true }).waitFor();
  await page.locator(".provider-catalog-row").filter({ hasText: "Hot apply fixture" }).click();
  await page.getByRole("tab", { name: "连接配置", exact: true }).click();
}
async function saveProvider(label) {
  const before = await identity(`${label} before`);
  await button("保存").click();
  await button("返回应用").click({ trial: true, timeout: 180000 });
  await until(async () => await button("保存").isDisabled() && await button("返回应用").isEnabled(), `${label} UI save completion`, 180000);
  const saved = await command("providers", { operation: "list" });
  const core = await coreRead();
  receipts.push({ label, revision: saved.revision, pendingApply: saved.pendingApply,
    projects: saved.projects, catalog: core.catalog.data, providers: core.providers.data });
  await writeFile(join(scratch, "apply-receipts.json"), JSON.stringify(receipts, null, 2));
  assert.equal(saved.pendingApply, false, "UI save completion requires an applied Core catalog");
  assert.equal(saved.credentialStates.fixture, "available");
  assert.equal(saved.credentialSources.fixture, "stored");
  assert.equal(saved.projects.find(item => item.projectId === projectId)?.applied, true);
  const model = core.catalog.data.find(item => item.providerId === "fixture" && item.modelId === "fixture-model");
  assert.equal(model?.available, true, "The actual Core model must be available when UI reports completion");
  assert.equal(model.credentialState, "available");
  assert.equal(project(await state()).models.find(item => item.providerId === "fixture")?.available, true);
  unchanged(before, await identity(`${label} after`), label);
  return saved;
}
async function chooseModel() {
  await button("模型").click();
  await button("选择模型").click();
  await page.getByRole("radio", { name: "fixture-model", exact: true }).click();
  await page.keyboard.press("Escape");
}
async function send(marker, expectedCredential) {
  const before = requests.filter(request => request.kind === "turn").length;
  await page.getByTestId("chat-input").fill(marker);
  await button("发送").click();
  await until(async () => await page.getByTestId("areal-workbench").getAttribute("data-thread-id"), "submitted thread identity");
  const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  await until(async () => project(await state()).state.threads[threadId]?.turns?.at(-1)?.status === "completed" && requests.filter(request => request.kind === "turn").length === before + 1, `${marker} completed`);
  assert.deepEqual(requests.filter(request => request.kind === "turn").at(-1), { model: "fixture-model", credential: expectedCredential, kind: "turn", marker });
  await page.getByText("HOT_APPLY_OK", { exact: true }).last().waitFor();
  return threadId;
}
async function launch() {
  app = await electron.launch({ executablePath: require("electron"), args: [join(gui, "app")], env, timeout: 120000 });
  const process = app.process();
  guiProcesses.push(process);
  process.stderr?.on("data", bytes => appendFileSync(join(scratch, `electron-${process.pid}.stderr.log`), bytes));
  process.stdout?.on("data", bytes => appendFileSync(join(scratch, `electron-${process.pid}.stdout.log`), bytes));
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === "ready", "GUI connected");
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  observer = new ServiceConnection();
  await observer.connect(metadata);
  await observer.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  });
}
async function closeGui() {
  observer?.close(); observer = undefined;
  if (!app) return;
  const current = app;
  const process = current.process();
  if (process.exitCode === null) {
    await current.evaluate(({ Menu }) => {
      const quit = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === "退出 AReaL Harness");
      if (!quit) throw new Error("Safe application quit menu is missing");
      quit.click();
    }).catch(async error => {
      await until(() => process.exitCode !== null, "owned GUI exit after channel closes").catch(() => { throw error; });
    });
  }
  await until(() => process.exitCode !== null, "owned GUI exits");
  app = undefined;
}
async function stopOwnedService() {
  observer?.close(); observer = undefined;
  metadata ??= JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  if (metadata.applicationOwner) {
    await waitForServiceProcessExit(env.AREAL_CORE_HOME, metadata);
    for (const pid of ownedPids) await waitForProcessExit(pid);
    const records = cli(["service", "list"]);
    assert.deepEqual((records.data ?? records).filter(record => record.state !== "stopped"), [], "Application lifetime cleanup stops every owned Core generation");
    metadata = undefined;
    return;
  }
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
    await until(async () => {
      const { service } = await connection.request("snapshot");
      return !service.busy && !service.starting && !service.activeCommands && !service.providerUpdating;
    }, "owned service is idle before cleanup");
    await connection.request("stopService", { protocol: metadata.protocol }, true);
    await waitForServiceProcessExit(env.AREAL_CORE_HOME, metadata);
  } finally { connection.close(); }
  metadata = undefined;
}
async function persistedCredentials(expected) {
  const value = await command("providers", { operation: "list" });
  const item = value.data.find(item => item.id === "fixture");
  const canonical = await readFile(config, "utf8");
  assert.equal(value.path, config);
  assert.ok(item.apiKeyEnv?.startsWith("AREAL_CREDENTIAL_"), "Canonical configuration stores an immutable credential reference");
  assert.equal(canonical.includes(item.apiKeyEnv), true);
  const vault = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "provider-credentials.json"), "utf8"));
  const matches = await app.evaluate(({ safeStorage }, { vault, references, values }) => {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") return null;
    return Object.fromEntries(Object.entries(references).map(([label, reference]) => [label,
      typeof vault.keys[reference] === "string" && safeStorage.decryptString(Buffer.from(vault.keys[reference], "base64")) === values[label]]));
  }, { vault, references: expected, values: Object.fromEntries(Object.keys(expected).map(label => [label, secrets[label]])) });
  for (const label of Object.keys(expected)) assert.equal(matches?.[label], true, `The ${label} credential is encrypted and recoverable`);
  return item.apiKeyEnv;
}
async function scanSecrets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scanSecrets(path);
    else if (entry.isFile() && /\.(json|toml|log|txt)$/.test(entry.name)) {
      const body = await readFile(path, "utf8");
      for (const [label, secret] of Object.entries(secrets)) assert.equal(body.includes(secret), false, `Plaintext ${label} credential leaked into ${path}`);
    }
  }
}
console.log("Provider hot apply evidence:", scratch);
try {
  await launch();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await until(async () => project(await state())?.state?.connected, "isolated project connected");
  projectId = project(await state()).id;
  await until(settled, "initial project work settled");
  assert.equal((await coreRead()).catalog.data.find(item => item.providerId === "fixture")?.available, false);
  assert.equal(requests.length, 0);
  await openSettings();
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill(secrets.first);
  const first = await saveProvider("first credential save");
  const firstReference = first.data.find(item => item.id === "fixture").apiKeyEnv;
  await persistedCredentials({ first: firstReference });
  await page.screenshot({ path: join(scratch, "first-save-applied.png"), animations: "disabled" });
  checks.push("UI save persists the encrypted credential and applies an available Core catalog without restarting desktop, Core Host, Core or Runtime");
  await button("返回应用").click();
  await createProjectConversation(page, "workspace");
  await chooseModel();
  const oldThread = await send("HOT_FIRST_CONVERSATION", "first");
  const oldConfiguration = structuredClone(project(await state()).configurations[oldThread]);
  assert.equal(oldConfiguration.model.providerId, "fixture");

  await openSettings();
  await page.getByRole("textbox", { name: "API Key", exact: true }).fill(secrets.second);
  const second = await saveProvider("credential rotation");
  const secondReference = second.data.find(item => item.id === "fixture").apiKeyEnv;
  assert.notEqual(secondReference, firstReference, "Rotation creates a new immutable reference");
  await persistedCredentials({ first: firstReference, second: secondReference });
  assert.deepEqual(project(await state()).configurations[oldThread], oldConfiguration);
  await button("返回应用").click();
  await selectConversation(page, oldThread);
  await send("HOT_OLD_CONVERSATION_AFTER_ROTATION", "first");
  await createProjectConversation(page, "workspace");
  await chooseModel();
  const newThread = await send("HOT_NEW_CONVERSATION_AFTER_ROTATION", "second");
  assert.notEqual(newThread, oldThread);
  checks.push("Existing conversation uses its immutable first credential after rotation; a newly selected conversation uses the second credential");

  await openSettings();
  const beforeInvalid = await identity("invalid draft before");
  const canonicalBeforeInvalid = await readFile(config, "utf8");
  const appliedBeforeInvalid = await coreRead();
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("Hot apply fixture invalid draft");
  await page.getByRole("textbox", { name: "Base URL", exact: true }).fill("invalid-url");
  await button("保存").click();
  await page.getByRole("alert").filter({ hasText: /URL|地址/ }).waitFor();
  await until(async () => await button("保存").isEnabled() && await button("返回应用").isEnabled(), "invalid save settles");
  assert.equal(await page.getByRole("textbox", { name: "供应商名称", exact: true }).inputValue(), "Hot apply fixture invalid draft");
  assert.equal(await page.getByRole("textbox", { name: "Base URL", exact: true }).inputValue(), "invalid-url");
  assert.equal(await readFile(config, "utf8"), canonicalBeforeInvalid);
  assert.equal((await command("providers", { operation: "list" })).revision, second.revision);
  const appliedAfterInvalid = await coreRead();
  assert.deepEqual(appliedAfterInvalid.catalog.data, appliedBeforeInvalid.catalog.data);
  assert.deepEqual(appliedAfterInvalid.providers.data, appliedBeforeInvalid.providers.data);
  unchanged(beforeInvalid, await identity("invalid draft after"), "rejected invalid draft");
  await page.screenshot({ path: join(scratch, "invalid-draft-retained.png"), animations: "disabled" });
  await button("取消修改").click();
  await button("放弃修改并继续").click();
  checks.push("Invalid settings save retains the draft and leaves canonical configuration, applied Core catalog and all process identities intact");

  const requestCount = requests.length;
  await closeGui();
  await stopOwnedService();
  await launch();
  await until(async () => project(await state())?.state?.connected && project(await state()).models.some(item => item.providerId === "fixture" && item.available), "saved credential available after cold reopen");
  const reopened = await command("providers", { operation: "list" });
  assert.equal(reopened.revision, second.revision);
  assert.equal(reopened.pendingApply, false);
  assert.equal(reopened.credentialSources.fixture, "stored");
  assert.equal(reopened.credentialStates.fixture, "available");
  assert.equal((await coreRead()).catalog.data.find(item => item.providerId === "fixture")?.available, true);
  await identity("cold reopen");
  assert.equal(requests.length, requestCount, "Cold reopen cannot issue or replay a model request");
  await page.screenshot({ path: join(scratch, "reopened-available.png"), animations: "disabled" });
  await createProjectConversation(page, "workspace");
  await chooseModel();
  await send("HOT_EXPLICIT_SEND_AFTER_REOPEN", "second");
  checks.push("Cold GUI and service reopen restores saved model availability without an implicit model request; explicit UI send uses the saved rotated credential");
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page && app) await captureSmokeFailure(page, scratch, error);
} finally {
  const cleanupErrors = [];
  try { await closeGui(); }
  catch (error) { cleanupErrors.push(`GUI: ${error.message}`); }
  try {
    await stopOwnedService();
    for (const pid of ownedPids) await waitForProcessExit(pid);
    for (const process of guiProcesses) assert.notEqual(process.exitCode, null, "Every owned Electron process exits");
    const services = cli(["service", "list"]);
    const live = (services.data ?? services).filter(item => ["ready", "starting", "stopping"].includes(item.state));
    assert.deepEqual(live, [], "The isolated registry contains no live Core service");
    cleanup = { desktopExited: true, coreAndRuntimeExited: true, registryLiveServices: 0 };
  } catch (error) {
    cleanupErrors.push(`Service: ${error.message}`);
  }
  if (cleanupErrors.length) { cleanup = { errors: cleanupErrors }; passed = false; }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  try {
    for (const [file, hash] of Object.entries(sourceHashes)) assert.equal(sha(await readFile(join(gui, file))), hash, `Source changed during test: ${file}`);
    for (const [name, hash] of Object.entries(coreHashes)) assert.equal(sha(await readFile(join(dirname(binary), name))), hash, `Core changed during test: ${name}`);
    await scanSecrets(scratch);
  } catch (error) { errors.push(error.message); passed = false; }
  await writeFile(join(scratch, "model-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(scratch, "manifest.json"), JSON.stringify({ passed, checks, errors, cleanup, binary, coreHashes, sourceHashes,
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    diffSha256: sha(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
    guiProcesses: guiProcesses.map(process => ({ pid: process.pid, exitCode: process.exitCode })),
    scope: "Real isolated source Electron, desktop service, Core Host/Core/Runtime and settings UI; local deterministic HTTP SSE model; native directory picker return fixture; no real provider credentials or remote inference" }, null, 2));
}
console.log(JSON.stringify({ passed, evidence: scratch, checks, errors, cleanup }));
assert.ok(passed, "Provider hot apply E2E failed; inspect its evidence directory");
