import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSmokeFailure, selectConversation } from './smoke-navigation.mjs';
import { withSmokeDeadline } from './smoke-deadline.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const sourceDesktop = join(gui, 'app');
const require = createRequire(join(sourceDesktop, 'package.json'));
const { _electron: electron } = require('playwright-core');
const { ServiceConnection, waitForServiceProcessExit } = require(join(sourceDesktop, 'src/core/service-client.cjs'));
const { DesktopLifecycle } = require(join(sourceDesktop, 'src/core/lifecycle.cjs'));
const binary = process.env.AREAL_CORE_BIN || join(root, 'target/debug/areal');
await mkdir(join(root, '.scratch/gui-evidence'), { recursive: true });
const scratch = await mkdtemp(join(root, '.scratch/gui-evidence/conversation-continue-'));
const desktop = join(scratch, 'application/app');
const renderer = join(scratch, 'application/renderer/dist');
const registry = await mkdtemp('/private/tmp/continue-svc-');
const workspace = join(scratch, 'workspace');
const projectId = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
await mkdir(workspace);
await mkdir(join(scratch, 'user-home'));
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
await writeFile(join(workspace, 'evidence.txt'), 'continue acceptance workspace\n');
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
const env = { ...process.env, AREAL_GUI: 'workbench', AREAL_BACKEND: 'areal', AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, 'core'), AREAL_CORE_USER_HOME: join(scratch, 'user-home'),
  AREAL_HARNESS_SERVICE_HOME: registry, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_WORKSPACE: workspace };
delete env.AREAL_HARNESS_HOME;
const run = { evidence: scratch, workspace, registry, desktopHome: env.AREAL_CORE_HOME, binary, coreServices: [], desktopServices: [] };
const saveRun = () => writeFile(join(scratch, 'run.json'), JSON.stringify(run, null, 2));
await saveRun();
const requests = [], checks = [], pageErrors = [], stderr = [], commands = [];
const held = new Set();
let rpcClient;
const { CoreClient } = await import('../packages/runtime-client/core.js');
const WebSocket = require('ws');
const marker = randomUUID();
const pausePrompt = `HOLD_${marker} finish the original work`;
const mainDraft = `UNSENT_${marker}`;
let app, page, server, threadId, passed = false, failure, cleanupResult;
const snapshot = () => withSmokeDeadline('desktop snapshot', () => page.evaluate(() => window.arealDesktop.snapshot()));
async function checkpoint(step) {
  run.step = step;
  console.log(JSON.stringify({ step }));
  await saveRun();
}
async function artifactFiles(directory) {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, sha256] of Object.entries(await artifactFiles(path))) files[`${entry.name}/${name}`] = sha256;
    else {
      assert.ok(entry.isFile(), `artifact is a regular file: ${path}`);
      files[entry.name] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  return files;
}
async function until(predicate, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = await snapshot();
    if (await predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}
const thread = s => s.projects.find(p => p.id === projectId)?.state?.threads?.[threadId];
const turns = async () => thread(await snapshot()).turns;
const input = () => page.getByTestId('chat-input');
const shot = name => page.screenshot({ path: join(scratch, name), animations: 'disabled' });
async function launch() {
  await checkpoint('launch Electron');
  app = await electron.launch({ executablePath: require('electron'), args: [desktop], env, timeout: 120000 });
  app.process().stderr.on('data', chunk => stderr.push(String(chunk)));
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => document.querySelector('[data-testid="areal-workbench"]')
    || document.body.innerText.includes('GUI 未构建'), null, { timeout: 60000 });
  assert.equal(await page.getByTestId('areal-workbench').count(), 1, `workbench loaded from frozen renderer: ${await page.locator('body').innerText()}`);
  await desktopMetadata();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await app.evaluate(({ app }, path) => {
    const read = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { ServiceConnection } = read(path);
    const original = ServiceConnection.prototype.request;
    globalThis.__continueCommands = [];
    ServiceConnection.prototype.request = async function (method, parameters, mutation) {
      globalThis.__continueConnection = this;
      if (method === 'command') globalThis.__continueCommands.push(structuredClone(parameters));
      const result = await original.call(this, method, parameters, mutation);
      if (method === 'command' && parameters.name === 'send' && globalThis.__continueLoseNext) {
        globalThis.__continueLoseNext = false;
        throw Object.assign(new Error('fixture: committed GUI response lost'), { submissionUnknown: true });
      }
      return result;
    };
  }, join(desktop, 'src/core/service-client.cjs'));
}
async function command(name, request) {
  commands.push({ name, request });
  return app.evaluate(async (_, { name, request }) => {
    try { return { result: await globalThis.__continueConnection.request('command', { name, request }, true) }; }
    catch (error) { return { error: error.message, code: error.code, submissionUnknown: error.submissionUnknown }; }
  }, { name, request: { projectId, threadId, ...request } });
}
async function rpc(method, params) {
  if (!rpcClient) {
    const instances = JSON.parse(execFileSync(binary, ['service', 'list', '--json'], { env, encoding: 'utf8', timeout: 30000 }));
    const instance = instances.find(item => item.workspace === workspace && item.state === 'ready');
    assert.ok(instance, 'isolated Core service is registered');
    const descriptor = JSON.parse(execFileSync(binary, ['service', 'status', '--instance', instance.serviceId, '--json'], { env, encoding: 'utf8', timeout: 30000 }));
    const auth = JSON.parse(await readFile(descriptor.authFile, 'utf8'));
    const principal = auth.principals.find(p => p.id === 'desktop-owner');
    assert.ok(principal, 'isolated desktop owner exists');
    rpcClient = new CoreClient({ createSocket: () => new WebSocket(descriptor.endpoint, { headers: { Authorization: `Bearer ${principal.token}` } }) });
    await rpcClient.connect();
  }
  commands.push({ method, params });
  try { return { result: await rpcClient.request(method, params) }; }
  catch (error) { return { error: error.message, code: error.code }; }
}
async function send(text) {
  const before = threadId ? (await turns()).length : 0;
  const beforeRequests = requests.length;
  await input().fill(text);
  await page.getByTestId('chat-send-button').click();
  if (!threadId) {
    await page.waitForFunction(() => !!document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId);
    threadId = await page.getByTestId('areal-workbench').getAttribute('data-thread-id');
  }
  await until(s => thread(s)?.turns?.length > before && requests.length > beforeRequests
    && thread(s).turns.at(-1).status === (text.startsWith('HOLD_') ? 'inProgress' : 'completed'), `send ${text}`);
}
async function pause() {
  await page.getByRole('button', { name: '暂停执行', exact: true }).click();
  await until(s => thread(s)?.turns?.at(-1)?.status === 'interrupted', 'pause settled');
  await page.getByRole('button', { name: '继续执行', exact: true }).waitFor();
}
async function stopService() {
  rpcClient?.close(); rpcClient = null;
  const instances = await coreInstances();
  for (const item of instances) {
    if (item.state !== 'stopped') execFileSync(binary,
      ['service', 'stop', '--instance', item.serviceId, '--expected-generation', item.generation, '--cancel', '--json'], { env, timeout: 60000, stdio: 'pipe' });
    for (const pid of new Set([item.hostPid, item.corePid])) {
      assert.ok(Number.isSafeInteger(pid) && pid > 1, 'owned Core process identity is complete');
      const deadline = Date.now() + 15000;
      for (;;) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        assert.ok(Date.now() < deadline, `owned Core process ${pid} exited`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  const remaining = await coreInstances();
  assert.ok(remaining.every(item => item.state === 'stopped'), 'all owned Core services stopped');
  return remaining;
}
async function coreInstances() {
  const instances = JSON.parse(execFileSync(binary, ['service', 'list', '--json'], { env, encoding: 'utf8', timeout: 30000 }));
  for (const item of instances) {
    assert.equal(item.workspace, workspace, 'private registry contains only this workspace');
    const { serviceId, generation, workspace: ownedWorkspace, dataDir, endpoint, hostPid, corePid, state } = item;
    const identity = { serviceId, generation, workspace: ownedWorkspace, dataDir, endpoint, hostPid, corePid, state };
    const index = run.coreServices.findIndex(service => service.serviceId === serviceId && service.generation === generation);
    if (index === -1) run.coreServices.push(identity); else run.coreServices[index] = identity;
  }
  await saveRun();
  return instances;
}
async function desktopMetadata() {
  const metadataPath = join(run.desktopHome, 'service.json');
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const { protocol, identity, endpoint, pid } = metadata;
  if (!run.desktopServices.some(service => service.identity === identity && service.pid === pid)) {
    run.desktopServices.push({ metadataPath, protocol, identity, endpoint, pid });
    await saveRun();
  }
  return metadata;
}
async function cleanup() {
  const result = { passed: false, coreStopped: false, desktopExited: false, errors: [] };
  const metadata = await desktopMetadata();
  await coreInstances();
  if (metadata) {
    const connection = new ServiceConnection();
    try {
      await connection.connect(metadata);
      await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
      const lifecycle = new DesktopLifecycle({ connection, metadata, home: run.desktopHome, notify: async () => ({ response: 1 }) });
      const observed = await lifecycle.observe();
      assert.ok(observed.projects.every(project => project.root === workspace), 'desktop backend owns only this workspace');
      await lifecycle.stop({ mode: 'cancel', observed });
      await waitForServiceProcessExit(run.desktopHome, metadata);
      result.desktopExited = true;
    } catch (error) { result.errors.push(`Desktop: ${error.message}`); }
    finally { connection.close(); }
  } else result.desktopExited = true;
  try {
    result.coreServices = await stopService();
    result.coreStopped = true;
  } catch (error) { result.errors.push(`Core: ${error.message}`); }
  result.passed = result.coreStopped && result.desktopExited && result.errors.length === 0;
  return result;
}
const chunk = content => `data: ${JSON.stringify({ id: 'continue-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
console.log('GUI evidence:', scratch);
try {
  await checkpoint('freeze source app and built renderer');
  const sourceArtifacts = { app: await artifactFiles(sourceDesktop), renderer: await artifactFiles(join(gui, 'renderer/dist')) };
  assert.ok(sourceArtifacts.renderer['index.html'], 'built renderer index exists');
  await mkdir(dirname(desktop), { recursive: true });
  await cp(sourceDesktop, desktop, { recursive: true, filter: path => path !== join(sourceDesktop, 'node_modules') });
  await symlink(join(sourceDesktop, 'node_modules'), join(desktop, 'node_modules'), 'dir');
  await cp(join(gui, 'renderer/dist'), renderer, { recursive: true });
  assert.deepEqual(await artifactFiles(sourceDesktop), sourceArtifacts.app, 'source app remained stable while copied');
  assert.deepEqual(await artifactFiles(join(gui, 'renderer/dist')), sourceArtifacts.renderer, 'built renderer remained stable while copied');
  assert.deepEqual(await artifactFiles(desktop), sourceArtifacts.app, 'frozen app matches source');
  assert.deepEqual(await artifactFiles(renderer), sourceArtifacts.renderer, 'frozen renderer matches build');
  run.artifacts = { desktop, renderer, files: sourceArtifacts,
    acceptanceScriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex') };
  await mkdir(env.AREAL_CORE_HOME, { recursive: true });
  await writeFile(join(env.AREAL_CORE_HOME, 'projects.json'), JSON.stringify([{ id: projectId, root: workspace }]));
  await checkpoint('isolated existing project fixture ready');
  server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const piece of req) raw += piece;
      const body = JSON.parse(raw); requests.push({ sequence: requests.length + 1, body });
      const last = body.messages?.findLast(m => m.role === 'user' && !String(m.content).startsWith('AReaL runtime context (not a user request):'));
      const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunk(`CONFIRMED_PROGRESS_${requests.length}`));
      if (text.startsWith('HOLD_')) { held.add(res); res.on('close', () => held.delete(res)); return; }
      res.end(`data: ${JSON.stringify({ id: 'continue-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = join(scratch, 'config.toml');
  await writeFile(config, `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`);
  env.AREAL_CORE_CONFIG = config;
  await launch();
  await until(s => s.projects.find(project => project.id === projectId)?.state?.connected, 'project connected');
  assert.deepEqual((await snapshot()).projects.map(project => project.root), [workspace], 'only the isolated fixture workspace is registered');
  const modelReady = await until(s => s.projects.find(p => p.id === projectId)?.models?.some(model => model.isDefault), 'configured default model');
  const defaultModel = modelReady.projects.find(p => p.id === projectId).models.find(model => model.isDefault);
  assert.deepEqual({ providerId: defaultModel.providerId, modelId: defaultModel.modelId, available: defaultModel.available },
    { providerId: 'fixture', modelId: 'fixture', available: true }, 'configured fixture is the available default model');
  await send(pausePrompt);
  await until(s => thread(s)?.turns?.at(-1)?.items?.some(i => i.type === 'agentMessage'), 'recorded progress');
  await pause();
  const original = (await turns()).at(-1);
  assert.equal(original.interruption, 'userPause');
  await shot('01-paused.png');
  const beforeRestart = requests.length;
  commands.push(...await app.evaluate(() => globalThis.__continueCommands));
  await app.close(); app = null;
  await stopService();
  await launch();
  await until(s => s.projects.find(p => p.id === projectId)?.state?.connected, 'restart connected');
  await selectConversation(page, threadId);
  await page.getByRole('button', { name: '继续执行', exact: true }).waitFor();
  assert.equal(requests.length, beforeRestart, 'restart must not submit to model');
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  await until(s => thread(s)?.turns?.at(-1)?.status === 'completed', 'continue complete');
  const continued = (await turns()).at(-1);
  assert.equal(continued.continuedFromTurnId, original.id);
  assert.notEqual(continued.id, original.id);
  assert.ok(JSON.stringify(requests.at(-1).body).includes(pausePrompt));
  assert.ok(JSON.stringify(requests.at(-1).body).includes('CONFIRMED_PROGRESS_'));
  assert.equal(thread(await snapshot()).goals?.goal ?? null, null);
  await shot('02-continued.png');
  checks.push('pause/play creates one new Turn in the same Thread after restart, preserving history and confirmed progress without an automatic Goal');
  await checkpoint(checks.at(-1));
  assert.equal(await page.getByRole('button', { name: '继续执行', exact: true }).count(), 0, 'completed ordinary turn has no continue');

  await send(`HOLD_${marker} changed requirements next`); await pause();
  await input().fill(`PLAIN_${marker}`);
  assert.equal(await page.getByRole('button', { name: '继续执行', exact: true }).count(), 0);
  await page.getByTestId('chat-send-button').click();
  await until(s => thread(s)?.turns?.at(-1)?.status === 'completed', 'plain message complete');
  const plain = requests.at(-1).body.messages.findLast(m => m.role === 'user' && !String(m.content).startsWith('AReaL runtime context (not a user request):'));
  assert.equal(plain.content, `PLAIN_${marker}`);
  checks.push('nonempty paused composer sends the literal new user message');
  await checkpoint(checks.at(-1));

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=';
  const uploaded = await command('media', { operation: 'upload', mime: 'image/png', bytes: png });
  assert.ok(uploaded.result?.uri, JSON.stringify(uploaded));
  const resource = { type: 'resource_link', uri: 'https://example.invalid/source', name: `SOURCE_REF_${marker}` };
  const resourceSend = await command('send', { text: `RESOURCE_PROMPT_${marker}`, attachments: [{ type: 'image', url: uploaded.result.uri }], mcpContent: [resource] });
  assert.ok(!resourceSend.error, JSON.stringify(resourceSend));
  await until(s => thread(s)?.turns?.at(-1)?.status === 'completed' && thread(s).turns.at(-1).items.some(i => i.content?.some(c => c.mcpContent)), 'resource prompt complete');
  await input().fill(mainDraft);
  const draftKey = `areal-gui:draft:${projectId}:${threadId}`;
  const retainedMcp = JSON.stringify([{ id: randomUUID(), block: { type: 'resource_link', uri: 'https://example.invalid/unsent', name: mainDraft } }]);
  await page.evaluate(({ draftKey, retainedMcp }) => {
    localStorage.setItem(`${draftKey}:mcpContent`, retainedMcp);
    window.dispatchEvent(new CustomEvent('areal-draft-change', { detail: draftKey }));
  }, { draftKey, retainedMcp });
  await page.locator('input[type="file"]').last().setInputFiles({ name: 'main-unsent.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const edit = page.getByRole('region', { name: '编辑用户消息', exact: true });
  await edit.getByRole('textbox').fill(`CANCELLED_${marker}`);
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  const beforeEdit = (await turns()).map(t => t.id);
  const editRequests = requests.length;
  assert.equal(await input().innerText(), mainDraft);
  assert.equal(requests.length, editRequests);
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await edit.getByRole('textbox').fill(`REVISED_${marker}`);
  await shot('02-editing-prompt.png');
  await app.evaluate(() => { globalThis.__continueLoseNext = true; });
  await edit.getByRole('button', { name: '发送', exact: true }).click();
  await until(s => thread(s)?.turns?.at(-1)?.status === 'completed' && thread(s).turns.length > beforeEdit.length, 'revised prompt complete');
  assert.deepEqual((await turns()).slice(0, -1).map(t => t.id), beforeEdit);
  assert.equal(await input().innerText(), mainDraft);
  assert.equal((await turns()).at(-1).items.find(i => i.type === 'userMessage').content.find(c => c.type === 'text').text, `REVISED_${marker}`);
  const revisedContent = (await turns()).at(-1).items.find(i => i.type === 'userMessage').content;
  assert.equal(revisedContent.find(c => c.type === 'image').url, uploaded.result.uri);
  assert.deepEqual(revisedContent.find(c => c.mcpContent).mcpContent, resource);
  assert.equal(await page.evaluate(key => localStorage.getItem(`${key}:mcpContent`), draftKey), retainedMcp);
  assert.equal(await page.locator('.composer-image-card').count(), 1);
  await shot('03-edited-as-new-message.png');
  await page.getByRole('button', { name: '移除附件 main-unsent.png', exact: true }).click();
  await page.evaluate(key => { localStorage.removeItem(`${key}:mcpContent`); window.dispatchEvent(new CustomEvent('areal-draft-change', { detail: key })); }, draftKey);
  checks.push('edit Cancel preserves history; Send appends a revised prompt with original attachment/MCP references and retains the main draft/resources even when its committed response is lost');
  await checkpoint(checks.at(-1));
  await input().fill('');

  await send(`HOLD_${marker} queue base`);
  for (const text of [`QUEUE_FIRST_${marker}`, `QUEUE_SECOND_${marker}`]) {
    await input().fill(text); await page.getByTestId('chat-send-button').click();
    await until(s => s.projects[0].state.queues?.[threadId]?.items?.some(i => i.input?.some(c => c.text === text) && i.status === 'pending'), 'pending input');
  }
  await pause();
  const anchor = (await turns()).at(-1).id;
  const queueStart = requests.length;
  const requestId = randomUUID();
  const submit = { requestId, threadId, expectedConfigRevision: (await snapshot()).projects[0].configurations[threadId].revision, intent: { type: 'continue', expectedTurnId: anchor } };
  const first = await rpc('areal/turn/submit', submit);
  assert.ok(!first.error, JSON.stringify(first));
  const duplicate = await rpc('areal/turn/submit', submit);
  assert.deepEqual(duplicate, first);
  await until(s => thread(s)?.turns?.at(-1)?.status === 'completed' && requests.length >= queueStart + 2, 'FIFO queue complete');
  const delivered = requests.slice(queueStart).map(r => r.body.messages.findLast(m => m.role === 'user' && !String(m.content).startsWith('AReaL runtime context (not a user request):')).content);
  assert.deepEqual(delivered, [`QUEUE_FIRST_${marker}`, `QUEUE_SECOND_${marker}`]);
  assert.ok((await rpc('areal/turn/submit', { ...submit, requestId: randomUUID() })).error, 'stale anchor rejected');
  assert.ok((await rpc('areal/turn/submit', { ...submit, intent: { type: 'continue', expectedTurnId: 'different-anchor' } })).error, 'same key changed params rejected');
  checks.push('pending FIFO precedes continuation; duplicate receipt is stable and stale/same-key-changed requests are rejected');
  await checkpoint(checks.at(-1));

  await send(`HOLD_${marker} recovery`);
  const interruptedId = (await turns()).at(-1).id;
  await app.close(); app = null; await stopService();
  const recordPath = join(scratch, 'core', projectId, 'state', `${threadId}.json`);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  const recovery = record.thread.turns.find(t => t.id === interruptedId);
  recovery.status = 'inProgress'; delete recovery.interruption;
  await writeFile(recordPath, JSON.stringify(record));
  await checkpoint('stopped-Core recovery fixture written');
  await launch(); await until(s => s.projects[0]?.state?.connected, 'recovery connected');
  await selectConversation(page, threadId);
  await until(s => thread(s)?.turns?.at(-1)?.interruption === 'coreRecovery', 'Core recovery fact');
  const recoveryRequests = requests.length;
  await page.getByRole('button', { name: '继续执行', exact: true }).waitFor();
  assert.equal(requests.length, recoveryRequests);
  await app.close(); app = null; await stopService();
  const unknownRecord = JSON.parse(await readFile(recordPath, 'utf8'));
  const unknownTurn = unknownRecord.thread.turns.at(-1);
  unknownTurn.status = 'failed';
  delete unknownTurn.interruption;
  unknownTurn.error = { message: 'recovered an UNKNOWN tool outcome; inspection is required', outcome: {
    code: 'HARNESS_INTERNAL_ERROR', class: 'infrastructure', source: 'core_recovery', details: { reason: 'unknown_tool_outcome' },
  } };
  const unknownItem = { type: 'dynamicToolCall', id: randomUUID(), tool: 'run_command', callId: randomUUID(), arguments: {}, status: 'failed', success: false, contentItems: [], execution: { runtimeEpoch: 'fixture', scopeId: 'fixture', operationId: 'fixture', outcome: 'unknown', hooks: [] } };
  unknownTurn.items.push(unknownItem);
  run.unknownFixture = { threadId, turnId: unknownTurn.id, itemId: unknownItem.id, callId: unknownItem.callId };
  await saveRun();
  await writeFile(recordPath, JSON.stringify(unknownRecord));
  await checkpoint('stopped-Core legacy UNKNOWN fixture written');
  await launch(); await until(s => s.projects[0]?.state?.connected, 'unknown fixture connected');
  await selectConversation(page, threadId);
  const blocked = await command('continue', { requestId: randomUUID(), expectedTurnId: interruptedId });
  assert.ok(blocked.error?.includes('UNKNOWN'), JSON.stringify(blocked));
  assert.equal(requests.length, recoveryRequests);
  checks.push('Core recovery is manual; legacy Failed recovery without interruption refuses uninspected UNKNOWN continuation without a model request');
  await checkpoint(checks.at(-1));
  const beforeInspection = await rpc('thread/read', { threadId, includeTurns: true });
  assert.ok(beforeInspection.result, JSON.stringify(beforeInspection));
  const legacyRecovery = beforeInspection.result.thread.turns.at(-1);
  assert.equal(legacyRecovery.id, interruptedId);
  assert.equal(legacyRecovery.status, 'failed');
  assert.equal(Object.hasOwn(legacyRecovery, 'interruption'), false, 'legacy recovery has no interruption field');
  assert.deepEqual(legacyRecovery.error, unknownTurn.error, 'legacy recovery retains the authoritative error shape');
  const uninspected = beforeInspection.result.thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'dynamicToolCall'
    && !item.execution.inspection && (item.execution.outcome === 'unknown' || item.execution.hooks?.some(hook => hook.outcome === 'unknown')
      || item.execution.plugin?.operations?.some(operation => operation.outcome === 'unknown')));
  assert.equal(uninspected.length, 1, 'only the injected fixture is uninspected');
  assert.deepEqual({ ...uninspected[0], execution: { ...uninspected[0].execution, hooks: uninspected[0].execution.hooks ?? [] } },
    unknownItem, 'UNKNOWN matches the exact undispatched fixture');
  const inspection = 'Inspected synthetic acceptance fixture. This record was injected after the isolated Core stopped. No Runtime or external operation was dispatched. Preserve UNKNOWN history; cleanup may proceed.';
  const acknowledged = await rpc('areal/tool/acknowledge', { threadId, itemId: unknownItem.id, inspection });
  assert.ok(acknowledged.result, JSON.stringify(acknowledged));
  const inspected = await rpc('thread/read', { threadId, includeTurns: true });
  const inspectedItem = inspected.result?.thread.turns.flatMap(turn => turn.items).find(item => item.id === unknownItem.id);
  assert.equal(inspectedItem?.execution.outcome, 'unknown');
  assert.equal(inspectedItem.execution.inspection, inspection);
  run.unknownFixture.inspection = inspection;
  await saveRun();
  assert.equal(requests.length, recoveryRequests, 'inspection does not submit to the model');
  await page.getByRole('button', { name: '继续执行', exact: true }).waitFor();
  await shot('04-legacy-recovery-inspected.png');
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  await until(s => thread(s)?.turns?.at(-1)?.continuedFromTurnId === interruptedId
    && thread(s).turns.at(-1).status === 'completed', 'inspected legacy recovery continuation');
  assert.equal(await page.getByTestId('areal-workbench').getAttribute('data-thread-id'), threadId);
  assert.equal(requests.length, recoveryRequests + 1, 'manual legacy continuation submits exactly once');
  const afterLegacyContinuation = await rpc('thread/read', { threadId, includeTurns: true });
  const finalTurns = afterLegacyContinuation.result?.thread.turns;
  assert.equal(finalTurns?.length, beforeInspection.result.thread.turns.length + 1);
  assert.notEqual(finalTurns.at(-1).id, interruptedId);
  assert.equal(finalTurns.at(-1).continuedFromTurnId, interruptedId);
  const preservedRecovery = finalTurns.find(turn => turn.id === interruptedId);
  assert.equal(preservedRecovery.status, 'failed');
  assert.equal(Object.hasOwn(preservedRecovery, 'interruption'), false);
  assert.deepEqual(preservedRecovery.error, unknownTurn.error);
  assert.deepEqual(preservedRecovery.items.find(item => item.id === unknownItem.id), inspectedItem,
    'continued legacy recovery preserves the inspected UNKNOWN history');
  await shot('05-legacy-recovery-continued.png');
  checks.push('after exact synthetic UNKNOWN inspection and public acknowledgement, UI play continues legacy Failed recovery in the same Thread and preserves UNKNOWN history');
  await checkpoint(checks.at(-1));
  assert.deepEqual(pageErrors, []);
  passed = true;
} catch (error) {
  failure = error.stack || String(error); console.error(error); process.exitCode = 1;
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  await checkpoint('capture final evidence and clean up owned services');
  if (app) {
    commands.push(...await withSmokeDeadline('final command capture', () => app.evaluate(() => globalThis.__continueCommands || [])).catch(() => []));
    await writeFile(join(scratch, 'final-snapshot.json'), JSON.stringify(await snapshot().catch(() => null), null, 2));
    await app.close().catch(error => { passed = false; failure ||= error.stack || String(error); });
  }
  try { cleanupResult = await cleanup(); }
  catch (error) { cleanupResult = { passed: false, errors: [error.stack || String(error)] }; }
  if (!cleanupResult.passed) {
    passed = false;
    failure ||= `Cleanup failed: ${cleanupResult.errors.join('; ')}`;
    process.exitCode = 1;
  }
  await writeFile(join(scratch, 'cleanup.json'), JSON.stringify(cleanupResult, null, 2));
  for (const response of held) response.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (!passed) process.exitCode = 1;
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, failure, checks, requests, commands, pageErrors, stderr, run, cleanup: cleanupResult,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    binary, binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff'], { cwd: root })).digest('hex'),
    evidenceBoundary: 'real source Electron/Core and local SSE model; recovery/UNKNOWN records injected after isolated service stop; no physical reboot, provider or installed-package claim',
  }, null, 2));
  console.log(JSON.stringify({ passed, scratch, checks, failure }));
}
