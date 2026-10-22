import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { applicationFixture } from './application-fixture.mjs';
import { assertApplicationStopped } from './application-cleanup.mjs';
import { captureSmokeFailure, createProjectConversation } from './smoke-navigation.mjs';

const gui = resolve(import.meta.dirname, '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), 'Set AREAL_CORE_BIN to an absolute fixed Core binary');
const scratch = await mkdtemp('/private/tmp/subscription-send-');
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
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const identity = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
  guiDiffHash: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'clients/gui'], { cwd: root })).digest('hex'),
  binary, coreHash: await hash(binary), scriptHash: await hash(new URL(import.meta.url)),
  rendererHash: await hash(join(gui, 'renderer/dist/index.html')),
};
const requests = [], errors = [], checks = [], observations = [], expected = new Map();
const heldResponses = new Map();
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
const respond = (response, text) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end([
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', id: 'fixture-message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 3, output_tokens: 2 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
};
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (JSON.stringify(body).includes('Generate a concise semantic session title')) { respond(response, 'Fixture session'); return; }
    const messages = body.messages ?? (Array.isArray(body.input) ? body.input : []);
    const users = messages.filter(message => message.role === 'user' && !textOf(message).startsWith('AReaL runtime context (not a user request):')).map(textOf);
    const text = users.at(-1), entry = expected.get(text);
    assert.ok(entry, 'Inference carries an expected exact user input');
    assert.equal(request.method, 'POST', 'Inference uses one model POST');
    assert.equal(request.headers['x-subscription-send-fixture'], 'synthetic-grant', 'Inference traverses the real subscription custom fetch');
    assert.equal(body.model, 'gpt-6.1-sol', 'Inference uses the selected subscription model');
    assert.deepEqual(users, entry.history, 'Inference receives exact user input and conversation history');
    assert.equal(requests.filter(item => item.text === text).length, 0, 'A UI send is never replayed');
    requests.push({ text, users, model: body.model, at: Date.now() });
    heldResponses.set(text, response);
  } catch (error) { errors.push(error.stack); response.destroy(); }
});
const auditPath = join(scratch, 'subscription.jsonl');
const controlPath = join(scratch, 'catalog-control.json');
const catalogGate = join(scratch, 'catalog.gate');
const bootstrap = endpoint => `
const { AppProviders } = require(${JSON.stringify(join(gui, 'app/src/core/providers.cjs'))});
const { CoreBackend } = require(${JSON.stringify(join(gui, 'app/src/core/backend.cjs'))});
const { appendFileSync, existsSync, readFileSync, unlinkSync } = require('node:fs');
const stamp = value => appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ at: Date.now(), ...value }) + String.fromCharCode(10));
let catalogControl;
const execute = CoreBackend.prototype.executeCommand;
CoreBackend.prototype.executeCommand = async function(name, ...args) {
  if (name === 'send' && existsSync(${JSON.stringify(controlPath)})) {
    catalogControl = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
    unlinkSync(${JSON.stringify(controlPath)});
    const service = await this.providers.openai();
    service.catalog.expiresAt = 0;
    stamp({ boundary: 'catalog.expire', sample: catalogControl.sample, models: service.models.map(model => model.id), metadata: service.catalog.metadata(), revision: service.account.revision });
    if (catalogControl.background) void service.discover().catch(error => stamp({ boundary: 'catalog.background.error', code: error.code }));
  }
  return execute.call(this, name, ...args);
};
AppProviders.prototype.openai = function() {
  if (!this.openaiPromise) this.openaiPromise = import(${JSON.stringify(join(gui, 'packages/chatgpt-provider/core.js'))}).then(({ CoreSubscription }) => {
    let record = { kind: 'grant', payload: { type: 'oauth', access: 'synthetic-fixture-access', refresh: 'synthetic-fixture-refresh',
      expires: Date.now() + 3600000, accountId: 'fixture-account', clientId: 'fixture-client', subject: 'fixture-account',
      hostId: 'urn:uuid:fixture', issuer: 'https://auth.openai.com', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] } };
    let chain = Promise.resolve();
    const store = { check() {}, readRecord: async () => structuredClone(record),
      modifyRecord(_key, mutate) { const work = chain.then(async () => { const next = await mutate(structuredClone(record)); if (next !== undefined) record = next; return structuredClone(record); }); chain = work.catch(() => {}); return work; },
      deleteRecord: async () => { record = undefined; } };
    this.openaiStore = store;
    return new CoreSubscription({ store, token: this.openaiToken, port: this.transport.port, kind: 'openai',
      onListen: async port => { this.transport.port = port; await this.backend.save('subscription-transport.json', this.transport); },
      onRequest: value => stamp({ boundary: 'inference.audit', providerId: value.providerId, model: value.model, outcome: value.outcome }),
      fetch: async (url, options) => {
        if (url === 'https://api.openai.com/v1/models') {
          if (existsSync(${JSON.stringify(controlPath)})) {
            catalogControl = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
            unlinkSync(${JSON.stringify(controlPath)});
          }
          const control = catalogControl;
          stamp({ boundary: 'catalog.fetch', phase: 'start', sample: control?.sample, mode: control?.mode });
          if (control?.mode === 'held') {
            stamp({ boundary: 'catalog.gate', phase: 'held', sample: control.sample });
            while (existsSync(${JSON.stringify(catalogGate)})) {
              options.signal.throwIfAborted();
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
          if (control?.mode === 'rejected') {
            stamp({ boundary: 'catalog.fetch', phase: 'rejected', sample: control.sample });
            return Response.json({ error: { message: 'Synthetic catalog unavailable' } }, { status: 503 });
          }
          stamp({ boundary: 'catalog.fetch', phase: 'finish', sample: control?.sample });
          return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'Fixture GPT 6.1', visibility: 'list', context_window: 200000 }] });
        }
        if (url === 'https://api.openai.com/v1/responses') {
          stamp({ boundary: 'inference.fetch', model: JSON.parse(options.body).model });
          return fetch(${JSON.stringify(endpoint)}, { ...options, headers: { ...options.headers, 'x-subscription-send-fixture': 'synthetic-grant' } });
        }
        throw Error('Unexpected synthetic subscription URL');
      } });
  });
  return this.openaiPromise;
};
`;
let application, app, page, metadata, passed = false, failure, cleanup;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const projectOf = value => value.projects.find(item => item.root === workspace);
const audit = async () => (await readFile(auditPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(JSON.parse);
const until = async (read, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(`Timeout: ${label}`);
};
const turnFor = (project, text) => {
  for (const thread of Object.values(project?.state?.threads ?? {})) {
    const turn = thread.turns?.find(turn => turn.items?.some(item => item.type === 'userMessage' && textOf(item) === text));
    if (turn) return { thread, turn };
  }
};
async function send(mode, kind, history) {
  const sample = `${mode}-${kind}`;
  const text = `Exact subscription send ${sample}.`;
  const reply = `SUBSCRIPTION_SEND_COMPLETE_${sample.toUpperCase()}`;
  const entry = { text, reply, history: [...history, text] };
  expected.set(text, entry);
  const before = await audit();
  const catalogStarts = before.filter(item => item.boundary === 'catalog.fetch' && item.phase === 'start').length;
  await writeFile(controlPath, JSON.stringify({ sample, mode, background: mode === 'held' && kind === 'new' }));
  await page.getByTestId('chat-input').fill(text);
  assert.equal(await page.getByTestId('chat-send-button').isEnabled(), true, 'Send is enabled for the selected subscription model');
  await page.getByTestId('chat-send-button').click();
  try {
    await until(async () => {
      const current = projectOf(await snapshot()), admitted = turnFor(current, text);
      const visible = await page.locator('.user-message-body').allTextContents();
      return requests.some(item => item.text === text) && (await page.getByTestId('chat-input').innerText()).trim() === ''
        && visible.includes(text) && admitted?.turn.status === 'inProgress' ? admitted : false;
    }, `${sample} is admitted with an empty Composer and exact visible user text before catalog or inference reply release`, 8000);
  } finally {
    const current = await snapshot();
    const observation = { sample, editorText: await page.getByTestId('chat-input').innerText(), requests: requests.filter(item => item.text === text), snapshot: current, audit: await audit() };
    observations.push(observation);
    await writeFile(join(scratch, `${sample}-held.json`), JSON.stringify(observation, null, 2));
  }
  const current = projectOf(await snapshot()), { thread, turn } = turnFor(current, text);
  assert.equal(turn.items.some(item => item.type === 'agentMessage' && item.text?.trim()), false, 'Admission does not depend on assistant output');
  const configuration = current.configurations[thread.id];
  assert.deepEqual(configuration.model, { providerId: 'areal_openai', modelId: 'gpt-6.1-sol' }, 'Core admits the selected subscription model');
  assert.equal(configuration.contextWindow.reportedWindowSource, 'account', 'Model provenance comes from the real account catalog');
  assert.equal(configuration.contextWindow.reportedWindowTokens, 200000, 'Core preserves account catalog model metadata');
  const after = await audit();
  const starts = after.filter(item => item.boundary === 'catalog.fetch' && item.phase === 'start').length;
  assert.equal(starts, catalogStarts + (mode === 'held' && kind === 'new' ? 1 : 0), 'Sending does not start an extra catalog GET');
  assert.ok(after.some(item => item.boundary === 'catalog.expire' && item.sample === sample && !item.metadata.fresh && item.models.includes('gpt-6.1-sol')), 'A populated real catalog is expired before this send');
  if (mode === 'held') {
    assert.ok(after.some(item => item.boundary === 'catalog.gate' && item.phase === 'held'), 'A real catalog GET is held during admission');
    assert.ok(!after.some(item => item.boundary === 'catalog.fetch' && item.phase === 'finish' && item.sample === 'held-new'), 'The held catalog GET has not finished');
  }
  assert.equal(requests.filter(item => item.text === text).length, 1, 'Exactly one inference POST is admitted');
  const response = heldResponses.get(text);
  assert.ok(response && !response.writableEnded, 'Inference response remains held during all admission assertions');
  respond(response, reply); heldResponses.delete(text);
  await until(async () => {
    const result = turnFor(projectOf(await snapshot()), text);
    return result?.turn.status === 'completed' && result.thread.status?.type === 'idle'
      && result.turn.items?.some(item => item.type === 'agentMessage' && item.text === reply);
  }, `${sample} completes and returns to authoritative idle`);
  assert.ok((await page.locator('body').innerText()).includes(reply), 'The exact inference reply becomes visible after release');
  assert.equal(requests.filter(item => item.text === text).length, 1, 'Completion does not replay inference');
  checks.push(`${sample} admitted before reply and catalog completion, then completed idle with one subscription POST`);
  return entry.history;
}
console.log('Subscription send evidence:', scratch);
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await mkdir(env.AREAL_CORE_HOME, { recursive: true });
  await writeFile(join(env.AREAL_CORE_HOME, 'openai-subscription.json'), JSON.stringify({ secret: 'synthetic-fixture-only' }));
  await writeFile(env.AREAL_CORE_CONFIG, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="responses"\nendpoint="http://127.0.0.1:${server.address().port}/v1/responses"\n`);
  application = await applicationFixture(gui, join(scratch, 'app'), bootstrap(`http://127.0.0.1:${server.address().port}/v1/responses`));
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
  await until(async () => projectOf(await snapshot())?.state?.connected, 'Project connected');
  await until(async () => projectOf(await snapshot())?.models?.some(model => model.providerId === 'areal_openai' && model.modelId === 'gpt-6.1-sol' && model.available !== false), 'Startup publishes the real subscription catalog');
  await page.getByRole('button', { name: '模型', exact: true }).click();
  const picker = page.getByRole('button', { name: '选择模型', exact: true });
  if (await picker.isVisible()) await picker.click();
  await page.locator('[role="radio"][data-model-value="areal_openai/gpt-6.1-sol"]').click();
  await page.keyboard.press('Escape');
  await writeFile(catalogGate, 'held');
  const heldHistory = await send('held', 'new', []);
  await send('held', 'existing', heldHistory);
  await rm(catalogGate);
  await until(async () => (await audit()).some(item => item.boundary === 'catalog.fetch' && item.phase === 'finish' && item.sample === 'held-new'), 'Background catalog refresh finishes after release');
  await createProjectConversation(page, 'workspace');
  const rejectedHistory = await send('rejected', 'new', []);
  const finalHistory = await send('rejected', 'existing', rejectedHistory);
  assert.equal(requests.length, 4, 'All four expired-catalog UI sends reach subscription inference exactly once');
  await writeFile(controlPath, JSON.stringify({ sample: 'explicit-failure', mode: 'rejected' }));
  const failedStatus = await page.evaluate(() => window.arealDesktop.command('chatgpt', { operation: 'status', provider: 'openai' }));
  assert.equal(failedStatus.ok, true, 'Explicit status reports a catalog failure through its normal response');
  assert.ok(failedStatus.value.modelError, 'The real external GET rejection reaches account status');
  assert.deepEqual(failedStatus.value.models, [], 'A failed explicit catalog discovery clears account models');
  await writeFile(controlPath, JSON.stringify({ sample: 'explicit-recovery', mode: 'ready' }));
  const recoveredStatus = await page.evaluate(() => window.arealDesktop.command('chatgpt', { operation: 'status', provider: 'openai' }));
  assert.equal(recoveredStatus.ok, true, 'The existing explicit status action remains usable after catalog failure');
  assert.equal(recoveredStatus.value.state, 'ready', 'Explicit refresh restores account readiness');
  assert.equal(recoveredStatus.value.catalog.source, 'account', 'Explicit recovery retains account catalog provenance');
  assert.equal(recoveredStatus.value.catalog.fresh, true, 'Explicit recovery refreshes the real catalog');
  await until(async () => projectOf(await snapshot())?.models?.some(model => model.providerId === 'areal_openai' && model.modelId === 'gpt-6.1-sol' && model.available !== false), 'Explicit refresh republishes the subscription model');
  await writeFile(join(scratch, 'explicit-recovery.json'), JSON.stringify({ failedStatus, recoveredStatus, audit: await audit() }, null, 2));
  checks.push('Explicit catalog failure clears models and the existing status refresh recovers account readiness and model publication');
  await send('ready', 'existing', finalHistory);
  assert.equal(requests.length, 5, 'Recovery also admits exactly one subscription inference request');
  assert.deepEqual(errors, [], 'No renderer or model fixture errors');
  await writeFile(join(scratch, 'final-snapshot.json'), JSON.stringify(await snapshot(), null, 2));
  await page.screenshot({ path: join(scratch, 'final.png') });
  passed = true;
} catch (error) {
  failure = error.stack; console.error(failure);
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  await rm(controlPath, { force: true });
  await rm(catalogGate, { force: true });
  for (const response of heldResponses.values()) response.destroy();
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => ({ response: ['确认取消后台任务？', '退出 AReaL Harness？'].includes(args.at(-1).message) ? 1 : args.at(-1).cancelId ?? 0 }); }).catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
  }
  await application?.close();
  try { await assertApplicationStopped(binary, env, metadata); cleanup = 'passed'; }
  catch (error) { cleanup = error.stack; passed = false; }
  if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (await hash(binary) !== identity.coreHash) { errors.push('Core binary changed during run'); passed = false; }
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, identity, checks, requests, observations: observations.map(item => item.sample), failure, cleanup, errors,
    boundary: 'Source Electron, real isolated Core, AppProviders, CoreSubscription, OpenAIAccount and ModelCatalog. Synthetic in-memory grant and custom external fetch. Native folder picker stubbed. Catalog expiry is injected at the send command boundary. Held case starts a real background catalog discovery. Rejected case arms a rejecting external GET that sending must not consult. Inference replies stay held until UI and authoritative Core admission assertions pass.',
    limits: 'No real account, OAuth exchange, external network or packaged application acceptance. This is a dependency regression test, not a latency benchmark. Isolated state and evidence are retained; owned services must stop.',
  }, null, 2));
  console.log(`${passed ? 'PASS' : 'FAIL'} subscription send`, scratch);
  if (!passed) process.exitCode = 1;
}
