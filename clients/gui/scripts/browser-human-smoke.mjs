import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectConversation, captureSmokeFailure } from './smoke-navigation.mjs';

// B-14–B-16: a local takeover fence and a lost native input receipt on one real Core turn.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const scratch = await mkdtemp('/private/tmp/areal-browser-human-');
const workspace = join(scratch, 'workspace'), userHome = join(scratch, 'user');
await mkdir(workspace); await mkdir(join(userHome, '.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const siteFacts = { posts: 0, documentGets: 0, cookieOnGets: [], getRequests: [], redirects: 0,
  forbiddenRequests: 0 };
const forbidden = createServer((_request, response) => { siteFacts.forbiddenRequests++; response.end('forbidden target reached'); });
await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve));
const forbiddenUrl = `http://127.0.0.1:${forbidden.address().port}/target`;
const site = createServer(async (request, response) => {
  if (request.url === '/redirect') {
    siteFacts.redirects++;
    response.writeHead(302, { Location: forbiddenUrl }); response.end(); return;
  }
  if (request.method === 'POST') {
    siteFacts.posts++;
    for await (const _chunk of request) { /* never retain the synthetic body */ }
    response.end('ok');
    return;
  }
  if (request.url.startsWith('/?')) {
    siteFacts.documentGets++;
    siteFacts.cookieOnGets.push(request.headers.cookie?.includes('m1_session=synthetic_05') ?? false);
    siteFacts.getRequests.push({ url: request.url, cookie: siteFacts.cookieOnGets.at(-1) });
  }
  response.setHeader('Set-Cookie', 'm1_session=synthetic_05; HttpOnly; SameSite=Lax');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Human boundary fixture</title>
    <h1>HUMAN_BOUNDARY_05</h1>
    <button id="effect" onclick="fetch('/effect',{method:'POST'})">Submit once</button>
    <label>Password <input id="password" type="password"></label>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/?token=SYNTHETIC_URL_05`;
const secondUrl = `http://127.0.0.1:${site.address().port}/?token=SECOND_WORKSPACE_05`;
const secret = 'SYNTHETIC_LOGIN_SECRET_05';
let pageId, snapshotId, targetRef, phase = 'initial', issued = false;
const modelCalls = [];
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timeout: ${label}`);
}
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), last = body.messages.at(-1);
  modelCalls.push({ phase, lastRole: last?.role, browserToolAvailable: (body.tools ?? []).some(tool => tool.function?.name === 'browser_v1') });
  await until(() => pageId, 'claimed page');
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!issued) {
    issued = true;
    const args = phase === 'click'
      ? { operation: 'act', parameters: { pageId, snapshotId, action: { kind: 'click', ref: targetRef } } }
      : { operation: 'observe', parameters: { pageId } };
    send({ tool_calls: [{ index: 0, id: `human-${phase}`, type: 'function',
      function: { name: 'browser_v1', arguments: JSON.stringify(args) } }] });
    send({}, 'tool_calls');
  } else { send({ content: `Fixture completed ${phase}` }); send({}, 'stop'); }
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
const startedAt = new Date().toISOString(), events = {}, checks = [], errors = [];
let app, page, passed = false, projectId, threadId, nativeId;
async function snapshot() { return page.evaluate(() => window.arealDesktop.snapshot()); }
async function command(name, params) {
  const result = await page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), { name, params });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
}
async function thread() { return (await snapshot()).projects.find(item => item.id === projectId)?.state?.threads?.[threadId]; }
async function terminalTurn(previous) {
  return until(async () => {
    const turns = (await thread())?.turns ?? [], last = turns.at(-1);
    return turns.length > previous && ['completed', 'failed', 'interrupted'].includes(last?.status) ? last : null;
  }, `terminal ${phase} turn`);
}
function browserItem(turn) {
  const item = turn.items.find(item => item.type === 'dynamicToolCall' && item.tool === 'browser_v1');
  assert.ok(item, `Core history includes browser_v1 for ${phase}`);
  return item;
}
async function controlState() {
  return page.evaluate(({ projectId, threadId }) => window.arealDesktop.preview({ operation: 'state', projectId, threadId }),
    { projectId, threadId });
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
  await page.keyboard.press('Meta+t'); await page.locator('.preview-panel').waitFor();
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'focused Main Origin prompt');
  await page.evaluate(({ projectId, threadId, url }) => window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, url }),
    { projectId, threadId, url: siteUrl });
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  assert.equal(events.developmentOriginPrompt?.count, 1, 'exact-Origin Main prompt occurred once');
  events.developmentOriginPrompt.response = 'fixture-stub-allow-exact-origin';
  nativeId = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().find(item => item.getURL() === url)?.id, siteUrl), 'native page');
  await page.getByRole('button', { name: '让 Agent 检查当前页' }).click();
  pageId = (await until(async () => {
    const value = await controlState(); return value.browser?.control === 'agent' ? value : null;
  }, 'initial claim')).browser.pageId;
  const initial = browserItem(await terminalTurn(0));
  const observed = JSON.parse(initial.contentItems[0].text);
  snapshotId = observed.observationId;
  targetRef = observed.nodes.find(node => node.name === 'Submit once' && node.ref)?.ref;
  assert.match(targetRef, /^r\d+$/);
  events.initial = { pageId, nativeId, snapshotId, targetRef, controlEpoch: observed.controlEpoch, postCount: siteFacts.posts };

  // The actual CDP release reaches the page/server, but its receipt is withheld.
  phase = 'click'; issued = false;
  await command('send', { projectId, threadId, text: 'Click Submit once' });
  const approval = page.locator('[data-interaction="approval"]');
  await approval.waitFor({ timeout: 60000 });
  assert.match(await approval.innerText(), /Submit once/);
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id), original = c.debugger.sendCommand.bind(c.debugger);
    c.__m1OriginalSend = original;
    c.debugger.sendCommand = (method, params) => {
      const sent = original(method, params);
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && !c.__m1HeldReceipt) {
        c.__m1HeldReceipt = true;
        return sent.then(value => new Promise(resolve => { c.__m1ReleaseReceipt = () => resolve(value); }));
      }
      return sent;
    };
  }, nativeId);
  await approval.getByRole('button', { name: '允许一次' }).click();
  await until(() => siteFacts.posts === 1, 'one server effect before lost receipt');
  const beforeTakeover = Date.now();
  const takeover = await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'takeover', projectId, threadId, pageId }), { projectId, threadId, pageId });
  const takeoverMs = Date.now() - beforeTakeover;
  assert.ok(takeoverMs < 2000, `local takeover blocked for ${takeoverMs} ms`);
  assert.equal(takeover.browser.control, 'transferring');
  events.takeover = { elapsedMs: takeoverMs, immediateControl: takeover.browser.control, postCount: siteFacts.posts };
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    if (!c.__m1HeldReceipt || !c.__m1ReleaseReceipt) throw Error('native release receipt was not held');
    c.debugger.sendCommand = c.__m1OriginalSend;
    c.__m1ReleaseReceipt();
  }, nativeId);
  await until(async () => (await controlState()).browser?.control === 'human', 'native input convergence');
  const clickTurn = await terminalTurn(1), clickItem = browserItem(clickTurn);
  events.lostReceipt = { turnStatus: clickTurn.status, item: clickItem, postCount: siteFacts.posts,
    control: (await controlState()).browser.control };
  assert.equal(siteFacts.posts, 1);
  assert.match(JSON.stringify(clickItem), /outcome_unknown|unknown/i);
  checks.push('B-14/B-16: local takeover fences a pending input receipt; one server effect remains UNKNOWN until convergence');

  // A human-only secret must not enter Core's next observation or model context.
  await app.evaluate(({ webContents }, { id, value }) => webContents.fromId(id).executeJavaScript(
    `document.querySelector('#password').value=${JSON.stringify(value)}`), { id: nativeId, value: secret });
  await command('manage', { projectId, threadId, operation: 'toolAcknowledge', itemId: clickItem.id,
    inspection: 'Synthetic server recorded exactly one POST; receipt was withheld, so the original action remains unknown and will not be retried.' });
  phase = 'humanObserve'; issued = false;
  await command('send', { projectId, threadId, text: 'Try to observe while the human controls this page' });
  const blocked = browserItem(await terminalTurn(2));
  assert.equal(blocked.success, false);
  assert.ok(!JSON.stringify(blocked).includes(secret));
  assert.equal(siteFacts.posts, 1);
  events.humanOnly = { item: blocked, control: (await controlState()).browser.control, postCount: siteFacts.posts };
  checks.push('B-15: Core browser read is refused while human controls the page');

  phase = 'after'; issued = false;
  await page.getByRole('button', { name: '交还并让 Agent 检查当前页' }).click();
  await until(async () => (await controlState()).browser?.control === 'agent', 'explicit giveback');
  const after = browserItem(await terminalTurn(3));
  const fresh = JSON.parse(after.contentItems[0].text);
  assert.notEqual(fresh.controlEpoch, observed.controlEpoch);
  assert.ok(!JSON.stringify(after).includes(secret));
  assert.equal(siteFacts.posts, 1, 'giveback does not replay ambiguous submit');
  events.giveback = { pageId, nativeId, beforeEpoch: observed.controlEpoch, afterEpoch: fresh.controlEpoch,
    postCount: siteFacts.posts, itemId: after.id };
  checks.push('B-15/B-16: explicit giveback creates a fresh observation epoch and never replays the UNKNOWN submit');

  // A second native page in the same browser workspace must retain the
  // session, while the four-page admission limit is enforced before create.
  const siblings = [];
  for (let index = 0; index < 3; index++) {
    const next = await page.evaluate(({ projectId, threadId, pageId }) =>
      window.arealDesktop.preview({ operation: 'newPage', projectId, threadId, pageId }),
      { projectId, threadId, pageId });
    siblings.push(next.browser.pageId);
  }
  const full = await controlState();
  assert.equal(full.workspace.pages.length, 4);
  assert.equal(new Set(full.workspace.pages.map(item => item.pageId)).size, 4);
  assert.ok(siblings.every(id => full.workspace.pages.find(item => item.pageId === id)?.openerId === pageId));
  const beforeQuota = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  const quota = await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'newPage', projectId, threadId, pageId })
      .then(() => ({ accepted: true }), error => ({ accepted: false, message: error.message })),
    { projectId, threadId, pageId });
  assert.equal(quota.accepted, false);
  assert.match(quota.message, /4页/);
  assert.equal((await controlState()).workspace.pages.length, 4);
  assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length), beforeQuota);
  events.pages = { parent: pageId, siblings, quota, nativeBeforeRejectedCreate: beforeQuota,
    workspace: (await controlState()).workspace };
  checks.push('B-19/B-24: public workspace metadata preserves page identity and opener; fifth page is rejected before native create');

  const sibling = siblings[0];
  const cookieBefore = siteFacts.cookieOnGets.length;
  await page.evaluate(({ projectId, threadId, pageId, url }) =>
    window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, pageId, url }),
    { projectId, threadId, pageId: sibling, url: siteUrl });
  await until(() => siteFacts.cookieOnGets.length > cookieBefore, 'sibling native request');
  assert.equal(siteFacts.cookieOnGets.at(-1), true, 'HTTPOnly cookie follows same-workspace sibling');
  const siblingNative = await until(() => app.evaluate(({ webContents }, url) =>
    webContents.getAllWebContents().filter(item => item.getURL() === url).length >= 2, siteUrl), 'sibling native page');
  await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'release', projectId, threadId, pageId, userIntent: true }),
    { projectId, threadId, pageId: sibling });
  assert.equal((await controlState()).workspace.pages.length, 3);
  assert.equal(siteFacts.posts, 1);
  events.session = { sameWorkspaceCookieReceived: true, siblingNative, remainingPages: 3,
    postCount: siteFacts.posts };
  checks.push('B-21: same-workspace sibling sends the synthetic HTTPOnly cookie; closing it preserves the original page');

  const second = await command('create', { projectId, browserEnabled: true, profile: { id: 'fixture', revision: 'v1' } });
  await selectConversation(page, second.threadId);
  await page.keyboard.press('Meta+t');
  const beforeSecondNativeIds = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(item => item.id));
  const secondPage = await page.evaluate(({ projectId, threadId }) =>
    window.arealDesktop.preview({ operation: 'newPage', projectId, threadId }),
    { projectId, threadId: second.threadId });
  const secondId = secondPage.browser.pageId;
  const secondNativeId = await until(() => app.evaluate(({ webContents }, ids) =>
    webContents.getAllWebContents().find(item => !ids.includes(item.id))?.id,
    beforeSecondNativeIds), 'new second workspace native page');
  const beforeSecondCookies = await app.evaluate(({ webContents }, { id, url }) =>
    webContents.fromId(id).session.cookies.get({ url }), { id: secondNativeId, url: siteUrl });
  await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'show', projectId, threadId, pageId, visible: true }),
    { projectId, threadId: second.threadId, pageId: secondId });
  await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'second workspace focused');
  const isolatedBefore = siteFacts.getRequests.length;
  await page.evaluate(({ projectId, threadId, pageId, url }) =>
    window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, pageId, url }),
    { projectId, threadId: second.threadId, pageId: secondId, url: secondUrl });
  const secondRequest = await until(() => siteFacts.getRequests.slice(isolatedBefore)
    .find(item => item.url === new URL(secondUrl).pathname + new URL(secondUrl).search), 'second workspace native request');
  const sessionIsolated = await app.evaluate(({ webContents }, { first, second }) =>
    webContents.fromId(first).session !== webContents.fromId(second).session,
    { first: nativeId, second: secondNativeId });
  events.isolation = { secondThreadId: second.threadId, secondPageId: secondId,
    secondNativeId, separateNativeSession: sessionIsolated,
    cookiesBeforeSecondNavigation: beforeSecondCookies.map(item => item.name),
    secondRequestSentFirstCookie: secondRequest.cookie,
    concurrentRequests: siteFacts.getRequests.slice(isolatedBefore),
    developmentOriginPrompt: await app.evaluate(() => globalThis.__m1OriginPrompt) };
  assert.equal(sessionIsolated, true);
  assert.deepEqual(beforeSecondCookies, [], 'second session must have no first-workspace cookies');
  assert.equal(secondRequest.cookie, false, 'new browser workspace cannot send first workspace cookie');
  assert.equal((await controlState()).workspace.pages.length, 3, 'original workspace remains intact');
  checks.push('B-22: separate Thread workspace uses separate Native Session and sends no first-workspace HTTPOnly cookie');

  const redirected = new URL('/redirect', siteUrl).href;
  await page.evaluate(({ projectId, threadId, pageId, url }) =>
    window.arealDesktop.preview({ operation: 'navigate', projectId, threadId, pageId, url }),
    { projectId, threadId: second.threadId, pageId: secondId, url: redirected });
  await until(() => siteFacts.redirects >= 1, 'allowed origin redirect response');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(siteFacts.forbiddenRequests, 0, 'unapproved redirect target receives no request');
  const afterRedirectUrl = await app.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), secondNativeId);
  assert.notEqual(afterRedirectUrl, forbiddenUrl);
  events.redirectPolicy = { allowedOriginRedirects: siteFacts.redirects,
    forbiddenTargetRequests: siteFacts.forbiddenRequests, afterRedirectUrl };
  checks.push('B-23: approved synthetic Origin cannot redirect Native page into another unapproved loopback Origin');

  const beforeCrash = (await controlState()).workspace.pages.find(item => item.pageId === pageId);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), nativeId);
  const crashed = await until(async () => (await controlState()).workspace.pages.find(item =>
    item.pageId === pageId && item.resource === 'crashed'), 'original Native renderer crash');
  assert.equal(crashed.pageGeneration, beforeCrash.pageGeneration);
  await page.evaluate(({ projectId, threadId, pageId }) =>
    window.arealDesktop.preview({ operation: 'reload', projectId, threadId, pageId }),
    { projectId, threadId, pageId });
  const replacement = await until(async () => (await controlState()).workspace.pages.find(item =>
    item.pageId === pageId && item.resource === 'ready' && item.pageGeneration > beforeCrash.pageGeneration),
  'replacement Native page generation');
  assert.equal(replacement.pageGeneration, beforeCrash.pageGeneration + 1);
  const replacementNativeId = await until(() => app.evaluate(({ webContents }, { url, oldId }) =>
    webContents.getAllWebContents().find(item => item.id !== oldId && item.getURL() === url)?.id,
    { url: siteUrl, oldId: nativeId }), 'replacement Native document');
  assert.notEqual(replacementNativeId, nativeId);
  assert.equal(siteFacts.posts, 1, 'crash restoration does not replay the UNKNOWN submit');
  events.crash = { pageId, oldNativeId: nativeId, newNativeId: replacementNativeId,
    beforeGeneration: beforeCrash.pageGeneration, afterGeneration: replacement.pageGeneration,
    postCount: siteFacts.posts, stateLoss: replacement.stateLoss };
  checks.push('B-25: Native renderer crash replaces the same logical Page with a new generation and no action replay');

  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  if (app) await app.close();
  site.closeAllConnections(); model.closeAllConnections(); forbidden.closeAllConnections();
  await Promise.all([new Promise(resolve => site.close(resolve)), new Promise(resolve => model.close(resolve)),
    new Promise(resolve => forbidden.close(resolve))]);
  const files = ['app/src/core/preview.cjs', 'app/src/core/main.cjs', 'app/src/core/service-protocol.cjs',
    'renderer/src/Preview.tsx', 'renderer/src/UnknownToolInspection.tsx', 'scripts/browser-human-smoke.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(gui, file))).digest('hex')])));
  await writeFile(join(scratch, 'run-manifest.json'), JSON.stringify({ passed, checks, errors, events, modelCalls,
    startedAt, endedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    diffSHA256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root })).digest('hex'),
    hashes, coreBinary: env.AREAL_CORE_BIN,
    coreBinarySHA256: createHash('sha256').update(await readFile(env.AREAL_CORE_BIN)).digest('hex'),
    scope: 'source Electron + independent adapter + Core/Runtime + deterministic local model + synthetic site; OS chooser and exact-Origin bootstrap stubbed',
    entrypoint: 'node clients/gui/scripts/browser-human-smoke.mjs' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
