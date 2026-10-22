import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationFixture } from './application-fixture.mjs';
import { assertApplicationStopped } from './application-cleanup.mjs';
import { respondToSessionName } from './model-fixture.mjs';
import { captureSmokeFailure } from './smoke-navigation.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const binary = process.env.AREAL_CORE_BIN;
const failList = process.env.AREAL_SEND_LIST_FAILURE === '1';
assert.ok(binary && isAbsolute(binary), 'Set AREAL_CORE_BIN to an absolute fixed Core binary');
const scratch = await mkdtemp('/private/tmp/send-admission-');
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary, AREAL_CORE_CONFIG: join(scratch, 'config.toml'),
  AREAL_CORE_HOME: join(scratch, 'core'), AREAL_CORE_USER_HOME: join(scratch, 'user'),
  AREAL_HARNESS_HOME: join(scratch, 'harness'), AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_GUI_USER_DATA: join(scratch, 'electron'),
  NO_PROXY: [env.NO_PROXY, '127.0.0.1,localhost,::1'].filter(Boolean).join(','),
  no_proxy: [env.no_proxy, '127.0.0.1,localhost,::1'].filter(Boolean).join(','),
});
const requests = [], errors = [], checks = [];
const originalText = 'Send this exact first message once while the conversation list is held.';
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'SEND_ADMISSION_COMPLETE' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { errors.push(error.stack); response.destroy(); }
});
const tracePath = join(scratch, 'boundary-trace.jsonl');
const listGate = join(scratch, 'conversation-list.gate');
const bootstrap = `
const { CoreBackend } = require(${JSON.stringify(join(gui, 'app/src/core/backend.cjs'))});
const { appendFileSync, existsSync } = require('node:fs');
let sequence = 0;
const record = value => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ sequence: ++sequence, at: Date.now(), ...value }) + '\\n');
const submit = CoreBackend.prototype.submit;
CoreBackend.prototype.submit = async function(project, method, ...args) {
  if (!project.client.__sendAdmissionTrace) {
    const client = project.client;
    client.__sendAdmissionTrace = true;
    const request = client.request.bind(client);
    let admitted = false, held = false;
    client.request = async function(method, ...args) {
      const id = ++sequence;
      record({ boundary: 'rpc', phase: 'start', id, method });
      try {
        if (admitted && !held && method === 'areal/conversation/list') {
          held = true;
          record({ boundary: 'listGate', phase: 'held', method });
          const deadline = Date.now() + 60000;
          while (existsSync(${JSON.stringify(listGate)})) {
            if (Date.now() > deadline) throw new Error('Fixture conversation-list gate was not released');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          record({ boundary: 'listGate', phase: 'released', method });
          if (${JSON.stringify(failList)}) throw new Error('Fixture conversation-list failure after accepted create');
        }
        const value = await request(method, ...args);
        if (method === 'areal/thread/start') {
          admitted = true;
          record({ boundary: 'threadAdmission', phase: 'accepted', method });
        }
        record({ boundary: 'rpc', phase: 'finish', id, method, ok: true });
        return value;
      } catch (error) {
        record({ boundary: 'rpc', phase: 'finish', id, method, ok: false, code: error.code });
        throw error;
      }
    };
  }
  return submit.call(this, project, method, ...args);
};
`;
const hash = async () => createHash('sha256').update(await readFile(binary)).digest('hex');
const coreHash = await hash();
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const guiDiffHash = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'clients/gui'], { cwd: root })).digest('hex');
let application, app, page, metadata, passed = false, failure, cleanup, heldObservation;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = value => value.projects.find(item => item.root === workspace);
const trace = async () => (await readFile(tracePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(JSON.parse);
const until = async (read, label, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(`Timeout: ${label}`);
};
const editorText = () => page.getByTestId('chat-input').innerText();
const capture = async name => {
  await page.screenshot({ path: join(scratch, `${name}.png`) });
  await writeFile(join(scratch, `${name}.json`), JSON.stringify({ snapshot: await snapshot(), editorText: await editorText(), modelRequests: requests.length, trace: await trace() }, null, 2));
};
console.log('Send admission evidence:', scratch);
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(env.AREAL_CORE_CONFIG, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`);
  await writeFile(listGate, 'held');
  application = await applicationFixture(gui, join(scratch, 'app'), bootstrap);
  app = await electron.launch({ executablePath: require('electron'), args: [application.path], env, timeout: 120000 });
  app.process().stderr.on('data', chunk => { void writeFile(join(scratch, 'electron.log'), chunk, { flag: 'a' }); });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.stack));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === 'ready', 'Desktop ready');
  metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, 'service.json'), 'utf8'));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await page.getByRole('button', { name: '不在项目中工作', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
  await until(async () => project(await snapshot())?.state?.connected, 'Project ready');
  await page.getByTestId('chat-input').fill(originalText);
  await page.getByTestId('chat-send-button').click();
  await until(async () => (await trace()).some(item => item.boundary === 'listGate' && item.phase === 'held'), 'Post-admission list held');
  await until(async () => Object.keys(project(await snapshot())?.state?.threads ?? {}).length > 0, 'Created thread observed independently of list refresh');
  try {
    await until(async () => requests.length === 1 && (await editorText()).trim() === '', 'First message admitted and Composer cleared while list is held', 10000);
  } catch (error) {
    failure = error.stack;
  }
  heldObservation = { modelRequests: requests.length, editorText: await editorText(), admittedBeforeRelease: !failure };
  await capture('list-held');
  console.log(heldObservation.admittedBeforeRelease
    ? 'PASS: first message reaches the model and clears Composer while the post-create list is held'
    : 'FAIL: post-create list refresh blocks the first message while its text remains in Composer');
  await rm(listGate);
  await until(async () => requests.length > 0, 'Original message reaches model after list release');
  await until(async () => (await editorText()).trim() === '', 'Composer clears after send admission');
  await until(async () => Object.values(project(await snapshot())?.state?.threads ?? {}).some(thread => thread.turns.some(turn => turn.items.some(item => item.type === 'agentMessage' && item.text?.includes('SEND_ADMISSION_COMPLETE')))), 'Reply completes');
  await capture('after-release');
  if (failList) {
    await until(async () => Object.values(project(await snapshot())?.refreshErrors ?? {}).some(error =>
      error.scope === 'threadList' && error.operation?.method === 'areal/thread/start'
      && error.message.includes('Fixture conversation-list failure')), 'Background list failure remains visible');
    checks.push('Background list failure remains attached to the accepted create operation');
  }
  assert.equal(requests.length, 1, 'One UI submission reaches the model exactly once');
  const messageText = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
  const userMessages = requests[0].messages.filter(message => message.role === 'user' && !messageText(message).startsWith('AReaL runtime context (not a user request):'));
  assert.equal(userMessages.length, 1, 'The fixture receives one user message');
  assert.equal(messageText(userMessages[0]), originalText, 'The exact original text reaches the model');
  assert.equal((await trace()).filter(item => item.boundary === 'threadAdmission').length, 1, 'Delayed observation never replays thread creation');
  assert.deepEqual(errors, [], 'No renderer or fixture errors');
  checks.push('Releasing the list delivers the exact original text once and completes a reply');
  assert.equal(heldObservation.admittedBeforeRelease, true, 'An accepted create must not block the first message on an unrelated list refresh');
  checks.push('An accepted create permits the first message and clears Composer while the list refresh is held');
  passed = true;
} catch (error) {
  failure ??= error.stack; console.error(error.message);
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  await rm(listGate, { force: true });
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => ({ response: ['确认取消后台任务？', '退出 AReaL Harness？'].includes(args.at(-1).message) ? 1 : args.at(-1).cancelId ?? 0 }); }).catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
  }
  await application?.close();
  try { await assertApplicationStopped(binary, env, metadata); cleanup = 'passed'; }
  catch (error) { cleanup = error.stack; passed = false; }
  if (server.listening) await new Promise(resolve => server.close(resolve));
  assert.equal(await hash(), coreHash, 'Core binary stays unchanged');
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, source, guiDiffHash, binary, coreHash, originalText, failList, checks, heldObservation, failure, cleanup, errors,
    boundaries: 'Source Electron and real Core. Deterministic loopback model. One filesystem barrier holds the first conversation-list RPC after a successful thread-start response. Native folder picker stubbed. Deadline controls fixture completion, not a latency benchmark. No packaged app or physical input.' }, null, 2));
  console.log('Send admission result:', passed ? 'PASS' : 'FAIL');
  if (!passed) process.exitCode = 1;
}
