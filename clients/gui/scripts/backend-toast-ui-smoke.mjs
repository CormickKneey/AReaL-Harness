import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const gui = resolve(import.meta.dirname, '..');
const require = createRequire(join(gui, 'app/package.json'));
const { chromium } = require('playwright-core');
const dist = process.env.AREAL_RENDERER_DIST || join(gui, 'renderer/dist');
const scratch = await mkdtemp('/private/tmp/areal-backend-toast-');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    const path = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error('Invalid asset path');
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page, passed = false;
const checks = [], errors = [];
const check = (value, message) => { assert.ok(value, message); checks.push(message); };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1360, height: 960 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const threadId = 'paused-thread';
    const thread = { id: threadId, cwd: '/isolated/workspace', status: 'idle', turns: [{ id: 'paused-turn', status: 'interrupted', items: [{ id: 'reply', type: 'agentMessage', phase: 'final_answer', text: 'PAUSED_HISTORY_SENTINEL' }] }] };
    const project = { id: 'toast-fixture', root: '/isolated/workspace', state: { connected: true, threads: { [threadId]: thread }, queues: {}, interactions: {} }, error: null, models: [], profiles: [], pending: [], summaries: [{ id: threadId, name: 'Keep streaming until I pause.', status: 'idle' }], configurations: {}, outcomes: {}, core: {}, desktopCapabilities: { currentCommands: true } };
    const snapshot = { revision: 1, projects: [project], connection: { state: 'ready' }, desktopCapabilities: { currentCommands: true }, library: { projects: {}, threads: {}, settings: {}, projectOrder: [] } };
    let projectionListener, sequence = 0;
    const publish = () => { snapshot.revision++; projectionListener?.({ frame: { projection: 1, stream: 'toast-fixture', sequence: ++sequence, kind: 'full', snapshot: structuredClone(snapshot) } }); };
    window.calls = [];
    window.setBackendState = patch => { Object.assign(snapshot, patch); if (patch.desktopCapabilities) project.desktopCapabilities = patch.desktopCapabilities; publish(); };
    window.currentBackendState = () => structuredClone(snapshot);
    window.repeatBackendState = publish;
    window.ordinaryToast = message => document.dispatchEvent(new CustomEvent('areal:toast', { detail: message }));
    localStorage.setItem('areal-gui:project', project.id);
    localStorage.setItem(`areal-gui:thread:${project.id}`, threadId);
    window.arealDesktop = {
      snapshot: async () => structuredClone(snapshot),
      onProjection: callback => { projectionListener = callback; return () => {}; },
      requestProjection: requestId => projectionListener({ requestId, frame: { projection: 1, stream: 'toast-fixture', sequence: ++sequence, kind: 'full', snapshot: structuredClone(snapshot) } }),
      theme: async () => ({ platform: 'darwin', dark: false, id: 'light' }), onTheme: () => () => {}, onMcpAppEvent: () => () => {}, presentReady: async () => {}, preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === 'workspace') return { ok: true, value: { git: true, branch: 'main' } };
        if (name === 'trajectory') return { ok: true, value: { enabled: false, state: 'disabled', queue: {}, records: [] } };
        if (name === 'serviceStatus') return { ok: true, value: { connected: true, clients: 1, busy: false, activeCommands: 0, starting: 0, projects: [] } };
        return { ok: true, value: { data: [] } };
      },
    };
  });
  await page.goto(origin);
  const input = page.getByTestId('chat-input');
  await input.waitFor();
  await input.fill('DRAFT_PRESERVED_SENTINEL');
  await page.clock.install();
  const before = await input.boundingBox();
  await page.screenshot({ path: join(scratch, '01-before.png'), animations: 'disabled' });
  const lifecycle = { supported: true, operations: [], requestId: 'request-a', kind: 'quitInterface', phase: 'settlementIncomplete', error: 'TECHNICAL_LIFECYCLE_FAILURE_SENTINEL', targets: [{ projectId: 'toast-fixture', phase: 'admissionUnconfirmed' }] };
  await page.evaluate(lifecycle => window.setBackendState({ lifecycle }), lifecycle);
  const toast = page.locator('[data-testid="toast"]');
  await toast.waitFor({ timeout: 5000 });
  check(await toast.getByRole('button').count() === 0, 'Backend notification contains no ineffective action or details buttons.');
  check(await toast.getAttribute('role') === 'status', 'The transient notification uses a polite status announcement.');
  check(!(await toast.innerText()).includes('TECHNICAL_'), 'Technical diagnostics stay out of the short notification.');
  check(await page.locator('#backend-status').count() === 0, 'The persistent backend card is removed from the conversation.');
  const box = await toast.boundingBox();
  check(Math.abs(box.x + box.width / 2 - 680) < 3 && box.y > 20 && box.y < 100, 'The bubble appears at the top center of the window.');
  check(JSON.stringify(await input.boundingBox()) === JSON.stringify(before), 'The bubble does not move the composer.');
  await page.screenshot({ path: join(scratch, '02-backend-toast.png'), animations: 'disabled' });
  await page.clock.fastForward(4000);
  await page.evaluate(() => window.repeatBackendState());
  await page.clock.fastForward(1001);
  await toast.waitFor({ state: 'hidden' });
  check(await input.innerText() === 'DRAFT_PRESERVED_SENTINEL', 'The draft survives notification expiry.');
  await page.evaluate(() => window.repeatBackendState());
  await page.clock.fastForward(1000);
  check(await toast.count() === 0, 'Repeated snapshots neither renew nor reopen the same event.');
  check(await page.evaluate(() => window.currentBackendState().lifecycle.phase) === 'settlementIncomplete', 'Notification expiry preserves the unresolved lifecycle state.');
  check(await page.evaluate(() => window.calls.filter(call => call.name === 'serviceLifecycle' || call.name === 'send' || call.name === 'connectService').length) === 0, 'Showing or expiring a notification does not retry or replay operations.');
  await page.screenshot({ path: join(scratch, '03-after-expiry.png'), animations: 'disabled' });
  await page.evaluate(lifecycle => window.setBackendState({ lifecycle: { ...lifecycle, requestId: 'request-b' } }), lifecycle);
  await toast.waitFor();
  checks.push('A distinct request with the same failure produces a new notification.');
  await page.clock.fastForward(3000);
  await page.evaluate(() => window.ordinaryToast('COPIED_SUCCESS_SENTINEL'));
  await toast.filter({ hasText: 'COPIED_SUCCESS_SENTINEL' }).waitFor();
  await page.clock.fastForward(2001);
  check(await toast.count() === 1, 'An older notification timer cannot dismiss a newer message.');
  check(await page.locator('[data-testid="feedback-notice"]').filter({ hasText: 'COPIED_SUCCESS_SENTINEL' }).count() === 0, 'Ordinary success feedback no longer creates a persistent error card.');
  await page.clock.fastForward(3000);
  await toast.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.ordinaryToast('COPIED_SUCCESS_SENTINEL'));
  await toast.waitFor();
  checks.push('Repeating a user action can show the same success message again.');
  await page.clock.fastForward(5001);
  await toast.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.setBackendState({ lifecycle: null, desktopCapabilities: { currentCommands: false } }));
  await toast.waitFor();
  await page.clock.fastForward(5001);
  await toast.waitFor({ state: 'hidden' });
  const send = page.getByTestId('chat-send-button');
  check(await send.isDisabled(), 'An incompatible backend still blocks submission after the notification expires.');
  const description = await send.evaluate(element => (element.getAttribute('aria-describedby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' '));
  check(description.includes('更新') && description.includes('设置'), 'Ordinary send retains an accessible explanation and settings direction after toast expiry.');
  await send.locator('..').hover();
  await page.clock.runFor(800);
  await page.locator('[data-slot="tooltip-content"]').filter({ hasText: '更新' }).waitFor();
  checks.push('The disabled ordinary send explains the update requirement on hover.');
  await page.screenshot({ path: join(scratch, '04-disabled-send-hint.png'), animations: 'disabled' });
  await page.evaluate(lifecycle => window.setBackendState({ lifecycle, desktopCapabilities: { currentCommands: true } }), lifecycle);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '后台服务', exact: true }).click();
  const checkButton = page.getByRole('button', { name: '检查后台', exact: true });
  await checkButton.click();
  check(await page.evaluate(() => window.calls.filter(call => call.name === 'serviceLifecycle' && call.params.operation === 'check').length) === 1, 'Lifecycle inspection remains available in background-service settings as an explicit action.');
  check(await page.evaluate(() => window.calls.filter(call => call.name === 'serviceLifecycle' && ['update', 'recover'].includes(call.params.operation)).length) === 0, 'Inspecting an unresolved request never becomes update or recovery.');
  await page.screenshot({ path: join(scratch, '05-backend-settings.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed && page) {
    await page.screenshot({ path: join(scratch, 'failure.png'), animations: 'disabled' }).catch(() => {});
    await writeFile(join(scratch, 'failure.html'), await page.content()).catch(() => {});
  }
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gui, encoding: 'utf8' }).trim(), rendererEntrySHA256: createHash('sha256').update(await readFile(join(dist, 'index.html'))).digest('hex'), scriptSHA256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), scope: 'Built renderer in Chrome with controlled Desktop contract snapshots. No real-provider or packaged-app claim.' };
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, source }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
