import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real renderer in Chrome; controlled desktop snapshots keep startup pending
// until explicitly released. This does not claim Electron/Core acceptance.
const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { chromium } = require('playwright-core');
const dist = join(gui, 'renderer/dist');
const scratch = await mkdtemp('/private/tmp/areal-startup-connection-');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    const path = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error('Invalid asset path');
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
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
  await page.addInitScript(() => {
    const project = { id: 'startup-fixture', root: '/isolated/workspace', state: null, error: null, models: [{ modelId: 'default' }], profiles: [], pending: [], summaries: [], configurations: {}, outcomes: {}, core: {} };
    const snapshot = { revision: 1, projects: [project], connection: { state: 'ready' }, library: { projects: {}, threads: {}, settings: {}, projectOrder: [] } };
    let listener, releaseConnect;
    window.calls = [];
    localStorage.setItem('areal-gui:project', project.id);
    localStorage.setItem(`areal-gui:draft:${project.id}:new`, 'STARTUP_DRAFT_PRESERVED');
    window.updateProject = (state, error = null) => {
      project.state = state;
      project.error = error;
      snapshot.revision++;
      listener(structuredClone(snapshot));
    };
    window.finishStartup = () => releaseConnect();
    window.arealDesktop = {
      snapshot: async () => structuredClone(snapshot),
      onState: callback => { listener = callback; return () => {}; },
      theme: async () => ({ platform: 'darwin', dark: true, id: 'dark' }),
      onTheme: () => () => {},
      presentReady: async () => {},
      preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === 'connect') return await new Promise(resolve => { releaseConnect = () => resolve({ ok: true, value: {} }); });
        if (name === 'workspace') return { ok: true, value: { git: true, branch: 'main' } };
        if (name === 'trajectory') return { ok: true, value: { enabled: false, state: 'disabled', queue: {}, records: [] } };
        return { ok: true, value: { data: [] } };
      },
    };
  });
  await page.goto(origin);
  await page.getByTestId('chat-input').waitFor();
  await page.waitForFunction(() => window.calls.some(call => call.name === 'connect'));
  const warning = page.getByRole('alert').filter({ hasText: '连接不可用，输入已保留。' });
  const context = page.getByRole('group', { name: '工作区上下文', exact: true });
  const connectedState = { connected: true, threads: {}, interactions: {}, queues: {}, error: null };
  async function assertPending(label) {
    assert.equal(await warning.count(), 0, `${label}: startup must not show a failure alert`);
    assert.equal(await context.innerText(), '正在连接…');
    assert.equal(await page.getByTestId('chat-send-button').isDisabled(), true);
    assert.match(await page.getByTestId('chat-input').innerText(), /STARTUP_DRAFT_PRESERVED/);
    checks.push(label);
  }
  await assertPending('saved project with no Core snapshot');
  await page.screenshot({ path: join(scratch, 'connecting.png'), animations: 'disabled' });
  await page.evaluate(state => window.updateProject({ ...state, connected: false }), connectedState);
  await assertPending('Core initialization pending without an error');
  await page.evaluate(state => window.updateProject({ ...state, connected: false }, 'STARTUP_FAILURE'), connectedState);
  await warning.waitFor();
  assert.match(await warning.innerText(), /STARTUP_FAILURE/);
  assert.equal(await context.innerText(), '未连接');
  checks.push('actual startup failure remains visible');
  await page.screenshot({ path: join(scratch, 'failure.png'), animations: 'disabled' });
  await page.evaluate(state => window.updateProject({ ...state, connected: false, error: '连接中断，正在恢复任务状态' }), connectedState);
  await page.waitForFunction(() => document.querySelector('.composer-dock [role="alert"]')?.textContent.includes('连接中断，正在恢复任务状态'));
  checks.push('Core disconnect error remains visible during recovery');
  await page.evaluate(state => { window.updateProject(state); window.finishStartup(); }, connectedState);
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-send-button"]').disabled);
  await page.getByLabel('当前分支', { exact: true }).waitFor();
  assert.equal(await warning.count(), 0);
  assert.match(await page.getByTestId('chat-input').innerText(), /STARTUP_DRAFT_PRESERVED/);
  assert.equal(await page.evaluate(() => localStorage.getItem('areal-gui:draft:startup-fixture:new')), 'STARTUP_DRAFT_PRESERVED');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => ['send', 'create', 'enqueue', 'steer'].includes(call.name))), []);
  checks.push('recovery enables sending and preserves the draft without submitting it');
  await page.screenshot({ path: join(scratch, 'ready.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, scope: 'built renderer in Chrome with controlled Desktop contract snapshots' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
