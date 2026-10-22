import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { chromium } = require('playwright-core');
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
let browser, passed = false;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
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
    window.setDeferredType = type => { thread.turns[0].items[1].originalType = type; publish(); };
    window.completeItem = () => { thread.turns.at(-1).items[1] = { id: 'huge', type: 'agentMessage', phase: 'final_answer', text: 'COMPLETE_UNICODE_雪🙂_SENTINEL' }; publish(); completeLoad?.({ ok: true, value: { loaded: true, itemId: 'huge' } }); };
    window.arealDesktop = {
      snapshot: async () => structuredClone(snapshot), onProjection: callback => { projectionListener = callback; listener = value => callback({ frame: { projection: 1, stream: 'history-fixture', sequence: ++sequence, kind: 'full', snapshot: value } }); return () => {}; },
      requestProjection: requestId => projectionListener({ requestId, frame: { projection: 1, stream: 'history-fixture', sequence: ++sequence, kind: 'full', snapshot: structuredClone(snapshot) } }),
      theme: async () => ({ platform: 'darwin', dark: false, id: 'light' }), onTheme: () => () => {}, onMcpAppEvent: () => () => {}, presentReady: async () => {}, preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
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
  passed = true;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  const hashes = Object.fromEntries(await Promise.all(['Messages.tsx', 'ConversationHistory.tsx', 'conversationPresentation.ts', 'i18n/messages/common.ts'].map(async file => [file, createHash('sha256').update(await readFile(join(gui, 'renderer/src', file))).digest('hex')])));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, locale, checks, errors, hashes, scope: 'built production Renderer in Chrome with controlled Desktop history responses; no actual Core or Electron acceptance' }, null, 2));
  console.log(JSON.stringify({ passed, locale, evidence: scratch, checks, errors }));
}
