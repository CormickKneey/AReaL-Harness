import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { chromium, _electron: electron } = require('playwright-core');
const { CoreBackend } = require('../app/src/core/backend.cjs');
const { CoreTaskModel } = await import('../packages/workbench/client/core-model.js');
const dist = process.env.AREAL_RENDERER_DIST || join(gui, 'renderer/dist');
const scratch = await mkdtemp('/private/tmp/areal-history-ui-');
const locale = process.env.AREAL_HISTORY_UI_LOCALE || 'zh-CN';
const labels = locale === 'en' ? { older: 'Load older messages', full: 'Load full content', loading: 'Loading full content…', agent: 'This historical content', user: 'This message', tool: 'This tool record' }
  : { older: '加载更早的消息', full: '加载完整内容', loading: '正在加载完整内容…', agent: '这段历史内容', user: '这条消息', tool: '这条工具记录' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    const path = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error('Invalid asset path');
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, desktop, passed = false;
const checks = [], errors = [];
try {
  let page;
  if (process.env.AREAL_HISTORY_UI_ELECTRON === '1') {
    const entry = join(scratch, 'main.cjs');
    await writeFile(entry, `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const window=new BrowserWindow({width:1280,height:960,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});window.loadURL('about:blank');});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({ executablePath: require('electron'), args: [entry, `--user-data-dir=${join(scratch, 'electron')}`], env });
    page = await desktop.firstWindow();
  } else {
    browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
    page = await browser.newPage({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
  }
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(({ locale }) => {
    localStorage.setItem('areal-gui:application-preferences', JSON.stringify({ locale }));
    const threadId = 'history-thread';
    const thread = { id: threadId, cwd: '/isolated/workspace', status: 'idle', displayHistory: { supported: true, complete: false, omitted: false },
      turns: [{ id: 'latest', status: 'completed', items: [{ id: 'latest-user', type: 'userMessage', content: [{ type: 'text', text: 'LATEST_USER_SENTINEL' }] },
        { id: 'huge', type: 'historyDeferred', originalType: 'agentMessage', cursor: 'private-core-cursor', version: 'fixture-v1', totalBytes: 70 * 1048576 }] }] };
    const project = { id: 'history-project', root: thread.cwd, state: { connected: true, threads: { [threadId]: thread }, queues: {}, interactions: {} },
      models: [], profiles: [], pending: [], outcomes: {}, configurations: {}, summaries: [{ id: threadId, name: 'History fixture', status: 'idle' }], core: {} };
    const snapshot = { revision: 1, desktopCapabilities: { currentCommands: true }, projects: [project], connection: { state: 'ready' }, library: { projects: {}, threads: {}, settings: {}, projectOrder: [] } };
    let listener, projectionListener, sequence = 0, completeLoad;
    const publish = () => { snapshot.revision++; listener?.(structuredClone(snapshot)); };
    localStorage.setItem('areal-gui:project', project.id); localStorage.setItem(`areal-gui:thread:${project.id}`, threadId);
    window.calls = [];
    window.installActiveHistory = value => { Object.assign(thread, value); publish(); };
    window.activeHistory = false;
    window.setDeferredType = type => { thread.turns[0].items[1].originalType = type; publish(); };
    window.completeItem = () => { thread.turns.at(-1).items[1] = { id: 'huge', type: 'agentMessage', phase: 'final_answer', text: 'COMPLETE_UNICODE_雪🙂_SENTINEL' }; publish(); completeLoad?.({ ok: true, value: { loaded: true, itemId: 'huge' } }); };
    window.arealDesktop = {
      snapshot: async () => structuredClone(snapshot), onProjection: callback => { projectionListener = callback; listener = value => callback({ frame: { projection: 1, stream: 'history-fixture', sequence: ++sequence, kind: 'full', snapshot: value } }); return () => {}; },
      requestProjection: requestId => projectionListener({ requestId, frame: { projection: 1, stream: 'history-fixture', sequence: ++sequence, kind: 'full', snapshot: structuredClone(snapshot) } }),
      theme: async () => ({ platform: 'darwin', dark: false, id: 'light' }), onTheme: () => () => {}, onMcpAppEvent: () => () => {}, presentReady: async () => {}, preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === 'history' && window.activeHistory) return window.activeHistoryCommand(params);
        if (name === 'history') {
          if (params.operation === 'loadItem') { thread.displayHistory.loadingItems = { huge: { bytes: 0, totalBytes: 70 * 1048576 } }; publish(); return new Promise(resolve => { completeLoad = resolve; }); }
          if (params.operation === 'loadOlder') { thread.turns.unshift({ id: 'old', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', phase: 'final_answer', text: 'OLDER_PAGE_SENTINEL' }] }); thread.displayHistory.complete = true; publish(); }
          return { ok: true, value: { supported: true, data: [], complete: thread.displayHistory.complete } };
        }
        if (name === 'workspace') return { ok: true, value: { git: true, branch: 'main' } };
        if (name === 'trajectory') return { ok: true, value: { enabled: false, state: 'disabled', queue: {}, records: [] } };
        return { ok: true, value: { data: [] } };
      },
    };
  }, { locale });
  await page.goto(origin);
  await page.getByText('LATEST_USER_SENTINEL', { exact: true }).waitFor();
  const older = page.getByRole('button', { name: labels.older, exact: true });
  await older.waitFor({ timeout: 3000 });
  assert.equal((await page.evaluate(() => window.calls)).filter(call => call.name === 'history' && call.params.operation === 'loadItem').length, 0);
  await page.getByText(labels.agent, { exact: false }).waitFor();
  await page.evaluate(() => window.setDeferredType('userMessage')); await page.getByText(labels.user, { exact: false }).waitFor();
  await page.evaluate(() => window.setDeferredType('dynamicToolCall')); await page.getByText(labels.tool, { exact: false }).waitFor();
  await page.evaluate(() => window.setDeferredType('agentMessage'));
  await page.getByRole('button', { name: labels.full, exact: true }).click();
  await page.getByText(labels.loading, { exact: false }).waitFor();
  assert.equal(await page.getByText('COMPLETE_UNICODE_雪🙂_SENTINEL', { exact: true }).count(), 0);
  await page.screenshot({ path: join(scratch, '01-explicit-loading.png'), animations: 'disabled' });
  await page.evaluate(() => window.completeItem());
  await page.getByText('COMPLETE_UNICODE_雪🙂_SENTINEL', { exact: true }).waitFor();
  await older.click(); await page.getByText('OLDER_PAGE_SENTINEL', { exact: true }).waitFor();
  const texts = await page.locator('[data-turn-id]').allTextContents();
  assert.ok(texts[0].includes('OLDER_PAGE_SENTINEL') && texts.at(-1).includes('COMPLETE_UNICODE_雪🙂_SENTINEL'));
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.some(call => ['send', 'continue', 'steer'].includes(call.name)), false);
  assert.ok(calls.some(call => call.name === 'history' && call.params.operation === 'acquire' && call.params.viewId));
  await page.screenshot({ path: join(scratch, '02-loaded.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  checks.push('real deferred marker stays visible during explicit load, complete Unicode content replaces it, older messages prepend without losing latest content, no send');
  const model = new CoreTaskModel();
  const activeTurn = { id: 'active', status: 'inProgress', items: [{ id: 'live-answer', type: 'agentMessage', text: 'ACTIVE_LIVE_SENTINEL' }] };
  const latest = () => ({ thread: { id: 'history-thread', cwd: '/isolated/workspace', status: 'active', turns: [structuredClone(activeTurn)] },
    history: { snapshotId: 'active-snapshot', nextCursor: 'active:0', complete: false } });
  let activePage = 0;
  const rpc = [];
  const project = { id: 'history-project', model, connectionGeneration: 1 };
  const backend = Object.assign(Object.create(CoreBackend.prototype), { projects: new Map([[project.id, project]]),
    providers: { redact: value => value }, library: { recordThreadActivity: async () => {} },
    onChange: () => {} });
  project.client = { ready: true, closed: false,
    capabilities: { features: { boundedObservation: true, boundedHistory: true } },
    request: async (method, params, options) => {
      rpc.push({ method, params, maxResponseBytes: options?.maxResponseBytes });
      assert.equal(method, 'areal/conversation/history');
      assert.ok(params.maxBytes <= 1048576 && options.maxResponseBytes <= 1048576);
      const n = Number(params.cursor.split(':')[1]); activePage++;
      const first = n === 5;
      const item = first ? { id: 'active-user', type: 'userMessage', content: [{ type: 'text', text: 'ACTIVE_USER_SENTINEL' }] }
        : { id: `active-message-${n}`, type: 'agentMessage', text: `ACTIVE_STEP_${n}_SENTINEL` };
      return { snapshotId: 'active-snapshot', data: [{ sourceThreadId: 'history-thread', sourceTurnId: 'active', sourceItemId: item.id,
        sourceTurnStatus: 'inProgress', turn: { id: 'active', status: 'inProgress' }, item }], nextCursor: first ? null : `active:${n + 1}`, complete: first };
    } };
  backend.installObservation(project, latest());
  await page.exposeFunction('activeHistoryCommand', async request => {
    try { return { ok: true, value: await backend.historyCommand(project, request) }; }
    catch (error) { return { ok: false, error: { message: error.message } }; }
  });
  let projection = Promise.resolve();
  const publishActive = () => {
    const value = structuredClone(model.state.threads['history-thread']);
    projection = projection.then(() => page.evaluate(value => window.installActiveHistory(value), value));
  };
  model.subscribe(publishActive);
  await page.evaluate(value => { window.activeHistory = true; window.installActiveHistory(value); }, model.state.threads['history-thread']);
  await page.getByText('ACTIVE_USER_SENTINEL', { exact: true }).waitFor();
  await page.getByText('ACTIVE_LIVE_SENTINEL', { exact: true }).waitFor();
  assert.equal(activePage, 6, 'latest turn loads across more than four bounded pages without a click');
  assert.equal(await older.count(), 0, 'one active turn never needs a load-older button');
  assert.equal(await page.getByText('ACTIVE_STEP_0_SENTINEL', { exact: true }).count(), 1);
  model.event('item/agentMessage/delta', { threadId: 'history-thread', turnId: 'active', itemId: 'live-answer', delta: '_CONTINUED' });
  await page.getByText('ACTIVE_LIVE_SENTINEL_CONTINUED', { exact: true }).waitFor();
  backend.installObservation(project, latest());
  await projection;
  await page.getByText('ACTIVE_USER_SENTINEL', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.message-column')?.textContent.includes('加载更早的消息'));
  await page.screenshot({ path: join(scratch, '03-active-turn.png'), animations: 'disabled' });
  assert.ok(rpc.every(call => call.method === 'areal/conversation/history'));
  checks.push('real Desktop history owner automatically restores six-page active turn, retains prompt after refresh, and streaming continues without send or manual pagination');
  await projection;
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await desktop?.close();
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  const hashes = Object.fromEntries(await Promise.all(['Messages.tsx', 'ConversationHistory.tsx', 'conversationPresentation.ts', 'i18n/messages/common.ts'].map(async file => [file, createHash('sha256').update(await readFile(join(gui, 'renderer/src', file))).digest('hex')])));
  hashes['app/src/core/backend.cjs'] = createHash('sha256').update(await readFile(join(gui, 'app/src/core/backend.cjs'))).digest('hex');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gui, encoding: 'utf8' }).trim();
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, locale, checks, errors, hashes, sourceCommit, node: process.version, scope: `${desktop ? 'Electron' : 'Chrome'} production Renderer with actual Desktop history owner and controlled Core responses; no actual Core or packaged-app acceptance` }, null, 2));
  console.log(JSON.stringify({ passed, locale, evidence: scratch, checks, errors }));
}
