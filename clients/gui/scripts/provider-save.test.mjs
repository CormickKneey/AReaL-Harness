import test from "node:test";
import assert from "node:assert/strict";
import { AppProviders } from "../app/src/core/providers.cjs";

const readMethod = "areal/server/modelConfiguration/read";
const applyMethod = "areal/server/modelConfiguration/apply";

function fixture({ busy = false, writeFails = false, syncFails = false, lostApply = false, running = false, unsupported = false, unacceptedError } = {}) {
  const calls = [];
  const original = {
    revision: "old",
    data: [{ id: "demo", name: "Original", enabled: true, endpoint: "http://fixture.invalid/v1/chat/completions", protocol: "chat-completions", models: [{ id: "old-model", enabled: true }], parameters: {} }],
    defaultModel: null,
  };
  const operations = new Map();
  let applyAttempts = 0;
  let proof = { serviceId: "service-p", generation: "generation-p", applied: { revision: "old", sequence: 0 }, modelRevision: "model-old", credentialStates: { demo: "notRequired" } };
  const project = { id: "p", root: "/fixture", service: { serviceId: "service-p", generation: "generation-p" }, providerRevision: "old", models: [{ id: "old-model" }], configurations: { running: { model: "old-model" } }, client: {
    ready: true,
    capabilities: { methods: unsupported ? [] : [readMethod, applyMethod] },
    async request(method, params) {
      calls.push([method, structuredClone(params)]);
      if (method === "areal/server/status") return { restartSafe: true };
      if (method === readMethod) return { ...structuredClone(proof), ...(params?.requestId ? { operation: operations.get(params.requestId) ?? { requestId: params.requestId, state: "unknown" } } : {}) };
      if (method === "areal/model/list") return { data: service.config.value.data.flatMap(v => v.models) };
      assert.equal(method, applyMethod);
      assert.equal(params.expectedGeneration, "generation-p");
      assert.deepEqual(params.expectedApplied, proof.applied);
      assert.deepEqual(params.credentials, {});
      if (unacceptedError && applyAttempts++ === 0) throw Object.assign(new Error("fixture request rejected before admission"), { name: "CoreRpcError", ...unacceptedError });
      if (syncFails && !operations.size) {
        const error = { code: -32000, message: "fixture synchronization failure" };
        operations.set(params.requestId, { requestId: params.requestId, state: "rejected", error });
        throw Object.assign(new Error(error.message), { code: error.code });
      }
      if (running) {
        operations.set(params.requestId, { requestId: params.requestId, state: "running" });
        throw new Error("fixture receipt pending");
      }
      proof = { ...proof, applied: { revision: params.targetRevision, sequence: proof.applied.sequence + 1 } };
      const operation = { requestId: params.requestId, state: "applied", result: structuredClone(proof) };
      operations.set(params.requestId, operation);
      if (lostApply && operations.size === 1) throw new Error("fixture apply receipt lost");
      return { ...structuredClone(proof), operation };
    },
  } };
  let writes = 0, release;
  const backend = { projects: new Map([["p", project]]), starting: new Set(), hasWork: () => busy, activeCommands: 0, resourcesUpdating: false, providerUpdating: false, onChange() {}, async restartProject() { throw new Error("configuration must never restart Core"); } };
  const service = new AppProviders(backend, {});
  service.config.value = structuredClone(original);
  service.config.current = async () => service.config.value;
  service.config.execute = async (_operation, request) => {
    calls.push(["write", structuredClone(request)]);
    writes++;
    if (writeFails && writes === 1) throw new Error("fixture persistence failure");
    if (release) await release.promise;
    assert.equal(request.expectedRevision, service.config.value.revision);
    return { ...structuredClone(original), revision: `revision-${writes}`, data: structuredClone(request.data), defaultModel: request.defaultModel };
  };
  const request = { operation: "saveAndApply", expectedRevision: "old", authentication: "none", provider: { id: "demo", name: "Updated", baseUrl: "http://fixture.invalid/v1", protocol: "chatCompletions", enabled: true, models: [{ id: "new-model", enabled: true }], parameters: { contextWindowTokens: 64000 } } };
  return { service, backend, project, calls, original, request, operations, holdWrite() { let resolve; release = { promise: new Promise(r => { resolve = r; }), resolve: () => resolve() }; return release; } };
}

test("one save returns only after the same Core proves the revision and its catalog is refreshed", async () => {
  const f = fixture();
  const response = await f.service.command(f.request);
  assert.equal(response.pendingApply, false);
  assert.equal(response.defaultModel, null);
  assert.equal(f.project.models[0].id, "new-model");
  assert.equal(f.project.providerRevision, response.revision);
  assert.equal(response.data[0].parameters.contextWindowTokens, 64000);
  assert.deepEqual(f.calls.map(v => v[0]), [readMethod, "areal/server/status", "write", applyMethod, "areal/model/list"]);
  assert.equal(f.project.service.generation, "generation-p");
});

test("running task save fails before persistence or Core mutation", async () => {
  const f = fixture({ busy: true });
  await assert.rejects(f.service.command(f.request), /完成后再保存/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.service.config.value, f.original);
  assert.deepEqual(f.project.configurations.running, { model: "old-model" });
  assert.equal(f.backend.providerUpdating, false);
});

test("old Core fails capability preflight before touching the document", async () => {
  const f = fixture({ unsupported: true });
  await assert.rejects(f.service.command(f.request), /更新.*Core|更新后台/);
  assert.deepEqual(f.service.config.value, f.original);
  assert.equal(f.calls.filter(v => v[0] === "write").length, 0);
});

test("persistence failure leaves the original Core usable without restarting", async () => {
  const f = fixture({ writeFails: true });
  await assert.rejects(f.service.command(f.request), /persistence failure/);
  assert.deepEqual(f.service.config.value, f.original);
  assert.equal(f.project.models[0].id, "old-model");
  assert.equal(f.backend.providerUpdating, false);
});

test("Core admission refusal after preflight settles before CAS rollback and compensation", async () => {
  const f = fixture({ syncFails: true });
  await assert.rejects(f.service.command(f.request), /已恢复原配置/);
  assert.deepEqual(f.service.config.value.data, f.original.data);
  assert.equal(f.project.models[0].id, "old-model");
  assert.equal(f.calls.filter(v => v[0] === "write").length, 2);
  assert.equal(f.backend.providerUpdating, false);
  assert.deepEqual(f.project.configurations.running, { model: "old-model" });
});

test("a lost apply receipt reads the original operation and does not submit twice", async () => {
  const f = fixture({ lostApply: true });
  const response = await f.service.command(f.request);
  assert.equal(response.pendingApply, false);
  assert.equal(f.calls.filter(v => v[0] === applyMethod).length, 1);
  assert.equal(f.calls.filter(v => v[0] === "write").length, 1);
  const apply = f.calls.find(v => v[0] === applyMethod)[1];
  assert.equal(f.calls.findLast(v => v[0] === readMethod)[1].requestId, apply.requestId);
});

test("a pending apply retains the written revision and reconciles by the original request id", async () => {
  const f = fixture({ running: true });
  await assert.rejects(f.service.command(f.request), /确认|等待|应用/);
  assert.equal(f.service.config.value.revision, "revision-1");
  assert.equal(f.project.providerRevision, "old");
  assert.equal(f.service.public().pendingApply, true);
  await f.service.command({ operation: "list" });
  assert.equal(f.calls.filter(v => v[0] === applyMethod).length, 1);
  assert.equal(f.calls.filter(v => v[0] === "write").length, 1);
  assert.equal(f.operations.size, 1);
});

test("a mismatched receipt cannot report success or overwrite the confirmed Core revision", async () => {
  const f = fixture();
  const native = f.project.client.request;
  f.project.client.request = async function(method, params) {
    const response = await native.call(this, method, params);
    if (method === applyMethod || method === readMethod && params?.requestId) return { ...response, generation: "unrelated-generation" };
    return response;
  };
  await assert.rejects(f.service.command(f.request), /确认|连接|应用/);
  assert.equal(f.project.providerRevision, "old");
  assert.equal(f.service.config.value.revision, "revision-1");
});

test("repeated save cannot overlap persistence and explicit retry succeeds after failure", async () => {
  const f = fixture();
  const held = f.holdWrite();
  const first = f.service.command(f.request);
  while (!f.calls.some(v => v[0] === "write")) await new Promise(r => setImmediate(r));
  await assert.rejects(f.service.command(f.request), /正在保存/);
  held.resolve();
  await first;
  assert.equal(f.calls.filter(v => v[0] === "write").length, 1);
  const failed = fixture({ writeFails: true });
  await assert.rejects(failed.service.command(failed.request));
  const result = await failed.service.command(failed.request);
  assert.equal(result.pendingApply, false);
  assert.equal(failed.project.models[0].id, "new-model");
});

test("new connection discovers models before persistence and leaves default choice unchanged", async () => {
  const f = fixture();
  f.request.provider = { ...f.request.provider, id: undefined, models: [], parameters: {} };
  f.service.testConnection = async (provider, request) => {
    assert.equal(request.operation, "discover");
    assert.equal(provider.endpoint, "http://fixture.invalid/v1/chat/completions");
    assert.equal(f.calls.some(v => v[0] === "write"), false);
    return { models: ["remote-first", "remote-second", "remote-first"], modelParameters: { "remote-first": { contextWindowTokens: 500000 } } };
  };
  const result = await f.service.command(f.request);
  assert.deepEqual(result.data.at(-1).models.map(m => m.id), ["remote-first", "remote-second"]);
  assert.deepEqual(result.data.at(-1).models[0].parameters, { contextWindowTokens: 500000 });
  assert.deepEqual(result.data.at(-1).models[1].parameters, {});
  assert.equal(result.defaultModel, null);
  assert.equal(result.pendingApply, false);
  assert.ok(f.project.models.some(m => m.id === "remote-second"));
  const explicit = fixture();
  explicit.request.provider = { ...explicit.request.provider, id: undefined, models: [] };
  explicit.service.testConnection = async () => ({ models: ["remote-first"], modelParameters: { "remote-first": { contextWindowTokens: 500000 } } });
  const configured = await explicit.service.command(explicit.request);
  assert.equal(configured.data.at(-1).parameters.contextWindowTokens, 64000);
  assert.deepEqual(configured.data.at(-1).models[0].parameters, {});
});

test("discovery failure does not persist a new provider", async () => {
  const f = fixture();
  f.request.provider = { ...f.request.provider, id: undefined, models: [] };
  f.service.testConnection = async () => { throw new Error("fixture authentication failure"); };
  await assert.rejects(f.service.command(f.request), /authentication failure/);
  assert.equal(f.calls.some(v => v[0] === "write"), false);
  assert.deepEqual(f.service.config.value, f.original);
  assert.equal(f.project.models[0].id, "old-model");
});

test("lost persistence receipt reconciles the exact candidate before CAS rollback", async () => {
  const f = fixture();
  let native = structuredClone(f.original), writes = 0;
  f.service.config.current = async () => (f.service.config.value = structuredClone(native));
  f.service.config.execute = async (_operation, request) => {
    assert.equal(request.expectedRevision, native.revision);
    writes++;
    native = { ...native, revision: `native-${writes}`, data: structuredClone(request.data), defaultModel: request.defaultModel };
    if (writes === 1) throw new Error("fixture persisted receipt lost");
    return structuredClone(native);
  };
  await assert.rejects(f.service.command(f.request), /已恢复原配置/);
  assert.equal(writes, 2);
  assert.deepEqual(native.data, f.original.data);
  assert.equal(f.project.models[0].id, "old-model");
  assert.equal(f.backend.providerUpdating, false);
});

test("an external edit after application cannot produce overall save success", async () => {
  const f = fixture();
  const native = f.project.client.request;
  f.project.client.request = async function(method, params) {
    const response = await native.call(this, method, params);
    if (method === "areal/model/list") f.service.config.value = { ...f.service.config.value, revision: "external-edit" };
    return response;
  };
  await assert.rejects(f.service.command(f.request), /变化|回滚/);
  assert.equal(f.service.config.value.revision, "external-edit");
  assert.equal(f.project.providerRevision, "revision-1");
  assert.equal(f.service.public().pendingApply, true);
});


test("invalid API key characters fail before vault or configuration persistence", async () => {
  for (const apiKey of ["sk-\tcontrol", "sk-非ASCII", "sk-\u007fcontrol"]) {
    const f = fixture();
    f.service.config.encryption = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
    f.backend.save = async () => { f.calls.push(["vaultWrite"]); };
    await assert.rejects(f.service.command({ ...f.request, authentication: "apiKey", apiKey }), /凭据格式无效/);
    assert.deepEqual(f.service.config.value, f.original);
    assert.deepEqual(f.service.config.vault.keys, {});
    assert.equal(f.calls.filter(v => v[0] === "vaultWrite" || v[0] === "write" || v[0] === applyMethod).length, 0);
  }
});

test("explicit non-admission errors reconcile the original unknown record and permit compensation", async () => {
  for (const unacceptedError of [{ code: -32602 }, { code: -32601 }, { code: -32003 }, { code: -32010, data: { reason: "MODEL_CONFIGURATION_CAPACITY" } }]) {
    const f = fixture({ unacceptedError });
    await assert.rejects(f.service.command(f.request), /已恢复原配置/);
    assert.deepEqual(f.service.config.value.data, f.original.data);
    assert.equal(f.service.config.value.revision, "revision-2");
    assert.equal(f.project.models[0].id, "old-model");
    assert.equal(f.service.pendingApplications.size, 0);
    const apply = f.calls.find(v => v[0] === applyMethod)[1];
    assert.equal(f.calls.find(v => v[0] === readMethod && v[1]?.requestId)[1].requestId, apply.requestId);
  }
});

test("unclassified RPC errors and unknown submission flags retain the original pending request", async () => {
  for (const unacceptedError of [{ code: -32010 }, { code: -32010, data: { reason: "MODEL_CONFIGURATION_UNKNOWN" } }, { code: -32010, data: { reason: "MODEL_CONFIGURATION_REQUEST_CONFLICT" } }, { code: -32602, submissionUnknown: true }]) {
    const f = fixture({ unacceptedError });
    await assert.rejects(f.service.command(f.request), /待确认|应用/);
    assert.equal(f.service.config.value.revision, "revision-1");
    assert.equal(f.project.providerRevision, "old");
    assert.equal(f.service.pendingApplications.size, 1);
    assert.equal(f.calls.filter(v => v[0] === applyMethod).length, 1);
    assert.equal(f.calls.filter(v => v[0] === "write").length, 1);
  }
});

test("an explicit RPC refusal cannot settle an existing running or unknown operation", async () => {
  for (const operation of [{ state: "running" }, { state: "unknown", error: { code: -32010, data: { reason: "MODEL_CONFIGURATION_UNKNOWN" } } }]) {
    const f = fixture({ unacceptedError: { code: -32602 } });
    const native = f.project.client.request;
    f.project.client.request = async function(method, params) {
      const response = await native.call(this, method, params);
      return method === readMethod && params?.requestId ? { ...response, operation: { requestId: params.requestId, ...operation } } : response;
    };
    await assert.rejects(f.service.command(f.request), /待确认|应用/);
    assert.equal(f.service.config.value.revision, "revision-1");
    assert.equal(f.service.pendingApplications.size, 1);
    assert.equal(f.calls.filter(v => v[0] === "write").length, 1);
  }
});

test("the original terminal applied record wins over an explicit RPC refusal", async () => {
  const f = fixture({ unacceptedError: { code: -32602 } });
  const native = f.project.client.request;
  f.project.client.request = async function(method, params) {
    const response = await native.call(this, method, params);
    if (method !== readMethod || !params?.requestId) return response;
    const result = { serviceId: "service-p", generation: "generation-p", applied: { revision: "revision-1", sequence: 1 }, modelRevision: "model-new", credentialStates: { demo: "notRequired" } };
    return { ...result, operation: { requestId: params.requestId, state: "applied", result } };
  };
  const response = await f.service.command(f.request);
  assert.equal(response.revision, "revision-1");
  assert.equal(response.pendingApply, false);
  assert.equal(f.project.models[0].id, "new-model");
  assert.equal(f.service.pendingApplications.size, 0);
  assert.equal(f.calls.filter(v => v[0] === "write").length, 1);
});


test("discovery preserves endpoint context without using maximum opt-in capacity", async () => {
  const f = fixture();
  f.service.network = async () => ({ fetch: async () => Response.json({ data: [
    { id: "openai/gpt-6.1-sol", context_window: 500000, max_context_window: 872000 },
    { id: "bad", context_window: "1050000" },
    { id: "negative", context_window: -1 },
    { id: "maximum-only", max_context_window: 872000 },
  ] }) });
  const result = await f.service.testConnection(f.service.config.value.data[0], { operation: "discover" });
  assert.deepEqual(result.models, ["openai/gpt-6.1-sol", "bad", "negative", "maximum-only"]);
  assert.deepEqual(result.modelParameters, { "openai/gpt-6.1-sol": { contextWindowTokens: 500000 } });
});


test("custom model capability declarations survive the desktop save boundary", async () => {
  const f = fixture();
  const capabilities = { tools: true, vision: false, reasoning: true, reasoningEffortOptions: ["low", "high", "max"] };
  f.request.provider.models[0].capabilities = capabilities;
  f.request.provider.models[0].parameters = { reasoningEffort: "max" };
  const result = await f.service.command(f.request);
  assert.deepEqual(result.data[0].models[0].capabilities, capabilities);
  assert.equal(result.data[0].models[0].parameters.reasoningEffort, "max");
  assert.deepEqual(f.calls.find(([method]) => method === "write")[1].data[0].models[0].capabilities, capabilities);
});

test("invalid custom capability declarations are rejected before persistence", async () => {
  for (const capabilities of [
    { tools: "yes", vision: false, reasoning: false },
    { tools: true, vision: false, reasoning: true, reasoningEffortOptions: ["invented"] },
    { tools: true, vision: false, reasoning: true, reasoningEffortOptions: ["low", "low"] },
    { tools: true, vision: false, reasoning: false, media: true },
  ]) {
    const f = fixture();
    f.request.provider.models[0].capabilities = capabilities;
    await assert.rejects(f.service.command(f.request), /模型能力/);
    assert.equal(f.calls.some(([method]) => method === "write"), false);
  }
});
