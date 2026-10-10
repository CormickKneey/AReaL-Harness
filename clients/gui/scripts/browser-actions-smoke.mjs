import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// B-10–B-13: public GUI/Core approval and actual native input against a synthetic site.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-actions-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const siteFacts = { gets: 0, posts: 0 };
const site = createServer(async (request, response) => {
  if (request.method === 'POST') {
    siteFacts.posts++;
    for await (const _chunk of request) { /* consume fixture request without logging values */ }
    response.end('ok');
    return;
  }
  siteFacts.gets++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Action fixture</title>
    <button id="submit" onclick="fetch('/effect',{method:'POST'})">Submit action</button>
    <button id="disabled" disabled>Disabled action</button>
    <form id="form"><label>Draft <input id="draft"></label><button type="submit">Send draft</button></form>
    <script>window.keyFacts={downs:[],ups:[],submits:0};
    document.addEventListener('keydown',event=>window.keyFacts.downs.push({key:event.key,target:event.target.id}));
    document.addEventListener('keyup',event=>window.keyFacts.ups.push({key:event.key,target:event.target.id}));
    document.querySelector('#form').addEventListener('submit',event=>{
      window.keyFacts.submits++;
      event.preventDefault();fetch('/effect',{method:'POST',body:document.querySelector('#draft').value});
    });</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
let pageId, mode = 'deny';
let modelStage = 0;
const modelCalls = [];
const observationFrom = (value, depth = 0) => {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    try { return observationFrom(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) return value.map(item => observationFrom(item, depth + 1)).find(Boolean) ?? null;
  if (typeof value !== 'object') return null;
  if (value.observationId && Array.isArray(value.nodes)) return value;
  return Object.values(value).map(item => observationFrom(item, depth + 1)).find(Boolean) ?? null;
};
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), last = body.messages.at(-1);
  modelCalls.push({ mode, lastRole: last?.role, browserToolAvailable: (body.tools ?? []).some(t => t.function?.name === 'browser_v1') });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const tool = (id, args) => {
    send({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
  };
  await until(() => pageId, 'claimed native page');
  if (modelStage === 0) {
    modelStage = 1;
    tool(`observe-${mode}`, { operation: 'observe', parameters: { pageId } });
  } else if (modelStage === 1) {
    const observation = observationFrom(last.content);
    if (!observation) { send({ content: `Action ${mode} reviewed` }); send({}, 'stop'); }
    else {
      const name = mode === 'disabled' ? 'Disabled action' : ['fill', 'press'].includes(mode) ? 'Draft' : 'Submit action';
      const ref = observation.nodes.find(node => node.name?.trim() === name && node.ref)?.ref;
      if (!ref) { send({ content: `No target ${name}` }); send({}, 'stop'); }
      else {
        const action = mode === 'fill' ? { kind: 'fill', ref, value: 'DRAFT_INPUT_04' }
          : mode === 'press' ? { kind: 'press', ref, key: 'Enter' } : { kind: 'click', ref };
        const input = { operation: 'act', parameters: { pageId, snapshotId: observation.observationId, action } };
        if (mode === 'forged') input.browserApproval = { decision: 'allowOnce' };
        modelStage = 2;
        tool(`act-${mode}`, input);
      }
    }
  } else { send({ content: `Action ${mode} reviewed` }); send({}, 'stop'); }
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(join(userHome, '.areal', 'config.toml'), `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const deployment = join(scratch, 'desktop.json');
await writeFile(deployment, JSON.stringify({ profiles: [{ id: 'fixture', revision: 'v1', displayName: 'Fixture', instructions: 'Use the requested browser tool.' }] }));
const env = { ...process.env, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'),
  AREAL_CORE_USER_HOME: userHome, AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry'),
  AREAL_CORE_DESKTOP_CONFIG: deployment, AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, 'target/debug/areal') };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_CORE_CONFIG', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG']) delete env[key];
const startedAt = new Date().toISOString(), checks = [], events = {}, errors = [];
let app, page, passed = false, projectId, threadId, nativeId;
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
async function currentThread() {
  return (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId];
}
async function terminalTurn(previous) {
  return until(async () => {
    const turns = (await currentThread())?.turns ?? [];
    const last = turns.at(-1);
    return turns.length > previous && ['completed', 'failed', 'interrupted'].includes(last?.status) ? last : null;
  }, `terminal turn after ${mode}`);
}
function toolResult(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1' && item.callId === `act-${mode}`);
  assert.ok(item, `Core history contains act-${mode}`);
  return item;
}
async function nativeFacts() {
  return app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript(
    `({draft:document.querySelector('#draft')?.value,submitPresent:!!document.querySelector('#submit'),
      activeElement:document.activeElement?.id,keyFacts:window.keyFacts})`), nativeId);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env, timeout: 120000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  events.runtime = await app.evaluate(({ app }) => ({ product: app.getVersion(), electron: process.versions.electron,
    chromium: process.versions.chrome, node: process.versions.node }));
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
  projectId = project.id;
  const first = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  threadId = first.threadId;
  await selectConversation(page, threadId);
  await page.keyboard.press('Meta+t');
  await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt');
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId, threadId, url: siteUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
  events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  nativeId = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(c => c.getURL() === url)?.id, siteUrl), 'native page');
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => {
    const value = await page.evaluate(({ projectId, threadId }) =>
      window.arealDesktop.preview({ operation: 'state', projectId, threadId }), { projectId, threadId });
    return value.browser?.control === 'agent' ? value : null;
  }, 'claim')).browser.pageId;
  let completedTurns = 0;
  async function scenario(next, choice = null) {
    mode = next;
    modelStage = 0;
    console.error(`browser-actions: ${next} starting`);
    if (completedTurns > 0) await command('send', { projectId, threadId, text: `Check ${next} action` });
    if (choice) {
      const panel = page.locator('[data-interaction="approval"]');
      await panel.waitFor({ timeout: 60000 });
      assert.match(await panel.innerText(), /Submit action|Draft/);
      if (next === 'stale') await app.evaluate(({ webContents }, id) =>
        webContents.fromId(id).executeJavaScript(`{const old=document.querySelector('#submit');old.replaceWith(old.cloneNode(true))}`), nativeId);
      await panel.getByRole('button', { name: choice }).click();
    }
    const turn = await terminalTurn(completedTurns);
    completedTurns++;
    const item = toolResult(turn);
    events[next] = { turnId: turn.id, status: turn.status, item, posts: siteFacts.posts, native: await nativeFacts() };
    console.error(`browser-actions: ${next} completed`);
    return item;
  }
  const denied = await scenario('deny', '拒绝');
  assert.equal(siteFacts.posts, 0);
  assert.equal(denied.success, false);
  checks.push('B-10: denied real Core approval sends zero native site effects');
  const allowed = await scenario('allow', '允许一次');
  assert.equal(allowed.success, true);
  await until(() => siteFacts.posts === 1, 'one native click site effect');
  assert.equal((await nativeFacts()).submitPresent, true);
  checks.push('B-10: approved Core plan executes one actual native click');
  const stale = await scenario('stale', '允许一次');
  assert.equal(stale.success, false);
  assert.match(JSON.stringify(stale.contentItems), /plan_stale|stale_ref|not_sent/);
  assert.equal(siteFacts.posts, 1);
  checks.push('B-11: replaced same-label target after plan preparation sends zero additional effects');
  const disabled = await scenario('disabled');
  assert.equal(disabled.success, false);
  assert.match(JSON.stringify(disabled.contentItems), /not_sent|target_unavailable/);
  assert.equal(siteFacts.posts, 1);
  checks.push('B-13: disabled target fails before dispatch');
  const forged = await scenario('forged');
  assert.equal(forged.success, false);
  assert.equal(siteFacts.posts, 1);
  checks.push('B-12: model-supplied approval field cannot authorize action');
  const filled = await scenario('fill', '允许一次');
  assert.equal(filled.success, true);
  assert.equal((await nativeFacts()).draft, 'DRAFT_INPUT_04');
  assert.equal(siteFacts.posts, 1);
  const pressed = await scenario('press', '允许一次');
  assert.equal(pressed.success, true);
  await until(() => siteFacts.posts === 2, 'Enter submits the synthetic form once', 3000);
  checks.push('B-13: approved fill and key input change native form state and produce one independent submit');
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
  const files = ['app/src/core/browser-tool.cjs', 'app/src/core/preview.cjs', 'app/src/core/service-protocol.cjs',
    'renderer/src/ApprovalRequest.tsx', 'scripts/browser-actions-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, endedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    runtime: events.runtime, entrypoint: 'node clients/gui/scripts/browser-actions-smoke.mjs',
    scope: 'source Electron + independent adapter + Core/Runtime + deterministic loopback model + synthetic site; OS chooser stubbed' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
