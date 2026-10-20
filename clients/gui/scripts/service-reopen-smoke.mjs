import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { applicationFixture } from './application-fixture.mjs';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary?.startsWith(join(root, '.local/dev-bin/')), 'Use a private fixed Core slot');
assert.ok(!process.env.AREAL_REOPEN_LEGACY, 'Detached legacy migration requires the explicit legacy recovery runner');
const replacement = process.env.AREAL_REOPEN_REPLACEMENT_BIN;
const originalStat = await lstat(binary), originalHash = createHash('sha256').update(await readFile(binary)).digest('hex');
assert.ok(originalStat.isFile() && originalStat.nlink === 1 && await realpath(binary) === binary, 'The private fixed binary must be a regular copy');
if (replacement) {
  assert.notEqual(await realpath(replacement), binary);
  assert.match(execFileSync('file', ['-b', replacement], { encoding: 'utf8' }), /Mach-O.*executable/);
  assert.notEqual(createHash('sha256').update(await readFile(replacement)).digest('hex'), originalHash);
}
const force = process.env.AREAL_REOPEN_FORCE_GUI === '1';
const scratch = await mkdtemp('/private/tmp/ar-'), workspace = join(scratch, 'workspace'), config = join(scratch, 'config.toml');
await mkdir(workspace); await mkdir(join(scratch, 'user/.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
const requests = [], held = new Set(), checks = [], errors = [], generations = [];
checks.push = (...items) => { console.log('CHECK', ...items); return Array.prototype.push.apply(checks, items); };
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk; requests.push(JSON.parse(raw));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = requests.length === 1 ? 'COMPLETED_HISTORY' : 'REOPEN_HELD';
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    if (requests.length === 1) response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    else { held.add(response); response.on('close', () => held.delete(response)); }
  } catch (error) { errors.push(error.stack); response.destroy(); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await writeFile(config, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
Object.assign(env, { AREAL_CORE_BIN: binary, AREAL_CORE_CONFIG: config, AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_HOME: join(scratch, 'core'), AREAL_CORE_USER_HOME: join(scratch, 'user'), AREAL_HARNESS_SERVICE_HOME: join(scratch, 'registry') });
const application = await applicationFixture(gui, join(scratch, 'app'));
const backup = replacement ? join(dirname(binary), `.reopen-original-${process.pid}`) : null;
const staged = join(dirname(binary), `.reopen-staged-${process.pid}`);
if (backup) await copyFile(binary, backup);
const restoreBinary = async () => {
  if (backup && createHash('sha256').update(await readFile(binary)).digest('hex') !== originalHash) {
    assert.equal(createHash('sha256').update(await readFile(backup)).digest('hex'), originalHash);
    await copyFile(backup, staged); await chmod(staged, originalStat.mode & 0o777); await rename(staged, binary);
  }
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), originalHash);
  await utimes(binary, originalStat.atime, originalStat.mtime);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, label, ms = 90000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(100); } throw new Error(`Timeout: ${label}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const records = async () => {
  let names; try { names = await readdir(join(scratch, 'registry/services')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await Promise.all(names.map(name => readFile(join(scratch, 'registry/services', name, 'service.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; })))).filter(Boolean);
};
const metadata = () => readFile(join(scratch, 'core/service.json'), 'utf8').then(JSON.parse);
let app, page, processHandle, originalMetadata, projectId, threadId, passed = false;
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const thread = snapshot => snapshot.projects.find(project => project.id === projectId)?.state?.threads[threadId];
const launch = async () => {
  app = await electron.launch({ executablePath: require('electron'), args: [application.path], env, timeout: 120000 }); processHandle = app.process();
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.stack));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 }); await until(async () => (await state()).connection?.state === 'ready', 'application ready');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => ({ response: ['确认取消后台任务？', '退出 AReaL Harness？'].includes(args.at(-1).message) ? 1 : args.at(-1).cancelId ?? 0 }); });
};
const stop = async () => {
  if (!app) return;
  await app.evaluate(({ app }) => app.quit());
  await until(() => processHandle.exitCode !== null || processHandle.signalCode !== null, 'application exit'); app = null;
};
const quiescent = async () => {
  await until(async () => (await records()).every(service => !alive(service.hostPid) && !alive(service.corePid)), 'old engine processes exit');
  if (originalMetadata) await until(() => !alive(originalMetadata.pid), 'old Desktop exits');
};
const sourcePaths = ['app/src/core/main.cjs', 'app/src/core/service-main.cjs', 'app/src/core/service-client.cjs', 'app/src/core/backend.cjs', 'scripts/service-reopen-smoke.mjs', 'renderer/dist/index.html'];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(join(gui, path))).digest('hex')])));
const sourceHash = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).digest('hex');
console.log('Service reopen evidence:', scratch);
try {
  await launch();
  await app.evaluate(({ dialog }, workspace) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] }); }, workspace);
  await page.locator('.composer-project').click();
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).click();
  projectId = (await until(async () => (await state()).projects.find(project => project.root === workspace && project.state?.connected), 'project ready')).id;
  await page.getByTestId('chat-input').fill('complete history'); await page.getByRole('button', { name: '发送', exact: true }).click();
  threadId = await until(() => page.getByTestId('areal-workbench').getAttribute('data-thread-id'), 'thread created');
  await until(async () => thread(await state())?.turns.at(-1)?.status === 'completed', 'first turn completes');
  await page.getByTestId('chat-input').fill('hold reopen'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => held.size === 1, 'held second turn');
  const originalThread = structuredClone(thread(await state())); originalMetadata = await metadata();
  const original = await records(); generations.push(original);
  const draft = 'PRESERVED_REOPEN_DRAFT'; await page.getByTestId('chat-input').fill(draft); await sleep(300);
  if (replacement) { await copyFile(replacement, staged); await chmod(staged, originalStat.mode & 0o777); await rename(staged, binary); }
  else await utimes(binary, originalStat.atime, new Date(originalStat.mtimeMs + 10000));
  for (let index = 0; index < 2; index++) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await app.evaluate(({ app }) => app.emit('activate'));
    await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'window shown');
    assert.equal((await metadata()).applicationOwner.appRunId, originalMetadata.applicationOwner.appRunId);
    assert.deepEqual((await records()).map(service => service.generation), original.map(service => service.generation));
    assert.equal(await page.getByTestId('chat-input').innerText(), draft); assert.equal(requests.length, 2); assert.equal(held.size, 1);
    assert.equal(thread(await state()).turns.at(-1).id, originalThread.turns.at(-1).id);
  }
  await restoreBinary();
  checks.push(replacement ? 'different Mach-O bytes at the private path do not replace the running engine during window reopen' : 'changed binary timestamp does not replace the running engine during window reopen');
  checks.push('two window closes and reopens preserve application owner, engine generations, active turn and draft without replay');
  if (force) { processHandle.kill('SIGKILL'); await until(() => !alive(processHandle.pid), 'forced Main exit'); app = null; }
  else await stop();
  await quiescent();
  assert.equal(held.size, 0); checks.push(`${force ? 'forced' : 'normal'} application exit ends the owned model connection and releases engines`);
  await launch(); await until(async () => (await state()).projects.find(project => project.id === projectId)?.state?.connected, 'original workspace restored');
  const restored = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.command('open', { projectId, threadId }), { projectId, threadId }); assert.equal(restored.ok, true, JSON.stringify(restored));
  await until(async () => thread(await state())?.turns.length === originalThread.turns.length, 'history restored');
  const current = await records(); generations.push(current);
  assert.notEqual((await metadata()).applicationOwner.appRunId, originalMetadata.applicationOwner.appRunId);
  for (const after of current.filter(service => service.state === 'ready')) {
    const before = original.find(service => service.serviceId === after.serviceId);
    assert.notEqual(after.generation, before?.generation);
    assert.equal(after.owner.appRunId, (await metadata()).applicationOwner.appRunId);
  }
  assert.ok(current.some(service => service.workspace === workspace && service.state === 'ready'));
  assert.ok(current.filter(service => service.state === 'stopped').every(service => !alive(service.hostPid) && !alive(service.corePid)));
  assert.deepEqual(thread(await state()).turns.map(turn => turn.id), originalThread.turns.map(turn => turn.id));
  assert.equal(thread(await state()).turns[0].status, 'completed');
  assert.notEqual(thread(await state()).turns.at(-1).status, 'inProgress');
  assert.equal(await page.getByTestId('chat-input').innerText(), draft); assert.equal(requests.length, 2);
  checks.push('application restart creates a new owner and engine generation, retains history and unsent draft, and never replays interrupted input');
  await stop(); await quiescent(); passed = true;
} catch (error) { errors.push(error.stack); if (page && app) await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {}); }
finally {
  if (app && alive(processHandle.pid)) await app.evaluate(({ app }) => app.exit(1)).catch(() => processHandle.kill('SIGKILL'));
  await application.close();
  await restoreBinary().catch(error => errors.push(`binary restore: ${error.stack}`));
  await rm(staged, { force: true });
  if (backup) await rm(backup, { force: true });
  await quiescent().catch(error => errors.push(`cleanup: ${error.stack}`));
  for (const response of held) response.destroy(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  for (const [path, hash] of Object.entries(sourceHashes)) if (createHash('sha256').update(await readFile(join(gui, path))).digest('hex') !== hash) errors.push(`source changed during test: ${path}`);
  passed = passed && errors.length === 0;
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, errors, force, generations, sourceHash, sourceHashes, binary, replacement, originalHash, requests: requests.length, scope: 'isolated source Electron/Main/Desktop/Core/Runtime; local model; native dialog/picker responses injected; no installed package' }, null, 2));
}
assert.ok(passed, errors.join('\n')); console.log('PASS', checks);
