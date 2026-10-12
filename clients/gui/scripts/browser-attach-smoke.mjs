import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// B-17: old GUI Thread, real Core callback, and the original live native page.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/shared-browser-06-evidence-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const sentinel = 'LEGACY_THREAD_SAME_PAGE_SENTINEL_06';
const siteFacts = { documentGets: 0, otherGets: 0, posts: [] };
const site = createServer(async (request, response) => {
  if (request.method === 'POST') { siteFacts.posts.push(request.url); response.end('ok'); return; }
  if (request.url.startsWith('/?')) siteFacts.documentGets++; else siteFacts.otherGets++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Legacy Browser Fixture</title><main><h1>${sentinel}</h1>
    <label>Draft <input id="draft" aria-label="Draft"></label><div style="height:1800px"></div></main>
    <script>window.nativeSentinel=crypto.randomUUID();window.counter=73;</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?token=SYNTHETIC_SECRET_06`;
let pageId, browserStage = 0, modelCalls = [];
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const browser = (body.tools ?? []).some(tool => tool.function?.name === 'browser_v1');
  modelCalls.push({ browser, tools: (body.tools ?? []).map(tool => tool.function?.name), messages: body.messages?.length });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  const tool = (id, args) => {
    send({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
  };
  if (!browser) { send({ content: 'Older turn remains in this Thread' }); send({}, 'stop'); }
  else {
    await until(() => pageId, 'same page claim');
    if (browserStage === 0) { browserStage = 1; tool('describe-06', { operation: 'describe', parameters: {} }); }
    else if (browserStage === 1) { browserStage = 2; tool('observe-06', { operation: 'observe', parameters: { pageId } }); }
    else { send({ content: `Observed ${sentinel}` }); send({}, 'stop'); }
  }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use requested tools, then report their result.' }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
const startedAt = new Date().toISOString();
const checks = [], errors = [], events = {};
let app, page, passed = false, runtime;
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${label}`);
}
async function snapshot() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function nativeState() {
  return app.evaluate(async ({ webContents }, url) => {
    const c = webContents.getAllWebContents().find(item => item.getURL() === url);
    if (!c) return null;
    return { id: c.id, url: c.getURL(), facts: await c.executeJavaScript(`({sentinel:window.nativeSentinel,counter:window.counter,draft:document.querySelector('#draft').value,scrollY})`) };
  }, siteUrl);
}
try {
  app = await electron.launch({ executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  runtime = await app.evaluate(({ app }) => ({ product: app.getVersion(), electron: process.versions.electron,
    chromium: process.versions.chrome, node: process.versions.node }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === 'ready', 'desktop ready');
  await app.evaluate(({ dialog, BrowserWindow }, { path, origin }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    const original = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options?.title === '允许本地开发站点' && options.message === `允许此浏览工作区访问 ${origin}？`) {
        globalThis.__m1OriginPrompt = { origin, title: options.title, count: (globalThis.__m1OriginPrompt?.count ?? 0) + 1 };
        return { response: 1, checkboxChecked: false };
      }
      return original(...args);
    };
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, { path: workspace, origin: new URL(siteUrl).origin });
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(async () => (await snapshot()).projects.find(item => item.root === workspace && item.state?.connected), 'project ready');
  const projectId = project.id;
  const first = await command('create', { projectId, profile: { id: 'fixture', revision: 'v1' } });
  const threadId = first.threadId;
  await selectConversation(page, threadId);
  await command('send', { projectId, threadId, text: 'Older turn before browser attachment' });
  const beforeTurn = await until(async () => {
    const thread = (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId];
    return thread?.turns?.length === 1 && thread.turns[0].status === 'completed' ? thread : null;
  }, 'old turn complete');
  assert.equal((beforeTurn.dynamicTools ?? []).length, 0);
  const originalTurn = JSON.stringify(beforeTurn.turns[0]);
  assert.match(originalTurn, /Older turn remains/);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt');
  await page.evaluate(({ projectId, threadId, siteUrl }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url: siteUrl }), { projectId, threadId, siteUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
  events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  await until(nativeState, 'native page loaded');
  await app.evaluate(({ webContents }, url) => {
    const c = webContents.getAllWebContents().find(item => item.getURL() === url);
    return c.executeJavaScript(`document.querySelector('#draft').value='UNSAVED_FORM_06';window.scrollTo(0,620);`);
  }, siteUrl);
  const before = await nativeState();
  assert.ok(before?.id && before.facts.sentinel && before.facts.scrollY > 0);
  const documentGetsBeforeAttach = siteFacts.documentGets;
  await page.getByRole('button', { name: '在当前聊天启用浏览器' }).click();
  const attached = await until(async () => {
    const thread = (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId];
    return thread?.toolsetRevision === 1 && thread.dynamicTools?.some(tool => tool.name === 'browser_v1') ? thread : null;
  }, 'Core attachment projected');
  assert.equal(attached.turns.length, 1);
  assert.deepEqual(attached.turns[0], beforeTurn.turns[0]);
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  const claimed = await until(async () => {
    const value = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId });
    return value.browser?.control === 'agent' ? value : null;
  }, 'same page claimed');
  pageId = claimed.browser.pageId;
  const completed = await until(async () => {
    const thread = (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId];
    return thread?.turns?.length === 2 && thread.turns[1].status === 'completed' ? thread : null;
  }, 'browser turn complete');
  const history = JSON.stringify(completed.turns[1]);
  assert.match(history, /browser_v1/); assert.match(history, /observe-06/); assert.match(history, new RegExp(sentinel));
  const after = await nativeState();
  assert.equal(after.id, before.id);
  assert.deepEqual(after.facts, before.facts);
  assert.ok(documentGetsBeforeAttach >= 1);
  assert.equal(siteFacts.documentGets, documentGetsBeforeAttach, 'attachment and first Core call do not reload the native document');
  events.B17 = { projectId, threadId, pageId, nativeWebContentsId: after.id, nativeSentinel: after.facts.sentinel,
    before, after, documentGetsBeforeAttach, siteFacts, oldTurn: beforeTurn.turns[0], browserTurn: completed.turns[1] };
  await page.screenshot({ path: join(scratch, 'gui-legacy-thread.png'), animations: 'disabled' });
  const nativePng = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), after.id);
  await writeFile(join(scratch, 'native-legacy-page.png'), Buffer.from(nativePng, 'base64'));
  checks.push('B-17: old Turn preserved; Core revision and browser callback observed original native WebContents/sentinel without navigation');
  const repeated = await command('attachBrowser', { projectId, threadId, expectedToolsetRevision: 1 });
  const afterRepeat = (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId];
  assert.equal(afterRepeat.toolsetRevision, 1);
  assert.equal(afterRepeat.dynamicTools.filter(tool => tool.name === 'browser_v1').length, 1);
  assert.deepEqual(afterRepeat.turns[0], beforeTurn.turns[0]);
  const staleRevision = await page.evaluate(({ projectId, threadId }) =>
    window.arealDesktop.command('attachBrowser', { projectId, threadId, expectedToolsetRevision: 0 }),
    { projectId, threadId });
  assert.equal(staleRevision.ok, false);
  assert.match(staleRevision.error.message, /工具版本已变化|工具版本|聊天状态/);
  const afterStale = (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId];
  assert.equal(afterStale.toolsetRevision, 1);
  events.B18 = { repeated, revisionAfterRepeat: afterRepeat.toolsetRevision,
    toolCountAfterRepeat: afterRepeat.dynamicTools.length, staleRevision,
    revisionAfterStale: afterStale.toolsetRevision };
  checks.push('B-18: repeating the idle Browser bundle attach is idempotent; stale toolset revision is refused');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve))]);
  const files = ['app/src/core/backend.cjs', 'app/src/core/core-capabilities.cjs',
    'packages/workbench/client/desktop-contract.cjs', 'renderer/src/App.tsx', 'renderer/src/Preview.tsx',
    'scripts/browser-attach-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  const manifest = { passed, checks, errors, events, modelCalls, startedAt, endedAt: new Date().toISOString(),
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    os: process.platform, arch: process.arch, runtime, fixtureVersion: 'browser-attach-fixture-v1',
    entrypoint: 'node clients/gui/scripts/browser-attach-smoke.mjs',
    scope: 'source Electron + independent desktop service + Core/Runtime + deterministic local model + synthetic site' };
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
