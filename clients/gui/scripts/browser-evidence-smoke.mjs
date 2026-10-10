import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// Public Core tool calls, independent desktop adapter, real Electron and a synthetic site.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const startedAt = new Date().toISOString();
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-evidence-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const sentinel = 'EVIDENCE_PAGE_03';
const siteFacts = { gets: 0, posts: 0 };
const sibling = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<button>Cross origin child</button>'); });
await new Promise(resolve => sibling.listen(0, '127.0.0.1', resolve));
const childUrl = `http://127.0.0.1:${sibling.address().port}/`;
const site = createServer((request, response) => {
  if (request.method === 'POST') { siteFacts.posts++; response.end('ok'); return; }
  siteFacts.gets++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url.startsWith('/frame')) { response.end('<button>Same origin child</button>'); return; }
  response.end(`<!doctype html><title>Evidence fixture</title><h1>${sentinel}</h1>
    <button id="replace">Duplicate target</button><button>Duplicate target</button>
    <label>Password <input id="password" type="password" value="HIDDEN_CANARY_03"></label>
    <input id="session" name="token" aria-label="Session credential" value="HIDDEN_TOKEN_03">
    <iframe id="same" src="/frame"></iframe><iframe id="cross" src="${childUrl}"></iframe>
    <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow target</button>';</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?token=SYNTHETIC_SECRET_03`;
let pageId, rootRef, scenario = 'observe';
const modelCalls = [];
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1);
  modelCalls.push({ scenario, hadImage: JSON.stringify(body.messages).includes('data:image/png;base64,'), tools: (body.tools ?? []).map(t => t.function?.name) });
  await until(() => pageId, 'page identity');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (last?.role !== 'tool') {
    const parameters = { pageId };
    if (scenario === 'stale') parameters.rootRef = rootRef;
    if (scenario === 'budget') parameters.budget = { nodes: 1, textBytes: 256 };
    if (scenario === 'capture') parameters.scope = 'viewport';
    send({ tool_calls: [{ index: 0, id: `${scenario}-03`, type: 'function', function: {
      name: 'browser_v1', arguments: JSON.stringify({ operation: scenario === 'capture' ? 'capture' : 'observe', parameters }),
    } }] });
    send({}, 'tool_calls');
  } else { send({ content: `Fixture checked ${scenario}` }); send({}, 'stop'); }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use requested tools.' }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
let app, page, passed = false;
const checks = [], errors = [], events = {};
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timeout: ${label}`);
}
async function state() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function thread(id) { return Object.values((await state()).projects[0]?.state?.threads ?? {}).find(item => item.id === id); }
async function nextTurn(id, previous = 0) {
  return until(async () => { const value = await thread(id); return value?.turns?.length > previous && value.turns.at(-1)?.status === 'completed' ? value.turns.at(-1) : null; }, 'Core browser turn');
}
function toolResult(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1');
  assert.ok(item, 'Core history contains browser tool');
  return item;
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  events.runtime = await app.evaluate(() => ({ versions: process.versions, platform: process.platform, arch: process.arch }));
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  await until(async () => (await state()).connection?.state === 'ready', 'desktop ready');
  events.coreChildProbe = await app.evaluate(({ app }, binary) => {
    const { spawnSync } = process.getBuiltinModule('node:child_process');
    const output = spawnSync(binary, ['--version'], { env: { ...process.env, HOME: process.env.AREAL_CORE_USER_HOME }, encoding: 'utf8' });
    const plain = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    const system = spawnSync('/usr/bin/true', [], { encoding: 'utf8' });
    return { exit: output.status, signal: output.signal, stdout: output.stdout, stderr: output.stderr,
      plain: { exit: plain.status, signal: plain.signal }, system: { exit: system.status, signal: system.signal },
      electronSandbox: app.isPackaged, homeExists: process.getBuiltinModule('node:fs').existsSync(process.env.AREAL_CORE_USER_HOME) };
  }, env.AREAL_CORE_BIN);
  await app.evaluate(({ dialog, BrowserWindow }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); BrowserWindow.getAllWindows()[0].setSize(1440, 960); }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(async () => (await state()).projects.find(item => item.root === workspace), 'project ready');
  const first = await command('create', { projectId: project.id, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  await selectConversation(page, first.threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }), { projectId: project.id, threadId: first.threadId, url: siteUrl });
  const nativeId = await until(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(c => c.getURL() === url)?.id, siteUrl), 'native page');
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => { const value = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId: project.id, threadId: first.threadId }); return value.browser?.control === 'agent' ? value : null; }, 'claim')).browser.pageId;
  const initial = toolResult(await nextTurn(first.threadId));
  const observation = JSON.parse(initial.contentItems[0].text);
  rootRef = observation.nodes.find(node => node.name === 'Duplicate target')?.ref;
  assert.match(rootRef, /^r\d+$/);
  assert.equal(observation.nativeWebContentsId, nativeId);
  assert.equal(observation.frameCoverage.childFrames.length, 2);
  assert.ok(observation.frameCoverage.childFrames.every(frame => ['covered', 'unavailable'].includes(frame.coverage)));
  assert.equal(observation.shadowCoverage, 'not-distinguished-by-accessibility-tree');
  assert.ok(observation.text.includes(sentinel));
  assert.ok(!JSON.stringify(observation).includes('SYNTHETIC_SECRET_03'));
  assert.ok(!JSON.stringify(observation).includes('HIDDEN_CANARY_03'));
  assert.ok(!JSON.stringify(observation).includes('HIDDEN_TOKEN_03'));
  events.initial = { threadId: first.threadId, callId: initial.callId, observation };
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#replace').outerHTML='<button id="replace">Duplicate target</button>'`), nativeId);
  scenario = 'stale';
  await command('send', { projectId: project.id, threadId: first.threadId, text: 'Observe old Ref after replacement' });
  const stale = toolResult(await nextTurn(first.threadId, 1));
  assert.match(JSON.stringify(stale), /stale_ref/);
  events.stale = { callId: stale.callId, contentItems: stale.contentItems };
  scenario = 'refresh';
  await command('send', { projectId: project.id, threadId: first.threadId, text: 'Refresh semantic Ref' });
  const refreshed = JSON.parse(toolResult(await nextTurn(first.threadId, 2)).contentItems[0].text);
  rootRef = refreshed.nodes.find(node => node.name === 'Duplicate target')?.ref;
  assert.match(rootRef, /^r\d+$/);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#same').src='/frame?revision=2'`), nativeId);
  await until(async () => app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#same').contentWindow.location.search === '?revision=2'`), nativeId), 'frame document replaced');
  scenario = 'stale';
  await command('send', { projectId: project.id, threadId: first.threadId, text: 'Observe old Ref after frame document navigation' });
  const frameStale = toolResult(await nextTurn(first.threadId, 3));
  assert.match(JSON.stringify(frameStale), /stale_ref/);
  events.frameStale = { callId: frameStale.callId, contentItems: frameStale.contentItems };
  checks.push('B-07: duplicate-name replacement and Frame document navigation invalidate old Refs through Core without fallback');
  scenario = 'budget';
  await command('send', { projectId: project.id, threadId: first.threadId, text: 'Observe bounded page' });
  const bounded = JSON.parse(toolResult(await nextTurn(first.threadId, 4)).contentItems[0].text);
  assert.equal(bounded.nodes.length, 1); assert.equal(bounded.truncated, true);
  assert.equal(bounded.truncationReason, 'budget');
  events.budget = bounded;
  checks.push('B-08: real iframe and Shadow fixture has explicit coverage, bounded observation reports truncation');
  scenario = 'capture';
  await command('send', { projectId: project.id, threadId: first.threadId, text: 'Capture the current page' });
  const protectedCapture = toolResult(await nextTurn(first.threadId, 5));
  assert.match(JSON.stringify(protectedCapture), /evidence_unavailable/);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#password').remove();document.querySelector('#session').remove()`), nativeId);
  await command('send', { projectId: project.id, threadId: first.threadId, text: 'Capture while cross origin frame is unavailable' });
  const crossFrameCapture = toolResult(await nextTurn(first.threadId, 6));
  assert.match(JSON.stringify(crossFrameCapture), /evidence_unavailable/);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`document.querySelector('#cross').remove()`), nativeId);
  await command('send', { projectId: project.id, threadId: first.threadId, text: 'Capture after sensitive fields and cross origin frame removed' });
  const captured = toolResult(await nextTurn(first.threadId, 7));
  const image = captured.contentItems.find(part => part.type === 'arealMedia');
  assert.ok(image?.media?.uri?.startsWith('areal://blob/'));
  assert.ok(modelCalls.some(call => call.scenario === 'capture' && call.hadImage), 'model request must contain image bytes');
  await page.locator(`[data-tool-id="${captured.id}"]`).getByRole('button').first().click();
  await page.locator(`[data-tool-id="${captured.id}"] img`).waitFor();
  await page.screenshot({ path: join(scratch, 'gui-image.png'), animations: 'disabled' });
  const nativePng = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), nativeId);
  await writeFile(join(scratch, 'native-page.png'), Buffer.from(nativePng, 'base64'));
  const second = await command('create', { projectId: project.id, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  const metadata = JSON.parse(await readFile(join(scratch, 'core', 'service.json'), 'utf8'));
  const url = new URL(metadata.endpoint); url.protocol = 'http:'; url.pathname = `/areal/blobs/${image.media.uri.split('/').at(-1)}`; url.searchParams.set('threadId', second.threadId);
  const denied = await fetch(url, { headers: { Authorization: `Bearer ${metadata.token}` } });
  assert.notEqual(denied.status, 200, 'different Thread must not read screenshot Blob');
  events.image = { threadId: first.threadId, callId: captured.callId, nativeId, media: image.media, crossThreadStatus: denied.status, siteFacts: structuredClone(siteFacts) };
  checks.push('B-09: Core tool image reaches deterministic model and GUI, Blob rejects another Thread');
  assert.equal(siteFacts.posts, 0);
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); sibling.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => sibling.close(resolve)), new Promise(resolve => model.close(resolve))]);
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/backend.cjs', 'app/src/core/service-protocol.cjs',
    'app/src/core/preview.cjs', 'app/src/core/main.cjs', 'renderer/src/Messages.tsx', 'renderer/src/ToolEvent.tsx',
    'scripts/browser-evidence-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, finishedAt: new Date().toISOString(), command: 'node clients/gui/scripts/browser-evidence-smoke.mjs',
    fixture: 'synthetic site and deterministic local chat-completions model in this script',
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    scope: 'source Electron + Core/Runtime + independent adapter + deterministic model + synthetic sites' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
