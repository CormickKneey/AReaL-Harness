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
    const project = { id: 'startup-fixture', root: '/isolated/workspace', state: null, error: null, models: [{ modelId: 'default', isDefault: true }], profiles: [], pending: [], summaries: [], configurations: {}, outcomes: {}, core: {} };
    const snapshot = { revision: 1, projects: [project], connection: { state: 'ready' }, library: { projects: {}, threads: {}, settings: {}, projectOrder: [] } };
    let listener, releaseConnect, releaseStop;
    let startupConnectPending = true;
    let stopOutcome = 'cancel';
    const publish = () => { snapshot.revision++; listener(structuredClone(snapshot)); };
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
    window.updateBackend = ({ connection = { state: 'ready' }, backendUpdate, currentCommands = true }) => {
      snapshot.connection = connection;
      snapshot.backendUpdate = backendUpdate;
      snapshot.desktopCapabilities = project.desktopCapabilities = { currentCommands };
      publish();
    };
    window.setStopOutcome = outcome => { stopOutcome = outcome; };
    window.finishStop = () => releaseStop();
    window.arealDesktop = {
      snapshot: async () => structuredClone(snapshot),
      onState: callback => { listener = callback; return () => {}; },
      theme: async () => ({ platform: 'darwin', dark: true, id: 'dark' }),
      onTheme: () => () => {},
      onMcpAppEvent: () => () => {},
      presentReady: async () => {},
      preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === 'stopService') {
          if (stopOutcome === 'hold') return await new Promise(resolve => { releaseStop = () => resolve({ ok: true, value: { stopped: false } }); });
          if (stopOutcome === 'refuse') return { ok: false, error: { code: 'BUSY', message: '仍有其他窗口连接，无法更新后台。' } };
          if (stopOutcome === 'unknown') {
            snapshot.connection = { state: 'unavailable', recovery: 'check', message: '停止结果尚未确认，请检查后台。' };
            publish();
            return { ok: false, error: { code: 'UNKNOWN', message: '后台停止回执丢失，请检查后台状态。', submissionUnknown: true } };
          }
          return { ok: true, value: { stopped: stopOutcome === 'confirmed' } };
        }
        if (name === 'connectService') {
          if (snapshot.connection.recovery === 'check') return { ok: true, value: {} };
          snapshot.connection = { state: 'ready' };
          delete snapshot.backendUpdate;
          snapshot.desktopCapabilities = project.desktopCapabilities = { currentCommands: true };
          publish();
          return { ok: true, value: {} };
        }
        if (name === 'connect' && startupConnectPending) return await new Promise(resolve => {
          releaseConnect = () => { startupConnectPending = false; resolve({ ok: true, value: {} }); };
        });
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

  const backendStatus = page.locator('#backend-status');
  const update = page.getByRole('button', { name: '更新后台…', exact: true });
  const serviceCalls = () => page.evaluate(() => window.calls.filter(call => ['stopService', 'connectService', 'connect', 'open'].includes(call.name)).map(call => call.name));
  const setBackend = state => page.evaluate(value => window.updateBackend(value), state);
  await setBackend({ currentCommands: false, backendUpdate: { state: 'pending' } });
  await update.waitFor();
  assert.equal(await backendStatus.count(), 1);
  assert.equal(await backendStatus.getAttribute('role'), 'status');
  assert.equal(await page.getByText('更新后台后可发送消息。草稿已保留，现有任务可继续管理。', { exact: true }).count(), 1);
  assert.equal(await page.getByText(/当前后台版本不支持 MCP 应用和表单/).count(), 0);
  assert.equal(await page.locator('.composer-dock .notice').filter({ hasText: /升级后台|更新后台/ }).count(), 0);
  assert.equal(await page.getByTestId('chat-send-button').isDisabled(), true);
  assert.equal(await page.getByTestId('chat-input').getAttribute('contenteditable'), 'true');
  await page.getByTestId('chat-input').fill('BACKEND_UPDATE_DRAFT_PRESERVED');
  checks.push('one global compatibility notice keeps ordinary chat editable without an MCP warning');

  let before = await serviceCalls();
  await update.click();
  await page.waitForFunction(() => !document.querySelector('#backend-status button')?.disabled);
  assert.deepEqual(await serviceCalls(), [...before, 'stopService']);
  assert.match(await page.getByTestId('chat-input').innerText(), /BACKEND_UPDATE_DRAFT_PRESERVED/);
  checks.push('cancelled update preserves the draft and never connects');

  await page.evaluate(() => window.setStopOutcome('hold'));
  before = await serviceCalls();
  await update.click();
  assert.equal(await backendStatus.getByRole('button').isDisabled(), true);
  await backendStatus.getByRole('button').evaluate(button => { button.click(); button.click(); });
  assert.deepEqual(await serviceCalls(), [...before, 'stopService']);
  await page.evaluate(() => window.finishStop());
  await update.waitFor();
  checks.push('an update in flight disables its action and only stops once');

  await page.evaluate(() => window.setStopOutcome('refuse'));
  before = await serviceCalls();
  await update.click();
  await backendStatus.getByText('仍有其他窗口连接，无法更新后台。', { exact: true }).waitFor();
  assert.deepEqual(await serviceCalls(), [...before, 'stopService']);
  assert.equal(await page.locator('.error-banner').filter({ hasText: '仍有其他窗口连接' }).count(), 0);
  checks.push('a refused update reports its actual failure locally without connecting');

  await setBackend({ currentCommands: true, backendUpdate: { state: 'pending' } });
  await backendStatus.getByText('后台有更新待应用。现有任务继续运行。', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-send-button').isDisabled(), false);
  await setBackend({ currentCommands: true, backendUpdate: { state: 'applying' } });
  await backendStatus.getByText('正在更新后台…', { exact: true }).waitFor();
  assert.equal(await backendStatus.getByRole('button').isDisabled(), true);
  await setBackend({ backendUpdate: { state: 'failed', message: '新后台启动失败，请检查配置。' } });
  await backendStatus.getByText('新后台启动失败，请检查配置。', { exact: true }).waitFor();
  assert.doesNotMatch(await backendStatus.innerText(), /旧后台仍|现有任务继续/);
  checks.push('compatible pending updates leave sending available; applying and failed states are truthful');

  await setBackend({ currentCommands: false, backendUpdate: { state: 'pending' } });
  await page.evaluate(() => window.setStopOutcome('unknown'));
  before = await serviceCalls();
  await update.click();
  const checkBackend = backendStatus.getByRole('button', { name: '检查后台', exact: true });
  await checkBackend.waitFor();
  assert.deepEqual(await serviceCalls(), [...before, 'stopService']);
  assert.equal(await update.count(), 0);
  assert.match(await backendStatus.innerText(), /后台停止回执丢失/);
  await checkBackend.click();
  await page.waitForFunction(() => !document.querySelector('#backend-status button')?.disabled);
  assert.deepEqual(await serviceCalls(), [...before, 'stopService', 'connectService']);
  assert.equal(await page.getByRole('button', { name: '检查后台', exact: true }).count(), 1);
  checks.push('UNKNOWN prioritizes authoritative recovery and only checks through connectService');

  const restorationConnects = await page.evaluate(() => window.calls.filter(call => call.name === 'connect').length);
  await setBackend({ currentCommands: false, backendUpdate: { state: 'pending' } });
  await page.waitForFunction(previous => window.calls.filter(call => call.name === 'connect').length === previous + 1
    && document.querySelector('[data-testid="areal-workbench"]')?.getAttribute('data-startup-ready') === 'true', restorationConnects);
  await page.evaluate(() => window.setStopOutcome('confirmed'));
  before = await serviceCalls();
  await update.click();
  await backendStatus.waitFor({ state: 'detached' });
  assert.deepEqual(await serviceCalls(), [...before, 'stopService', 'connectService']);
  assert.equal(await page.getByTestId('chat-send-button').isDisabled(), false);
  assert.match(await page.getByTestId('chat-input').innerText(), /BACKEND_UPDATE_DRAFT_PRESERVED/);
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => ['send', 'create', 'enqueue', 'steer'].includes(call.name))), []);
  checks.push('confirmed stop connects once, clears the notice, and preserves the unsent draft');
  await setBackend({ connection: { state: 'ready', message: 'STALE_DEPLOYMENT_MESSAGE' } });
  assert.equal(await backendStatus.count(), 0);
  checks.push('a current deployment stays quiet instead of displaying a legacy ready message');
  await page.screenshot({ path: join(scratch, 'backend-current.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, scope: 'built renderer in Chrome with controlled Desktop contract snapshots' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
