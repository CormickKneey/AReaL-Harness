import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recoverConnectedService } = require('../app/src/core/startup-recovery.cjs');

function fixture({ ifIdle = true, supported = true, result = { stopped: true }, blockers = [] } = {}) {
  const calls = [], dialogs = [];
  const view = { ifIdle, blockers, cancel: !ifIdle, targets: [{ projectId: 'p', serviceId: 's', generation: 'g' }],
    projects: [{ projectId: 'p', root: '/workspace', resources: [], lifecycle: {
      ifIdle: { allowed: ifIdle, reasons: ifIdle ? [] : [{ code: 'activeTurn', count: 1 }] },
      executionOutcomes: { uninspectedUnknown: 1 },
    } }], service: { clients: 1, activeCommands: 0, starting: 0, providerUpdating: false, busy: false, lifecycleVersion: 1, lifecycle: supported ? { version: 2, desktopGeneration: 'desktop', capabilities: { request: true, read: true, reconcile: true } } : undefined } };
  const backend = {
    observeLifecycle: async () => { calls.push({ operation: 'observe' }); return structuredClone(view); },
    stopService: async (forUpdate, options) => { calls.push({ operation: 'stop', forUpdate, cancel: options.cancel, kind: options.kind, observed: options.observed }); return result; },
  };
  backend.home = '/workspace'; backend.metadata = { protocol: 'areal.desktop-service.v1', identity: 'desktop', pid: 2147483000 };
  backend.connection = { request: async method => method === 'resources' ? structuredClone(view.projects) : { service: structuredClone(view.service) } };
  const notify = async options => { dialogs.push(options); return { response: options.message === '确认取消后台任务？' ? 1 : 0 }; };
  return { backend, calls, dialogs, notify, view };
}

test('unsupported lifecycle remains observable and never probes a write or opens cancellation dialogs', async () => {
  const f = fixture({ supported: false, ifIdle: false });
  await assert.rejects(recoverConnectedService({ backend: f.backend, notify: f.notify }), error => error.code === 'LIFECYCLE_UNSUPPORTED');
  assert.deepEqual(f.calls, [{ operation: 'observe' }]);
  assert.deepEqual(f.dialogs, []);
});

test('historical UNKNOWN with confirmed quiescence permits one stop without acknowledging the old result', async () => {
  const f = fixture();
  assert.deepEqual(await recoverConnectedService({ backend: f.backend, notify: f.notify }), { stopped: true });
  assert.equal(f.calls.filter(call => call.operation === 'stop').length, 1);
  assert.equal(f.calls.at(-1).cancel, false);
  assert.deepEqual(f.dialogs, []);
  assert.equal(f.view.projects[0].lifecycle.executionOutcomes.uninspectedUnknown, 1);
});

test('explicit cancellation confirms once and binds the original observed target scope', async () => {
  const f = fixture({ ifIdle: false });
  await recoverConnectedService({ backend: f.backend, notify: f.notify, purpose: 'update', forUpdate: true });
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].message, '确认取消后台任务？');
  assert.equal(f.calls.filter(call => call.operation === 'stop').length, 1);
  assert.equal(f.calls.at(-1).cancel, true);
  assert.equal(f.calls.at(-1).kind, 'updateDesktop');
  assert.deepEqual(f.calls.at(-1).observed.targets, f.view.targets);
});

test('declining cancellation preserves work and never sends a stop intent', async () => {
  const f = fixture({ ifIdle: false });
  const result = await recoverConnectedService({ backend: f.backend, notify: async options => { f.dialogs.push(options); return { response: 0 }; } });
  assert.equal(result.canceled, true);
  assert.deepEqual(f.calls, [{ operation: 'observe' }]);
  assert.equal(f.dialogs.length, 1);
});

test('known partial settlement is returned for inspection without another dialog or stop attempt', async () => {
  const result = { stopped: false, operation: { requestId: 'op', phase: 'partial', targets: [{ projectId: 'p', phase: 'settlementIncomplete' }] } };
  const f = fixture({ ifIdle: false, result });
  assert.deepEqual(await recoverConnectedService({ backend: f.backend, notify: f.notify }), result);
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'stop').length, 1);
});

test('other clients or in-flight operations block before cancellation confirmation', async () => {
  const f = fixture({ ifIdle: false, blockers: ['peerGui'] });
  await assert.rejects(recoverConnectedService({ backend: f.backend, notify: f.notify }), error => error.code === 'LIFECYCLE_BLOCKED');
  assert.deepEqual(f.calls, [{ operation: 'observe' }]);
  assert.deepEqual(f.dialogs, []);
});
