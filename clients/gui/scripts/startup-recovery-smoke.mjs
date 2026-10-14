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
  const queue = await backend.projects.get(projectId).client.request('areal/queue/list', { threadId });
  for (const item of queue.items.filter(item => item.status === 'pending')) {
    await backend.projects.get(projectId).client.request('areal/queue/remove', { threadId, requestId: crypto.randomUUID(), queueItemId: item.id, expectedRevision: (await backend.projects.get(projectId).client.request('areal/queue/list', { threadId })).revision });
  }
  checks.push('pending queue blocks shutdown before drain and reports the actual blocker');
  await backend.shutdown(); backend = null;

  // Legacy adapter boundary: restartSafe=true but activeTasks includes a future
  // schedule. The real authenticated transport runs the current recovery owner.
  const legacyHome = join(scratch, 'legacy'); await mkdir(legacyHome);
  const legacyTask = { id: 'legacy-schedule', mode: 'scheduled', paused: false, cancelled: false, revision: 3, runs: [], schedule: { at: '2099-01-01T00:00:00Z' } };
  const legacy = {
    projects: new Map([['legacy-project', { client: { ready: true, request: async method => {
      assert.equal(method, 'areal/server/status');
      return { restartSafe: true, activeGoals: [], activeTasks: legacyTask.paused ? 0 : 1, pendingQueueItems: 0, resources: [] };
    } }, model: { state: { queues: {} } } }]]),
    starting: new Map(), hasWork: () => false, snapshot: () => ({ projects: [] }),
    providers: { redact: value => value }, analytics: { sample() {}, async flush() {} },
    command: async (name, request) => {
      assert.equal(name, 'manage'); assert.equal(request.taskId, legacyTask.id);
      if (request.operation === 'task') return structuredClone(legacyTask);
      assert.equal(request.operation, 'taskPause'); assert.equal(request.expectedRevision, legacyTask.revision);
      legacyTask.paused = true; legacyTask.revision++;
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
      service.send(socket, { id: message.id, result: [{ projectId: 'legacy-project', restartSafe: true, resources: [], activeTurns: 0, goalThreads: [], activeTasks: legacyTask.paused ? 0 : 1, waitingMessages: 0, tasks: legacyTask.paused ? [] : [{ id: legacyTask.id, mode: 'scheduled', paused: false, running: false }] }] }); return;
    }
    return originalReceive(socket, bytes);
  };
  const metadata = await service.listen();
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
      assert.match(dialog.detail, /保持暂停/);
      return { response: 1 };
    }
    assert.equal(dialog.message, '需要重启后台服务');
    return { response: dialog.buttons.indexOf('重启后台并继续') };
  } });
  assert.equal(legacyTask.paused, true);
  assert.equal(legacyTask.cancelled, false);
  checks.push('legacy incompatible adapter blocks unsafe restart and requires explicit schedule pause before safe stop');
  service.close(); service = null;
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
