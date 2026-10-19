import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const script = fileURLToPath(import.meta.url);
const gui = resolve(dirname(script), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const { _electron: electron } = require('playwright-core');
const { ServiceConnection } = require('../app/src/core/service-client.cjs');
const { DesktopLifecycle } = require('../app/src/core/lifecycle.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.ok(process.env.AREAL_CORE_BIN && isAbsolute(process.env.AREAL_CORE_BIN), 'AREAL_CORE_BIN must name a private absolute fixed slot');
const binary = resolve(process.env.AREAL_CORE_BIN);
const slots = join(root, '.local/dev-bin');
const slot = relative(slots, dirname(binary));
assert.ok(slot && slot !== '..' && !slot.startsWith(`..${sep}`) && !isAbsolute(slot), 'use .local/dev-bin/<task-slot>/areal, never the shared root or target binary');
assert.equal(basename(binary), 'areal');
assert.equal(await realpath(binary), binary, 'the private Core path must not traverse symlinks');
const originalStat = await lstat(binary);
assert.ok(originalStat.isFile() && originalStat.nlink === 1, 'Core must be a regular private copy, not a hard link');
const binarySha256 = sha(await readFile(binary));
const legacy = process.env.AREAL_REOPEN_LEGACY === '1';
const forceGui = process.env.AREAL_REOPEN_FORCE_GUI === '1';
const compatibilityAudit = process.env.AREAL_REOPEN_COMPAT_AUDIT === '1';
const legacyRef = process.env.AREAL_REOPEN_LEGACY_REF || 'ed43b272';
assert.ok(['ed43b272', '653c8156'].includes(legacyRef), 'use an audited historical Desktop revision');
const replacement = process.env.AREAL_REOPEN_REPLACEMENT_BIN;
assert.ok(!(legacy && replacement), 'run binary replacement and legacy-source migration separately');
const scenario = legacy ? 'legacy' : replacement ? 'replacement' : 'mtime';
let replacementSha256, replacementFormat;
if (replacement) {
  assert.ok(isAbsolute(replacement), 'AREAL_REOPEN_REPLACEMENT_BIN must be an absolute path');
  assert.notEqual(await realpath(replacement), binary, 'replacement must be another real binary');
  assert.ok((await lstat(replacement)).isFile(), 'replacement must be a regular binary file');
  replacementFormat = execFileSync('file', ['-b', replacement], { encoding: 'utf8' }).trim();
  assert.match(replacementFormat, /Mach-O.*executable/, 'replacement must be an actual Mach-O executable');
  replacementSha256 = sha(await readFile(replacement));
  assert.notEqual(replacementSha256, binarySha256, 'replacement must have different executable contents');
}
const components = Object.fromEntries(await Promise.all(['areal', 'areal-runtime', 'areal-runtime-fs'].map(async name =>
  [name, sha(await readFile(join(dirname(binary), name)))])));
const source = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
  diffSha256: sha(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })),
  scriptSha256: sha(await readFile(script)),
  rendererIndexSha256: sha(await readFile(join(gui, 'renderer/dist/index.html'))),
};
const scratch = await mkdtemp('/private/tmp/areal-service-reopen-');
const binaryBackup = replacement ? join(dirname(binary), `.reopen-original-${basename(scratch)}`) : null;
const binaryStage = join(dirname(binary), `.reopen-stage-${basename(scratch)}`);
const home = join(scratch, 'core'), workspace = join(scratch, 'workspace'), registry = join(scratch, 'registry');
const observations = {}, checks = [], errors = [], requests = [], held = new Set();
const cleanup = { guiClosed: false, serviceStopped: false, binaryContentsRestored: false, binaryTimestampRestored: false };
let app, page, projectId, threadId, turnId, legacyChild, passed = false, phase = 'setup';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
};
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = snapshot => snapshot.projects.find(value => value.id === projectId);
const turn = snapshot => project(snapshot)?.state?.threads[threadId]?.turns.at(-1);
const send = (response, content) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
const model = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests.length === 1) {
      send(response, 'LEGACY_COMPLETED_REPLY');
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    send(response, 'REOPEN_HELD');
    held.add(response);
    response.on('close', () => held.delete(response));
  } catch (error) { errors.push(`model fixture: ${error.stack}`); response.destroy(error); }
});
await mkdir(workspace);
await mkdir(join(scratch, 'user/.areal'), { recursive: true });
execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const config = join(scratch, 'config.toml');
await writeFile(config, `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`);
const env = { ...process.env, AREAL_CORE_BIN: binary, AREAL_CORE_CONFIG: config, AREAL_CORE_HOME: home,
  AREAL_GUI_USER_DATA: join(scratch, 'electron'), AREAL_CORE_USER_HOME: join(scratch, 'user'),
  AREAL_HARNESS_SERVICE_HOME: registry };
for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_HARNESS_HOME', 'AREAL_HARNESS_CONFIG', 'AREAL_CORE_DESKTOP_CONFIG',
  'AREAL_HARNESS_TOOL_EXTENSIONS', 'AREAL_CORE_SANDBOX_PROFILE', 'AREAL_CORE_WORKGROUP_POLICY', 'AREAL_CORE_WORKGROUP_TOOLCHAIN']) delete env[key];
const testApp = join(scratch, 'app');
const currentMain = join(gui, 'app/src/main.cjs');
let initialMain = currentMain;
if (legacy) {
  const legacyRoot = join(scratch, 'legacy-source');
  const archive = join(scratch, 'legacy-app.tar');
  const commit = execFileSync('git', ['rev-parse', legacyRef], { cwd: root, encoding: 'utf8' }).trim();
  await mkdir(legacyRoot);
  execFileSync('git', ['archive', '--format=tar', '--output', archive, commit, 'clients/gui/app', 'clients/gui/packages/workbench'], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', legacyRoot]);
  const legacyGui = join(legacyRoot, 'clients/gui');
  const legacyModules = join(legacyGui, 'app/node_modules');
  await mkdir(join(legacyModules, '@areal'), { recursive: true });
  for (const name of await readdir(join(gui, 'app/node_modules'))) {
    if (name === '@areal') continue;
    await symlink(join(gui, 'app/node_modules', name), join(legacyModules, name), 'dir');
  }
  for (const name of await readdir(join(gui, 'app/node_modules/@areal'))) {
    await symlink(name === 'workbench' ? join(legacyGui, 'packages/workbench') : join(gui, 'app/node_modules/@areal', name),
      join(legacyModules, '@areal', name), 'dir');
  }
  await symlink(join(gui, 'renderer'), join(legacyGui, 'renderer'), 'dir');
  initialMain = join(legacyGui, 'app/src/main.cjs');
  source.legacy = { commit, main: initialMain, archiveSha256: sha(await readFile(archive)),
    serviceConfigSha256: sha(await readFile(join(legacyGui, 'app/src/core/service-config.cjs'))),
    desktopContractSha256: sha(await readFile(join(legacyGui, 'packages/workbench/client/desktop-contract.cjs'))) };
}
await mkdir(testApp);
await writeFile(join(testApp, 'package.json'), JSON.stringify({ name: 'areal-service-reopen-fixture', main: 'bootstrap.cjs' }));
await writeFile(join(testApp, 'bootstrap.cjs'), `
const { dialog } = require('electron');
const { appendFileSync } = require('node:fs');
globalThis.__reopenDialogs = [];
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  const response = options.cancelId ?? 0;
  const entry = { phase: process.env.AREAL_REOPEN_PHASE, ...options, response, selectedButton: options.buttons?.[response] };
  globalThis.__reopenDialogs.push(entry);
  appendFileSync(${JSON.stringify(join(scratch, 'dialogs.jsonl'))}, JSON.stringify(entry) + '\\n');
  return { response };
};
require(process.env.AREAL_REOPEN_MAIN);
`);
const dialogs = async () => app.evaluate(() => globalThis.__reopenDialogs);
function checkDialogs(seen) {
  assert.deepEqual(seen, [], 'every GUI opening, including legacy migration, must enter the workspace without a recovery dialog');
}
async function launch(label) {
  phase = label;
  app = await electron.launch({ executablePath: process.env.AREAL_ELECTRON_EXECUTABLE || require('electron'), args: [testApp],
    env: { ...env, AREAL_REOPEN_PHASE: label, AREAL_REOPEN_MAIN: currentMain }, timeout: 120000 });
  observations[`${label}GuiPid`] = app.process().pid;
  app.process().stdout?.on('data', chunk => appendFileSync(join(scratch, `${label}-stdout.log`), chunk));
  app.process().stderr?.on('data', chunk => appendFileSync(join(scratch, `${label}-stderr.log`), chunk));
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(`${label}: ${error.stack}`));
  await page.waitForFunction(() => typeof window.arealDesktop?.snapshot === 'function');
  await until(async () => {
    const seen = await dialogs();
    checkDialogs(seen);
    return (await state()).connection?.state === 'ready';
  }, `${label} Desktop ready`);
  checkDialogs(await dialogs());
  await page.getByTestId('areal-workbench').waitFor();
}
async function closeGui({ force = forceGui } = {}) {
  if (!app) return;
  const pid = app.process().pid;
  if (force) app.process().kill('SIGKILL');
  else await app.close();
  app = null;
  await until(() => !alive(pid), 'owned GUI process exit', 15000);
}
async function inspectService() {
  const metadata = JSON.parse(await readFile(join(home, 'service.json'), 'utf8'));
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    const packet = await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
    if (!observations.feedbackStatus) {
      try {
        observations.feedbackStatus = { result: await connection.request('command', { name: 'feedback', request: { operation: 'status' } }) };
      } catch (error) {
        observations.feedbackStatus = { code: error.code ?? null, message: error.message };
      }
    }
    const descriptors = [];
    for (const name of await readdir(join(registry, 'services'))) {
      try { descriptors.push(JSON.parse(await readFile(join(registry, 'services', name, 'service.json'), 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const matching = descriptors.filter(value => value.workspace === workspace);
    assert.equal(matching.length, 1, 'exactly one Core service owns the fixture workspace');
    const descriptor = matching[0];
    assert.ok(descriptor.generation && descriptor.serviceId);
    assert.equal(alive(metadata.pid), true, 'original Desktop remains alive');
    return {
      desktop: { pid: metadata.pid, identity: metadata.identity },
      core: { serviceId: descriptor.serviceId, generation: descriptor.generation, hostPid: descriptor.hostPid, corePid: descriptor.corePid },
      turn: turn(packet.snapshot) ?? null,
      service: packet.service,
    };
  } finally { connection.close(); }
}
async function seedLegacyCommand(name, request) {
  const metadata = JSON.parse(await readFile(join(home, 'service.json'), 'utf8'));
  const connection = new ServiceConnection();
  try {
    await connection.connect(metadata);
    await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
    return await connection.request('command', { name, request }, true);
  } finally { connection.close(); }
}
console.log('Service reopen evidence:', scratch);
try {
  if (legacy) {
    legacyChild = spawn(process.env.AREAL_ELECTRON_EXECUTABLE || require('electron'), [testApp, '--areal-core-service'], {
      env: { ...env, AREAL_REOPEN_PHASE: 'legacy-service', AREAL_REOPEN_MAIN: initialMain },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    legacyChild.stdout.on('data', chunk => appendFileSync(join(scratch, 'legacy-service-stdout.log'), chunk));
    legacyChild.stderr.on('data', chunk => appendFileSync(join(scratch, 'legacy-service-stderr.log'), chunk));
    let launchError;
    legacyChild.once('error', error => { launchError = error; });
    await until(async () => {
      if (launchError) throw launchError;
      if (legacyChild.exitCode !== null) throw new Error(`legacy service exited ${legacyChild.exitCode}`);
      try { return JSON.parse(await readFile(join(home, 'service.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'historical Desktop ready before the current GUI attaches');
    observations.legacyServicePid = legacyChild.pid;
  }
  await launch('initial');
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  projectId = (await until(async () => (await state()).projects.find(value => value.root === workspace && value.state?.connected), 'connected isolated project')).id;
  if (legacy) {
    ({ threadId } = await seedLegacyCommand('create', { projectId }));
    await seedLegacyCommand('send', { projectId, threadId, text: 'Complete this ordinary turn before the held task.' });
    await page.evaluate(({ projectId, threadId }) => localStorage.setItem(`areal-gui:thread:${projectId}`, threadId), { projectId, threadId });
    await page.reload();
    await page.getByTestId('areal-workbench').waitFor();
  } else {
    await page.getByTestId('chat-input').fill('Complete this ordinary turn before the held task.');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    threadId = await until(() => page.getByTestId('areal-workbench').getAttribute('data-thread-id'), 'created Thread identity');
  }
  await until(async () => requests.length === 1 && turn(await state())?.status === 'completed', 'completed ordinary turn');
  await page.getByText('LEGACY_COMPLETED_REPLY', { exact: true }).waitFor();
  if (compatibilityAudit) {
    const completed = turn(await state());
    const item = completed.items.find(value => value.type === 'agentMessage' && value.phase === 'final_answer');
    observations.savedFeedbackKey = `areal-feedback:${JSON.stringify([projectId, threadId, completed.id, item.id])}`;
    await page.evaluate(key => localStorage.setItem(key, '00000000-0000-4000-8000-000000000001'), observations.savedFeedbackKey);
  }
  checks.push('completed ordinary response is visible before the held Turn starts');
  if (legacy) {
    await seedLegacyCommand('send', { projectId, threadId, text: 'Hold this task while I close and reopen the GUI.' });
  } else {
    await page.getByTestId('chat-input').fill('Hold this task while I close and reopen the GUI.');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    threadId = await until(() => page.getByTestId('areal-workbench').getAttribute('data-thread-id'), 'created Thread identity');
  }
  await until(async () => requests.length === 2 && turn(await state())?.status === 'inProgress'
    && turn(await state()).items.some(item => item.type === 'agentMessage' && item.text === 'REOPEN_HELD'), 'original held streaming turn');
  turnId = turn(await state()).id;
  observations.before = await inspectService();
  if (legacy) assert.equal(observations.feedbackStatus.code, 'INVALID_DESKTOP_REQUEST', 'legacy fixture rejects the unsupported feedback status command');
  assert.equal(held.size, 1);
  await page.screenshot({ path: join(scratch, '01-held-before-close.png') });
  await writeFile(join(scratch, 'before.json'), JSON.stringify(observations.before, null, 2));
  await closeGui();
  observations.closed = await inspectService();
  assert.deepEqual(observations.closed.desktop, observations.before.desktop);
  assert.deepEqual(observations.closed.core, observations.before.core);
  assert.equal(observations.closed.turn.id, turnId);
  assert.equal(observations.closed.turn.status, 'inProgress');
  checks.push('closing the owned GUI leaves the original Desktop/Core and streaming Turn running');

  phase = scenario;
  if (scenario === 'replacement') {
    await copyFile(binary, binaryBackup);
    await chmod(binaryBackup, originalStat.mode & 0o777);
    assert.equal(sha(await readFile(binaryBackup)), binarySha256, 'private same-directory backup retains the running executable');
    await copyFile(replacement, binaryStage);
    await chmod(binaryStage, originalStat.mode & 0o777);
    assert.equal(sha(await readFile(binaryStage)), replacementSha256, 'staged replacement matches the verified Mach-O source');
    await rename(binaryStage, binary);
    observations.binaryReplacement = { path: binary, source: replacement, format: replacementFormat, backup: binaryBackup,
      beforeSha256: binarySha256, afterSha256: sha(await readFile(binary)) };
    assert.equal(observations.binaryReplacement.afterSha256, replacementSha256, 'actual new binary occupies the original Core path');
    assert.notEqual(observations.binaryReplacement.afterSha256, binarySha256);
  } else if (scenario === 'mtime') {
    const changedMtime = new Date(originalStat.mtimeMs + 120000);
    await utimes(binary, originalStat.atime, changedMtime);
    observations.binaryMtime = { original: originalStat.mtimeMs, changed: (await stat(binary)).mtimeMs };
    assert.notEqual(observations.binaryMtime.changed, observations.binaryMtime.original);
    assert.equal(sha(await readFile(binary)), binarySha256, 'mtime trigger preserves deployed Core bytes');
  } else {
    assert.equal(sha(await readFile(binary)), binarySha256, 'legacy migration leaves the binary unchanged');
  }
  await launch('reopened');
  if (scenario === 'mtime') assert.equal((await state()).backendUpdate, undefined, 'timestamps alone do not request an update');
  else {
    await until(async () => (await state()).backendUpdate?.state === 'pending', 'explicit deployment update pending');
    await page.getByRole('button', { name: '更新后台…', exact: true }).waitFor();
  }
  await until(async () => project(await state())?.state?.connected && turn(await state())?.id === turnId, 'original Thread restored automatically');
  observations.after = await inspectService();
  assert.deepEqual(observations.after.desktop, observations.before.desktop, 'reopen must attach to the original Desktop');
  assert.deepEqual(observations.after.core, observations.before.core, 'reopen must keep the original Core generation');
  assert.equal(observations.after.turn.id, turnId);
  assert.equal(observations.after.turn.status, 'inProgress');
  assert.equal(requests.length, 2, 'reopen must not submit or replay a model request');
  assert.equal(held.size, 1, 'original model stream remains connected');
  for (const response of held) send(response, ' REOPEN_CONTINUED');
  await until(async () => turn(await state())?.items.some(item => item.type === 'agentMessage' && item.text === 'REOPEN_HELD REOPEN_CONTINUED'), 'original stream reaches reopened GUI');
  await page.getByText('REOPEN_HELD REOPEN_CONTINUED', { exact: true }).waitFor();
  assert.equal(turn(await state()).id, turnId);
  assert.equal(turn(await state()).status, 'inProgress');
  assert.equal(requests.length, 2);
  observations.continued = await inspectService();
  assert.deepEqual(observations.continued.desktop, observations.before.desktop);
  assert.deepEqual(observations.continued.core, observations.before.core);
  assert.equal(observations.continued.turn.id, turnId);
  assert.equal(observations.continued.turn.status, 'inProgress');
  assert.ok(observations.continued.turn.items.some(item => item.type === 'agentMessage' && item.text === 'REOPEN_HELD REOPEN_CONTINUED'),
    'authoritative original service receives the continuation from the original model stream');
  if (legacy) {
    observations.desktopCapabilities = (await state()).desktopCapabilities;
    assert.equal(observations.desktopCapabilities?.currentCommands, false, 'unadvertised legacy service cannot claim current command semantics');
    await page.getByTestId('chat-input').fill('LEGACY_DRAFT_RETAINED');
    assert.equal(await page.getByTestId('chat-input').isEditable(), true, 'legacy observation keeps draft editing available');
    assert.equal(await page.getByTestId('chat-send-button').isDisabled(), true, 'legacy GUI disables unsupported submission');
    const rejected = await page.evaluate(({ projectId, threadId }) => window.arealDesktop.command('send', { projectId, threadId, text: 'MUST_NOT_REACH_LEGACY_MODEL' }), { projectId, threadId });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'SERVICE_COMMAND_UNSUPPORTED');
    assert.equal(rejected.error.submissionUnknown, undefined, 'unsupported send is rejected before submission');
    assert.equal(requests.length, 2, 'rejected unsupported send never reaches the original model');
    assert.equal(await page.getByTestId('chat-input').innerText(), 'LEGACY_DRAFT_RETAINED', 'known rejection preserves the editable draft');
  }
  assert.equal(await page.getByRole('button', { name: '点赞', exact: true }).count(), 0, 'unavailable feedback keeps its entry hidden');
  observations.reopenErrors = await page.locator('.error-banner').allTextContents();
  if (compatibilityAudit) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: /数据飞轮/ }).click();
    observations.feedbackPreferenceDisabled = await page.getByRole('switch', { name: '显示点赞和点踩', exact: true }).isDisabled();
    observations.trajectoryToggleDisabled = await page.getByRole('switch', { name: '启用数据飞轮', exact: true }).isDisabled();
    observations.savedFeedbackRetained = await page.evaluate(key => localStorage.getItem(key) === '00000000-0000-4000-8000-000000000001', observations.savedFeedbackKey);
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    assert.equal(observations.feedbackPreferenceDisabled, true, 'unsupported Desktop feedback preference stays disabled');
    assert.equal(observations.trajectoryToggleDisabled, true, 'legacy trajectory status without a revision cannot toggle');
    assert.equal(observations.savedFeedbackRetained, true, 'unsupported feedback keeps the saved draft identity');
  }
  assert.deepEqual(observations.reopenErrors, [], 'reopened GUI must not show a global error banner for optional feedback status');
  observations.reopenDialogs = await dialogs();
  checkDialogs(observations.reopenDialogs);
  await page.screenshot({ path: join(scratch, '02-same-turn-after-reopen.png') });
  await writeFile(join(scratch, 'after.json'), JSON.stringify(observations.after, null, 2));

  phase = 'second-close';
  await closeGui();
  observations.secondClosed = await inspectService();
  assert.deepEqual(observations.secondClosed.desktop, observations.before.desktop);
  assert.deepEqual(observations.secondClosed.core, observations.before.core);
  assert.equal(observations.secondClosed.turn.id, turnId);
  assert.equal(observations.secondClosed.turn.status, 'inProgress');
  assert.equal(requests.length, 2, 'second GUI close must retain the original model request');
  assert.equal(held.size, 1, 'original model stream remains connected after the second GUI close');
  await launch('reopened-again');
  if (scenario === 'mtime') assert.equal((await state()).backendUpdate, undefined, 'timestamps alone do not request an update');
  else {
    await until(async () => (await state()).backendUpdate?.state === 'pending', 'explicit deployment update pending');
    await page.getByRole('button', { name: '更新后台…', exact: true }).waitFor();
  }
  await until(async () => project(await state())?.state?.connected && turn(await state())?.id === turnId,
    'original Thread restored automatically after the second reopen');
  if (legacy) assert.equal(await page.getByTestId('chat-input').innerText(), 'LEGACY_DRAFT_RETAINED', 'second reopen retains the draft without replay');
  observations.secondAfter = await inspectService();
  assert.deepEqual(observations.secondAfter.desktop, observations.before.desktop, 'second reopen must attach to the original Desktop');
  assert.deepEqual(observations.secondAfter.core, observations.before.core, 'second reopen must keep the original Core generation');
  assert.equal(observations.secondAfter.turn.id, turnId);
  assert.equal(observations.secondAfter.turn.status, 'inProgress');
  assert.equal(requests.length, 2, 'two reopens must not submit or replay a model request');
  assert.equal(held.size, 1, 'original model stream remains connected after two reopens');
  for (const response of held) send(response, ' SECOND_REOPEN_CONTINUED');
  await until(async () => turn(await state())?.items.some(item => item.type === 'agentMessage'
    && item.text === 'REOPEN_HELD REOPEN_CONTINUED SECOND_REOPEN_CONTINUED'), 'original stream reaches the GUI after the second reopen');
  await page.getByText('REOPEN_HELD REOPEN_CONTINUED SECOND_REOPEN_CONTINUED', { exact: true }).waitFor();
  assert.equal(turn(await state()).id, turnId);
  assert.equal(turn(await state()).status, 'inProgress');
  assert.equal(requests.length, 2);
  observations.secondContinued = await inspectService();
  assert.deepEqual(observations.secondContinued.desktop, observations.before.desktop);
  assert.deepEqual(observations.secondContinued.core, observations.before.core);
  assert.equal(observations.secondContinued.turn.id, turnId);
  assert.equal(observations.secondContinued.turn.status, 'inProgress');
  assert.ok(observations.secondContinued.turn.items.some(item => item.type === 'agentMessage'
    && item.text === 'REOPEN_HELD REOPEN_CONTINUED SECOND_REOPEN_CONTINUED'),
    'authoritative original service receives the continuation after the second reopen from the original model stream');
  if (legacy) await page.waitForTimeout(16000);
  observations.secondReopenErrors = await page.locator('.error-banner').allTextContents();
  assert.deepEqual(observations.secondReopenErrors, [], 'second reopened GUI must not show a global error banner for optional feedback status');
  observations.secondReopenDialogs = await dialogs();
  checkDialogs(observations.secondReopenDialogs);
  await page.screenshot({ path: join(scratch, '03-same-turn-after-second-reopen.png') });
  await writeFile(join(scratch, 'after-second-reopen.json'), JSON.stringify(observations.secondContinued, null, 2));
  checks.push(scenario === 'legacy'
    ? 'genuine pre-fix Desktop source permits two automatic reopens without a dialog and keeps the same Desktop PID, Core generation and active Turn'
    : scenario === 'replacement'
      ? 'actual different Mach-O bytes at the same Core path permit two automatic reopens with the same Desktop PID, Core generation and active Turn'
      : 'changed deployment timestamp permits two automatic reopens with the same Desktop PID, Core generation and active Turn');
  checks.push('the original model stream continues into both reopened GUIs without cancellation, restart or replay');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(`${phase}: ${error.stack}`);
  if (page) {
    await writeFile(join(scratch, 'failure-state.json'), JSON.stringify(await state().catch(() => null), null, 2));
    await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
    await writeFile(join(scratch, 'failure.aria.txt'), await page.locator('body').ariaSnapshot().catch(() => 'unavailable'));
  }
  if (app) observations.failureDialogs = await dialogs().catch(() => []);
  observations.failureService = await inspectService().catch(error => ({ error: error.message }));
} finally {
  await closeGui({ force: false }).then(() => { cleanup.guiClosed = true; }).catch(error => errors.push(`GUI cleanup: ${error.stack}`));
  const connection = new ServiceConnection();
  try {
    const metadata = JSON.parse(await readFile(join(home, 'service.json'), 'utf8'));
    await connection.connect(metadata);
    await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
    const lifecycle = new DesktopLifecycle({ connection, metadata, home, notify: async () => ({ response: 1 }) });
    await until(async () => !(await lifecycle.observe()).blockers.length, 'owned service cleanup admission');
    const result = await lifecycle.stop({ mode: 'cancel' });
    assert.equal(result.kind, 'exited');
    if (legacyChild) await until(() => !alive(legacyChild.pid), 'owned historical Desktop process exit', 15000);
    cleanup.serviceStopped = true;
  } catch (error) {
    if (error.code === 'ENOENT') cleanup.serviceStopped = true;
    else errors.push(`service cleanup: ${error.stack}`);
  } finally { connection.close(); }
  for (const response of held) response.destroy();
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  try {
    if (sha(await readFile(binary)) !== binarySha256) {
      assert.ok(binaryBackup, 'only the replacement scenario may change private Core contents');
      assert.equal(sha(await readFile(binaryBackup)), binarySha256, 'restore only the verified original binary');
      await copyFile(binaryBackup, binaryStage);
      await chmod(binaryStage, originalStat.mode & 0o777);
      await rename(binaryStage, binary);
    }
    assert.equal(sha(await readFile(binary)), binarySha256, 'private Core original contents are restored');
    if (replacement) assert.equal(sha(await readFile(replacement)), replacementSha256, 'shared replacement source remains unchanged');
    cleanup.binaryContentsRestored = true;
    await utimes(binary, originalStat.atime, originalStat.mtime);
    const restoredStat = await stat(binary);
    assert.ok(Math.abs(restoredStat.atimeMs - originalStat.atimeMs) < 1, 'restore original access timestamp');
    assert.ok(Math.abs(restoredStat.mtimeMs - originalStat.mtimeMs) < 1, 'restore original modification timestamp');
    cleanup.binaryTimestampRestored = true;
  } catch (error) { errors.push(`binary cleanup: ${error.stack}`); }
  await rm(binaryStage, { force: true }).catch(error => errors.push(`binary staging cleanup: ${error.stack}`));
  passed = passed && errors.length === 0 && Object.values(cleanup).every(Boolean);
  if (!passed) process.exitCode = 1;
  await writeFile(join(scratch, 'model-requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, scenario, checks, errors, cleanup, observations,
    source, forceGui, binary, binarySha256, components, replacement: replacement ? { path: replacement, sha256: replacementSha256, format: replacementFormat, backup: binaryBackup } : null,
    paths: { home, workspace, registry, userData: env.AREAL_GUI_USER_DATA, initialMain, currentMain },
    identities: { projectId, threadId, turnId }, modelRequestCount: requests.length,
    boundary: 'real isolated Electron/Main/preload/Desktop/Core; local held SSE model; native picker and messageBox responses injected; no real provider or installed package' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors, cleanup }));
}
