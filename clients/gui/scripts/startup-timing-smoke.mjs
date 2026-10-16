import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(gui, '../..');
const require = createRequire(join(gui, 'app/package.json'));
const evidenceRoot = join(root, '.scratch/startup-connection-investigation');
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, 'cold-'));
const launchLog = join(evidence, 'playwright.log');
process.env.DEBUG = 'pw:browser';
process.env.DEBUG_COLORS = '0';
process.env.DEBUG_FILE = launchLog;
const { _electron: electron } = require('playwright-core');
const { ServiceConnection } = require('../app/src/core/service-client.cjs');
const scratch = await mkdtemp('/private/tmp/ast-');
const rounds = Number(process.env.AREAL_STARTUP_ROUNDS ?? 5);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const variants = [
  ...(process.env.AREAL_STARTUP_BASELINE_BIN ? [{ label: 'baseline', binary: process.env.AREAL_STARTUP_BASELINE_BIN }] : []),
  { label: process.env.AREAL_STARTUP_LABEL ?? 'current', binary: process.env.AREAL_CORE_BIN || join(root, '.local/dev-bin/areal') },
];
const modelRequests = [], samples = [], errors = [], cleanups = [];
const recordFields = new Set(['event', 'pid', 'runId', 'attempt', 'scope', 'kind', 'stage', 'previous', 'elapsedMs', 'outcome', 'at', 'projectId', 'connectionGeneration', 'coreGeneration', 'servicePid', 'errorCode']);
const upstream = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  modelRequests.push({ model: body.model, authorization: request.headers.authorization !== undefined });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'STARTUP_HISTORY_OK' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
let app, activeFixture, passed = false, failure = null;

async function until(predicate, label) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timeout: ${label}`);
}

async function launch(fixture, label) {
  const started = performance.now();
  app = await electron.launch({ executablePath: require('electron'), args: [join(gui, 'app')], env: fixture.env, timeout: 120000 });
  const pid = app.process().pid;
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push({ label, message: error.message }));
  await page.getByTestId('areal-workbench').waitFor({ timeout: 120000 });
  const snapshot = await until(async () => {
    const value = await page.evaluate(() => window.arealDesktop.snapshot());
    return value.connection?.state === 'ready' && value.projects[0]?.state?.connected && value.projects[0].summariesLoaded && value;
  }, `${label} project connected`);
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), `${label} visible`);
  const durationMs = Math.round(performance.now() - started);
  const project = snapshot.projects[0];
  assert.equal(project.models.length, 12, 'default alias, nine executable models, and two missing-credential models are retained');
  assert.equal(project.models.filter(model => model.available).length, 10);
  assert.deepEqual(project.models.filter(model => !model.available).map(model => model.modelId).sort(), ['missing-a', 'missing-b']);
  assert.equal(project.error, null);
  const mainLog = await until(async () => {
    const output = (await readFile(launchLog, 'utf8')).split('\n').filter(line => line.includes(`[pid=${pid}]`)).join('\n');
    return timingRecords(output).some(record => record.scope === 'gui.first_show' && record.kind === 'finish') && output;
  }, `${label} presentation log captured`);
  await writeFile(join(evidence, `${label}-main.log`), mainLog);
  return { page, project, durationMs };
}

async function stop(fixture, label) {
  if (app) { await app.close(); app = null; }
  let metadata;
  try { metadata = JSON.parse(await readFile(join(fixture.home, 'service.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const connection = new ServiceConnection();
  let targets = [];
  try {
    await connection.connect(metadata);
    const packet = await connection.request('hello', { protocol: metadata.protocol, identity: metadata.identity });
    for (const project of packet.snapshot.projects) {
      if (!project.core.instanceId) continue;
      const descriptor = JSON.parse(await readFile(join(fixture.registry, 'services', project.core.instanceId, 'service.json'), 'utf8'));
      targets.push({ serviceId: descriptor.serviceId, generation: descriptor.generation, hostPid: descriptor.hostPid, corePid: descriptor.corePid });
    }
    await connection.request('stopService', { protocol: metadata.protocol }, true);
  } finally { connection.close(); }
  for (const pid of [metadata.pid, ...targets.flatMap(target => [target.hostPid, target.corePid])].filter(Boolean)) {
    await until(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, `${label} process ${pid} exits`);
  }
  for (const target of targets) {
    const descriptor = JSON.parse(await readFile(join(fixture.registry, 'services', target.serviceId, 'service.json'), 'utf8'));
    assert.equal(descriptor.state, 'stopped');
  }
  cleanups.push({ label, desktopPid: metadata.pid, targets, stopped: true });
}

function timingRecords(text) {
  return text.split('\n').filter(line => line.includes('[startup] ')).map(line => {
    const record = JSON.parse(line.slice(line.indexOf('[startup] ') + '[startup] '.length));
    assert.equal(record.event, 'startup');
    assert.deepEqual(Object.keys(record).filter(key => !recordFields.has(key)), [], 'startup log fields exclude arbitrary payloads');
    assert.match(record.scope, /^[a-z_.]+$/);
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    if (record.previous) {
      assert.deepEqual(Object.keys(record.previous).sort(), ['durationMs', 'outcome', 'stage']);
      assert.ok(Number.isFinite(record.previous.durationMs) && record.previous.durationMs >= 0);
      assert.match(record.previous.stage, /^[a-z_]+$/);
    }
    return record;
  });
}

async function removeFixture(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeFixture(join(directory, entry.name));
  }
}

console.log(`Evidence: ${evidence}`);
try {
  for (const variant of variants) {
    const base = join(scratch, variant.label), home = join(base, 'core'), registry = join(base, 'registry');
    const workspace = join(base, 'workspace'), user = join(base, 'user');
    await mkdir(workspace, { recursive: true }); await mkdir(home); await mkdir(user);
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
    const config = join(base, 'config.toml');
    await writeFile(config, `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture-0"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${upstream.address().port}/v1/chat/completions"\nmodels=[${Array.from({ length: 9 }, (_, i) => `{id="fixture-${i}",enabled=true}`).join(',')}]\n[model.providers.missing]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${upstream.address().port}/v1/chat/completions"\napi_key_env="AREAL_STARTUP_MISSING_CREDENTIAL"\nmodels=[{id="missing-a",enabled=true},{id="missing-b",enabled=true}]\n`);
    const projectId = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
    await writeFile(join(home, 'projects.json'), JSON.stringify([{ id: projectId, root: workspace }]));
    const env = { ...process.env, AREAL_CORE_BIN: variant.binary, AREAL_GUI_USER_DATA: join(base, 'electron'), AREAL_CORE_HOME: home,
      AREAL_CORE_USER_HOME: user, AREAL_HARNESS_HOME: join(base, 'config-home'), AREAL_HARNESS_SERVICE_HOME: registry,
      AREAL_CORE_CONFIG: config };
    for (const key of ['AREAL_CORE_WORKSPACE', 'AREAL_HARNESS_CONFIG', 'AREAL_CORE_DESKTOP_CONFIG', 'AREAL_HARNESS_TOOL_EXTENSIONS', 'AREAL_STARTUP_MISSING_CREDENTIAL']) delete env[key];
    const fixture = { ...variant, home, registry, env, generation: null };
    const binaryDigests = {};
    for (const name of ['areal', 'areal-runtime', 'areal-runtime-fs']) {
      binaryDigests[name] = createHash('sha256').update(await readFile(join(dirname(variant.binary), name))).digest('hex');
    }
    fixture.binaryFingerprint = createHash('sha256').update(JSON.stringify(binaryDigests)).digest('hex');
    variants[variants.indexOf(variant)] = fixture;
    activeFixture = fixture;
    const { page } = await launch(fixture, `${variant.label}-seed`);
    await page.getByRole('button', { name: '新聊天', exact: true }).click();
    await page.getByTestId('chat-input').fill('Confirm startup and persist this conversation');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await until(async () => {
      const snapshot = await page.evaluate(() => window.arealDesktop.snapshot());
      return Object.values(snapshot.projects[0].state.threads).some(thread => thread.turns?.at(-1)?.status === 'completed');
    }, 'seed completed');
    assert.deepEqual(modelRequests.at(-1), { model: 'fixture-0', authorization: false });
    await stop(fixture, `${variant.label}-seed`);
  }
  const initialRequests = modelRequests.length;
  for (let round = 0; round < rounds; round++) for (const fixture of variants) {
    activeFixture = fixture;
    const label = `${fixture.label}-${round}`;
    const { page, project, durationMs } = await launch(fixture, label);
    assert.notEqual(project.core.connectionGeneration, undefined);
    const descriptor = JSON.parse(await readFile(join(fixture.registry, 'services', project.core.instanceId, 'service.json'), 'utf8'));
    const components = JSON.parse(await readFile(join(fixture.registry, 'services', project.core.instanceId, 'components.json'), 'utf8'));
    assert.equal(components.binaries, fixture.binaryFingerprint, 'service identity still hashes the complete Core and Runtime contents');
    assert.notEqual(descriptor.generation, fixture.generation, 'each sample uses a new Core generation');
    fixture.generation = descriptor.generation;
    await page.getByText('STARTUP_HISTORY_OK', { exact: true }).waitFor();
    await page.getByTestId('chat-input').fill(`Unsent draft ${round}`);
    assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isEnabled(), true);
    assert.equal(modelRequests.length, initialRequests, 'cold restart does not replay saved messages');
    const serviceLog = await readFile(join(fixture.home, 'service.log'), 'utf8');
    await writeFile(join(evidence, `${label}-service.log`), serviceLog);
    const metadata = JSON.parse(await readFile(join(fixture.home, 'service.json'), 'utf8'));
    const records = timingRecords(serviceLog).filter(record => record.pid === metadata.pid);
    const mainRecords = timingRecords(await readFile(join(evidence, `${label}-main.log`), 'utf8'));
    assert.ok(records.some(record => record.scope === 'core.connect' && record.kind === 'finish' && record.outcome === 'ok'), 'project connection records its completed timing');
    assert.ok(mainRecords.some(record => record.scope === 'service.initialize' && record.kind === 'finish' && record.outcome === 'ok'), 'GUI connection records its completed timing');
    assert.ok(mainRecords.some(record => record.scope === 'gui.startup' && record.kind === 'finish' && record.outcome === 'ok'), 'Main startup is captured before Electron launch completes');
    const stages = [...records, ...mainRecords].filter(record => record.previous).map(record => ({ scope: record.scope, ...record.previous }));
    if (round === 0 || round === rounds - 1) await page.screenshot({ path: join(evidence, `${label}.png`), animations: 'disabled' });
    samples.push({ label: fixture.label, round, durationMs, generation: descriptor.generation, models: project.models.length, restoredHistory: true, stages });
    console.log(JSON.stringify({ label: fixture.label, round, durationMs, stages: stages.filter(stage => stage.durationMs >= 500) }));
    await stop(fixture, label);
  }
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = { name: error.name, message: error.message };
  throw error;
} finally {
  let cleanupFailure = null;
  try { if (activeFixture) await stop(activeFixture, 'finally'); }
  catch (error) { passed = false; process.exitCode = 1; cleanupFailure = { name: error.name, message: error.message }; }
  {
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    const binaries = await Promise.all(variants.map(async variant => ({ label: variant.label, binary: variant.binary, sha256: createHash('sha256').update(await readFile(variant.binary)).digest('hex') })));
    if (passed) {
      try { await removeFixture(scratch); await rm(scratch, { recursive: true }); }
      catch (error) { passed = false; process.exitCode = 1; cleanupFailure = { name: error.name, message: error.message }; }
    }
    await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ passed, rounds, samples, modelRequests, errors, cleanups, cleanupFailure, failure, binaries, scratch,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      scope: 'Real source Electron/Core/Runtime, process-cold restart with retained synthetic history. OS and filesystem caches are not cleared. Local deterministic model; no user config or subscription credentials.',
    }, null, 2));
    console.log(JSON.stringify({ passed, evidence, samples: samples.map(({ stages, ...sample }) => sample) }));
  }
}
