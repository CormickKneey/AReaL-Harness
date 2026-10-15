import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(gui, 'app/package.json'));
const { CoreBackend } = require('../app/src/core/backend.cjs');
const { DesktopService } = require('../app/src/core/service-protocol.cjs');
const { ServiceConnection } = require('../app/src/core/service-client.cjs');
const { recoverStartupService } = require('../app/src/core/startup-recovery.cjs');
const { restoreLegacySchedules } = require('../app/src/core/legacy-service-cancel.cjs');
const scratch = await mkdtemp('/private/tmp/areal-startup-recovery-');
const binary = process.env.AREAL_CORE_BIN || resolve(gui, '../../target/debug/areal');
const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
const checks = [], dialogs = [];
let backend, service, passed = false;
const options = { binary, home: join(scratch, 'core'), harnessHome: join(scratch, 'registry'), userHome: join(scratch, 'user') };
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
await mkdir(join(options.userHome, '.areal'), { recursive: true });
await writeFile(join(options.userHome, '.areal/config.toml'), 'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:9/v1/chat/completions"\n');
try {
  // Real Core/Runtime, public CLI lifecycle, and persisted scheduled task.
  backend = new CoreBackend(options);
  await backend.init();
  const projectId = await backend.addProject(workspace);
  const scheduled = await backend.command('manage', { projectId, operation: 'taskCreate', mode: 'scheduled', objective: 'Future startup fixture', interactionMode: 'interactive', schedule: { at: Math.floor(Date.now() / 1000) + 3600, timeZone: 'Asia/Shanghai' } });
  const project = backend.projects.get(projectId);
  const generation = project.service.generation;
  const status = await project.client.request('areal/server/status');
  assert.equal(status.restartSafe, true);
  assert.equal(status.activeTasks, 0, 'an idle future schedule must not count as live work');
  service = new DesktopService(backend, 'fixture-current');
  const resources = require('../app/src/core/resource-recovery.cjs');
  const inspected = await resources.inspectResources(backend, { includeTasks: true });
  assert.equal(inspected[0].restartSafe, true);
  await service.stop();
  service.close(); service = null;
  checks.push('idle future schedule permits real Core safe shutdown');
  backend = new CoreBackend(options);
  await backend.init();
  await backend.start(projectId);
  const restored = await backend.command('manage', { projectId, operation: 'task', taskId: scheduled.id });
  assert.equal(restored.paused, false);
  assert.equal(restored.cancelled, false);
  assert.deepEqual(restored.schedule, scheduled.schedule);
  assert.equal(restored.runs.length, 0);
  assert.notEqual(backend.projects.get(projectId).service.generation, generation);
  checks.push('safe restart retains schedule identity, timing and enabled state without running it');
  const { threadId } = await backend.command('create', { projectId });
  await backend.projects.get(projectId).client.request('areal/queue/pause', { threadId, requestId: crypto.randomUUID(), expectedRevision: 0 });
  await backend.projects.get(projectId).client.request('areal/turn/enqueue', { threadId, requestId: crypto.randomUUID(), input: [{ type: 'text', text: 'Preserved pending input' }] });
  // A paused persisted queue is intentionally protected by public Core stop.
  const guarded = await resources.inspectResources(backend);
  assert.equal(guarded[0].restartSafe, false);
  assert.match(resources.summary(guarded), /排队消息 [1-9]/);
  await assert.rejects(() => require('../app/src/core/local-service.cjs').stopService(backend, backend.projects.get(projectId)), error => error.code === 'CORE_BUSY' && !error.message.includes('{'));
  await assert.rejects(() => service?.stop() ?? backend.shutdown(), error => error.code === 'CORE_RESOURCES');
  const currentService = backend.projects.get(projectId).service;
  await assert.rejects(() => require('../app/src/core/core-process.cjs').executeCore(binary,
    ['service', 'stop', '--instance', currentService.serviceId, '--expected-generation', 'unconfirmed-generation', '--cancel', '--json'],
    { env: backend.hooks.environment(), timeout: 10000 }), error => error.stderr.includes('service generation changed'));
  assert.equal((await backend.projects.get(projectId).client.request('areal/server/status')).acceptingWork, true);
  checks.push('public stop rejects an unconfirmed generation before changing Core admission');
  const queueBefore = await backend.projects.get(projectId).client.request('areal/queue/list', { threadId });
  service = new DesktopService(backend, 'fixture-cancel');
  const guardedMetadata = await service.listen();
  const first = new ServiceConnection(), second = new ServiceConnection();
  try {
    for (const c of [first, second]) { await c.connect(guardedMetadata); await c.request('hello', { protocol: guardedMetadata.protocol, identity: guardedMetadata.identity }); }
    const expectedTargets = [{ projectId, serviceId: currentService.serviceId, generation: currentService.generation }];
    await assert.rejects(() => first.request('stopService', { protocol: guardedMetadata.protocol, forUpdate: true, cancel: true, expectedTargets }, true), /其他.*GUI/);
    second.close(); await new Promise(r => setTimeout(r, 30));
    await assert.rejects(() => first.request('stopService', { protocol: guardedMetadata.protocol, forUpdate: true, cancel: true,
      expectedTargets: [{ ...expectedTargets[0], generation: 'unconfirmed-generation' }] }, true), error => error.code === 'CONFIRMATION_STALE');
    assert.equal((await backend.projects.get(projectId).client.request('areal/server/status')).acceptingWork, true);
    checks.push('authenticated Desktop stop rechecks peer clients and confirmed Core generation before cancellation');
  } finally { first.close(); second.close(); }
  await service.stop({ cancel: true });
  service.close(); service = null;
  backend = new CoreBackend(options);
  await backend.init(); await backend.start(projectId);
  const queueAfter = await backend.projects.get(projectId).client.request('areal/queue/list', { threadId });
  assert.equal(queueAfter.paused, true);
  assert.deepEqual(queueAfter.items, queueBefore.items);
  const afterStatus = await backend.projects.get(projectId).client.request('areal/server/status');
  assert.equal(afterStatus.lifecycle.ifIdle.allowed, false);
  assert.equal(afterStatus.lifecycle.settled.allowed, true);
  checks.push('cancel reaches the public host; stopped Core reopens with identical paused pending input and no replay');
  const secondWorkspace = join(scratch, 'second-workspace'); await mkdir(secondWorkspace);
  const secondProjectId = await backend.addProject(secondWorkspace);
  const secondService = backend.projects.get(secondProjectId).service;
  const failingBinary = join(scratch, 'fail-second-stop.cjs');
  await writeFile(failingBinary, `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'service' && args[1] === 'stop' && args.includes(${JSON.stringify(secondService.serviceId)})) {
  process.stderr.write('injected second Core stop failure'); process.exit(1);
}
const result = spawnSync(${JSON.stringify(binary)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  service = new DesktopService(backend, 'fixture-partial');
  const partialMetadata = await service.listen();
  const recoveryConnection = new ServiceConnection();
  try {
    backend.binary = failingBinary;
    await assert.rejects(() => service.stop({ cancel: true }), /injected second Core stop failure/);
    assert.equal(backend.closing, true);
    assert.deepEqual(service.stopReport.projects.map(p => p.phase), ['exited', 'unknown']);
    await recoveryConnection.connect(partialMetadata);
    await recoveryConnection.request('hello', { protocol: partialMetadata.protocol, identity: partialMetadata.identity });
    await assert.rejects(() => recoveryConnection.request('command', { name: 'create', request: { projectId: secondProjectId } }, true), error => error.code === 'LIFECYCLE_INCOMPLETE');
    const stillObservable = await recoveryConnection.request('command', { name: 'manage', request: { projectId: secondProjectId, operation: 'server' } });
    assert.equal(stillObservable.lifecycle.version, 1);
    const partialResources = await recoveryConnection.request('resources', { operation: 'inspect' });
    assert.equal(partialResources.length, 1);
    backend.binary = binary;
    await service.stop({ cancel: true });
    assert.deepEqual(backend.stopOutcomes.map(p => p.phase), ['exited', 'exited']);
    checks.push('partial multi-Core stop retains exited and unknown outcomes, rejects new work, permits observation and settles on explicit retry');
  } finally { backend.binary = binary; recoveryConnection.close(); service.close(); service = null; }
  backend = null;

  // Legacy adapter boundary: restartSafe=true but activeTasks includes a future
  // schedule. The real authenticated transport runs the current recovery owner.
  const legacyHome = join(scratch, 'legacy'); await mkdir(legacyHome);
  const legacyTask = { id: 'legacy-schedule', threadId: 'legacy-thread', mode: 'scheduled', paused: false, cancelled: false, revision: 3, runs: [], nextRunAt: 4070908800, schedule: { at: '2099-01-01T00:00:00Z' } };
  const legacy = {
    projects: new Map([['legacy-project', { client: { ready: true, request: async method => {
      assert.equal(method, 'areal/server/status');
      return { restartSafe: true, activeGoals: [], activeTasks: legacyTask.paused ? 0 : 1, pendingQueueItems: 0, resources: [] };
    } }, root: workspace, model: { state: { queues: {} } } }]]),
    starting: new Map(), hasWork: () => false, snapshot: () => ({ projects: [{ id: 'legacy-project', root: workspace }] }),
    providers: { redact: value => value }, analytics: { sample() {}, async flush() {} },
    command: async (name, request) => {
      assert.equal(name, 'manage'); assert.equal(request.taskId, legacyTask.id);
      if (request.operation === 'task') return structuredClone(legacyTask);
      assert.ok(['taskPause', 'taskResume'].includes(request.operation)); assert.equal(request.expectedRevision, legacyTask.revision);
      legacyTask.paused = request.operation === 'taskPause'; legacyTask.revision++;
      return structuredClone(legacyTask);
    },
    shutdown: async () => assert.equal(legacyTask.paused, true),
  };
  // Emulate the already-running adapter's old resource projection. Its count
  // must still be checked by new Main even when the old restartSafe is true.
  service = new DesktopService(legacy, 'fixture-legacy', () => { void rm(join(legacyHome, 'service.json')); });
  const originalReceive = service.receive.bind(service);
  service.receive = async (socket, bytes) => {
    const message = JSON.parse(bytes);
    if (message.method === 'resources' && message.params.operation === 'inspect') {
      service.send(socket, { id: message.id, result: [{ projectId: 'legacy-project', root: workspace, restartSafe: true, resources: [], activeTurns: 0, goalThreads: [], activeTasks: legacyTask.paused ? 0 : 1, waitingMessages: 0, tasks: legacyTask.paused ? [] : [{ id: legacyTask.id, mode: 'scheduled', paused: false, running: false }] }] }); return;
    }
    return originalReceive(socket, bytes);
  };
  const originalPacket = service.packet.bind(service);
  service.packet = () => { const packet = originalPacket(); delete packet.service.lifecycleVersion; delete packet.service.targets; return packet; };
  const metadata = await service.listen();
  metadata.pid = 2147483000;
  await writeFile(join(legacyHome, 'service.json'), JSON.stringify(metadata));
  const probe = new ServiceConnection();
  try {
    await probe.connect(metadata);
    await assert.rejects(() => probe.request('hello', { protocol: metadata.protocol, identity: 'fixture-current' }), error => error.code === 'SERVICE_INCOMPATIBLE');
  } finally { probe.close(); }
  await recoverStartupService({ metadata, home: legacyHome, notify: async dialog => {
    dialogs.push(dialog);
    if (dialogs.length === 1) {
      assert.equal(dialog.message, '后台暂时无法重启');
      assert.ok(!dialog.buttons.includes('重启后台并继续'));
      assert.match(dialog.detail, /定时/);
      return { response: dialog.buttons.indexOf('暂停定时安排…') };
    }
    if (dialogs.length === 2) {
      assert.match(dialog.detail, /Run 保持暂停/);
      return { response: 1 };
    }
    assert.equal(dialog.message, '需要重启后台服务');
    return { response: dialog.buttons.indexOf('重启后台并继续') };
  } });
  assert.equal(legacyTask.paused, true);
  assert.equal(legacyTask.cancelled, false);
  assert.equal(JSON.parse(await readFile(join(legacyHome, 'legacy-schedule-recovery.json'))).entries[0].phase, 'paused');
  checks.push('legacy incompatible adapter blocks unsafe restart and persists a revision-bound arrangement recovery before temporary pause');
  service.close(); service = null;
  service = new DesktopService(legacy, 'fixture-new');
  const replacement = await service.listen();
  replacement.pid = 2147482999;
  const restoredConnection = new ServiceConnection();
  try {
    await restoredConnection.connect(replacement);
    await restoredConnection.request('hello', { protocol: replacement.protocol, identity: replacement.identity });
    const restoration = await restoreLegacySchedules({ connection: restoredConnection, home: legacyHome, metadata: replacement });
    assert.deepEqual(restoration, { restored: 1, attention: [] });
    assert.equal(legacyTask.paused, false);
    assert.deepEqual(legacyTask.schedule, { at: '2099-01-01T00:00:00Z' });
    await assert.rejects(readFile(join(legacyHome, 'legacy-schedule-recovery.json')), { code: 'ENOENT' });
    checks.push('replacement restores only the original arrangement and removes its recovery record after confirmed revision-checked success');
  } finally { restoredConnection.close(); service.close(); service = null; }
  passed = true;
} finally {
  service?.close();
  if (backend) {
    for (const project of backend.projects.values()) if (project.service) {
      // Cleanup is restricted to this script's isolated fixtures.
      await require('../app/src/core/core-process.cjs').executeCore(binary, ['service', 'stop', '--instance', project.service.serviceId, '--cancel', '--json'], { env: backend.hooks.environment(), timeout: 30000 }).catch(() => {});
    }
    await backend.disconnect().catch(() => {});
  }
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({ passed, checks, dialogs, binarySha256, scope: 'real Core/Runtime lifecycle; authenticated legacy adapter fixture' }, null, 2));
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
}
