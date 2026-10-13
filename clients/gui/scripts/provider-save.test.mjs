import test from "node:test";
import assert from "node:assert/strict";
import { AppProviders } from "../app/src/core/providers.cjs";

function fixture({ busy = false, writeFails = false, syncFails = false } = {}) {
  const calls = [];
  const original = {
    revision: "old",
    data: [
      {
        id: "demo",
        name: "Original",
        enabled: true,
        endpoint: "http://fixture.invalid/v1/chat/completions",
        protocol: "chat-completions",
        models: [{ id: "old-model", enabled: true }],
        parameters: {},
      },
    ],
    defaultModel: null,
  };
  const project = {
    id: "p",
    root: "/fixture",
    service: {},
    providerRevision: "old",
    configurations: { running: { model: "old-model" } },
    client: {
      ready: true,
      async request(method, params) {
        calls.push([method, params]);
        return { restartSafe: true };
      },
    },
  };
  let writes = 0,
    syncs = 0,
    release;
  const backend = {
    projects: new Map([["p", project]]),
    starting: new Set(),
    hasWork: () => busy,
    activeCommands: 0,
    resourcesUpdating: false,
    providerUpdating: false,
    onChange() {},
    async restartProject(p) {
      calls.push(["restart"]);
      syncs++;
      if (syncFails && syncs === 1) throw new Error("fixture synchronization failure");
      p.providerRevision = service.config.value.revision;
      p.models = service.config.value.data.flatMap((v) => v.models);
    },
  };
  const service = new AppProviders(backend, {});
  service.config.value = structuredClone(original);
  service.config.current = async () => service.config.value;
  service.config.execute = async (_operation, request) => {
    calls.push(["write", structuredClone(request)]);
    writes++;
    if (writeFails && writes === 1) throw new Error("fixture persistence failure");
    if (release) await release.promise;
    assert.equal(request.expectedRevision, service.config.value.revision);
    return {
      ...structuredClone(original),
      revision: `revision-${writes}`,
      data: structuredClone(request.data),
      defaultModel: request.defaultModel,
    };
  };
  const request = {
    operation: "saveAndApply",
    expectedRevision: "old",
    authentication: "none",
    provider: {
      id: "demo",
      name: "Updated",
      baseUrl: "http://fixture.invalid/v1",
      protocol: "chatCompletions",
      enabled: true,
      models: [{ id: "new-model", enabled: true }],
      parameters: { contextWindowTokens: 64000 },
    },
  };
  return {
    service,
    backend,
    project,
    calls,
    original,
    request,
    holdWrite() {
      let resolve;
      release = {
        promise: new Promise((r) => {
          resolve = r;
        }),
        resolve: () => resolve(),
      };
      return release;
    },
  };
}

test("one save returns only after persistence and Core catalog confirmation without choosing a default", async () => {
  const f = fixture();
  const response = await f.service.command(f.request);
  assert.equal(response.pendingApply, false);
  assert.equal(response.defaultModel, null);
  assert.equal(f.project.models[0].id, "new-model");
  assert.equal(f.project.providerRevision, response.revision);
  assert.equal(response.data[0].parameters.contextWindowTokens, 64000);
  assert.deepEqual(
    f.calls.map((v) => v[0]),
    ["areal/server/status", "areal/server/drain", "write", "restart"],
  );
});

test("running task save fails before touching persistence, credentials, Core admission or frozen configuration", async () => {
  const f = fixture({ busy: true });
  await assert.rejects(f.service.command(f.request), /完成后再保存/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.service.config.value, f.original);
  assert.deepEqual(f.project.configurations.running, { model: "old-model" });
  assert.equal(f.backend.providerUpdating, false);
});

test("persistence failure restores Core admission and leaves the original usable configuration", async () => {
  const f = fixture({ writeFails: true });
  await assert.rejects(f.service.command(f.request), /persistence failure/);
  assert.deepEqual(f.service.config.value, f.original);
  assert.equal(f.project.models[0].id, "old-model");
  assert.equal(f.backend.providerUpdating, false);
});

test("a task admitted after preflight refuses the ifIdle fence without write, restart or cancellation", async () => {
  const f = fixture();
  f.project.client.request = async (method, params) => {
    f.calls.push([method, params]);
    if (method === "areal/server/drain") {
      assert.equal(params.strategy, "ifIdle");
      return { restartSafe: false };
    }
    return { restartSafe: true };
  };
  await assert.rejects(f.service.command(f.request), /任务尚未结算/);
  assert.deepEqual(
    f.calls.map((v) => v[0]),
    ["areal/server/status", "areal/server/drain"],
  );
  assert.deepEqual(f.service.config.value, f.original);
  assert.deepEqual(f.project.configurations.running, { model: "old-model" });
  assert.equal(f.backend.providerUpdating, false);
});

test("synchronization failure CAS rolls back persisted configuration before restoring Core", async () => {
  const f = fixture({ syncFails: true });
  await assert.rejects(f.service.command(f.request), /已恢复原配置/);
  assert.deepEqual(f.service.config.value.data, f.original.data);
  assert.equal(f.project.models[0].id, "old-model");
  assert.equal(f.calls.filter((v) => v[0] === "write").length, 2);
  assert.equal(f.backend.providerUpdating, false);
});

test("repeated save cannot overlap persistence and explicit retry succeeds after failure", async () => {
  const f = fixture();
  const held = f.holdWrite();
  const first = f.service.command(f.request);
  while (!f.calls.some((v) => v[0] === "write")) await new Promise((r) => setImmediate(r));
  await assert.rejects(f.service.command(f.request), /正在保存/);
  held.resolve();
  await first;
  assert.equal(f.calls.filter((v) => v[0] === "write").length, 1);
  const failed = fixture({ writeFails: true });
  await assert.rejects(failed.service.command(failed.request));
  const result = await failed.service.command(failed.request);
  assert.equal(result.pendingApply, false);
  assert.equal(failed.project.models[0].id, "new-model");
});

test("new connection save discovers models before persistence and leaves default choice unchanged", async () => {
  const f = fixture();
  f.request.provider = { ...f.request.provider, id: undefined, models: [] };
  f.service.testConnection = async (provider, request) => {
    assert.equal(request.operation, "discover");
    assert.equal(provider.endpoint, "http://fixture.invalid/v1/chat/completions");
    assert.equal(
      f.calls.some((v) => v[0] === "write"),
      false,
    );
    return { models: ["remote-first", "remote-second", "remote-first"] };
  };
  const result = await f.service.command(f.request);
  assert.deepEqual(
    result.data.at(-1).models.map((m) => m.id),
    ["remote-first", "remote-second"],
  );
  assert.equal(result.defaultModel, null);
  assert.equal(result.pendingApply, false);
  assert.ok(f.project.models.some((m) => m.id === "remote-second"));
});

test("connection discovery failure does not persist a new provider or report success", async () => {
  const f = fixture();
  f.request.provider = { ...f.request.provider, id: undefined, models: [] };
  f.service.testConnection = async () => {
    throw new Error("fixture authentication failure");
  };
  await assert.rejects(f.service.command(f.request), /authentication failure/);
  assert.equal(
    f.calls.some((v) => v[0] === "write"),
    false,
  );
  assert.deepEqual(f.service.config.value, f.original);
  assert.equal(f.project.models[0].id, "old-model");
});

test("a lost persistence receipt is reconciled and CAS rolled back without leaving a silent new configuration", async () => {
  const f = fixture();
  let native = structuredClone(f.original),
    writes = 0;
  f.service.config.current = async () => (f.service.config.value = structuredClone(native));
  f.service.config.execute = async (_operation, request) => {
    assert.equal(request.expectedRevision, native.revision);
    writes++;
    native = {
      ...native,
      revision: `native-${writes}`,
      data: structuredClone(request.data),
      defaultModel: request.defaultModel,
    };
    if (writes === 1) throw new Error("fixture persisted receipt lost");
    return structuredClone(native);
  };
  await assert.rejects(f.service.command(f.request), /已恢复原配置/);
  assert.equal(writes, 2);
  assert.deepEqual(native.data, f.original.data);
  assert.equal(f.project.models[0].id, "old-model");
  assert.equal(f.backend.providerUpdating, false);
});
