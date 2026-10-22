import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { definitions, connectionMetadata } from "../packages/provider-config/connections.cjs";
import { ModelCatalog } from "../packages/chatgpt-provider/catalog.js";
import {
  openaiRequest,
  subscriptionRequest,
  protocolAdapters,
} from "../packages/chatgpt-provider/adapters.js";
import { providerError } from "../packages/chatgpt-provider/errors.js";

function session() {
  const value = new EventEmitter();
  Object.assign(value, {
    revision: 0,
    busy: false,
    lifetime: new AbortController(),
    accessToken: async () => "fixture-access",
    fail(error, phase) {
      this.failure = providerError(error, phase);
      return this.failure;
    },
  });
  return value;
}
test("one shared definition supplies API, custom gateway and SIWC connection metadata", () => {
  assert.equal(new Set(definitions.map((d) => d.id)).size, definitions.length);
  for (const d of definitions)
    assert.ok(
      d.authMethods.length &&
        d.protocols.includes(d.protocol) &&
        d.discovery.strategy &&
        d.configurationSchema &&
        d.capabilityDefaults,
    );
  const api = connectionMetadata({
    id: "api",
    endpoint: "https://api.openai.com/v1/responses",
    protocol: "responses",
    apiKeyEnv: "FIXTURE_KEY",
  });
  assert.equal(api.definitionId, "openai-api");
  assert.equal(api.billing, "api");
  const gateway = connectionMetadata({
    id: "gateway",
    endpoint: "http://127.0.0.1:1234/custom/chat/completions",
    protocol: "chat-completions",
  });
  assert.equal(gateway.definitionId, "custom-compatible");
  assert.equal(gateway.authentication, "none");
  assert.equal(definitions.find((d) => d.id === "chatgpt-siwc").billing, "subscription");
});
test("account catalog shares fetch, retains order, filters hidden models and tracks freshness", async () => {
  let calls = 0,
    now = 1000;
  const account = session();
  const catalog = new ModelCatalog(
    account,
    async () => {
      calls++;
      await new Promise((resolve) => setImmediate(resolve));
      return Response.json({
        models: [
          { slug: "b", visibility: "list", display_name: "B" },
          { slug: "hidden", visibility: "hide" },
          { slug: "a", visibility: "list" },
          { slug: "b", visibility: "list" },
        ],
      });
    },
    { now: () => now, ttlMs: 100 },
  );
  const results = await Promise.all(Array.from({ length: 5 }, () => catalog.discover()));
  assert.equal(calls, 1);
  assert.deepEqual(
    results[0].map((m) => m.id),
    ["b", "a"],
  );
  assert.equal(catalog.metadata().source, "account");
  assert.equal(catalog.metadata().fresh, true);
  now += 101;
  assert.equal(catalog.metadata().fresh, false);
  await catalog.discover();
  assert.equal(calls, 2);
});
test("failed catalog drops account choices, preserves session and supports explicit retry", async () => {
  const account = session();
  let fail = true;
  const catalog = new ModelCatalog(account, async () =>
    fail
      ? Response.json({ detail: "fixture-secret" }, { status: 503 })
      : Response.json({ models: [{ slug: "m", visibility: "list" }] }),
  );
  await assert.rejects(catalog.discover(), (error) => error.state === "temporarily_unavailable");
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.metadata().fresh, false);
  fail = false;
  await catalog.discover({ force: true });
  assert.equal(account.failure, null);
});
test("late catalog from switched account cannot overwrite new choices", async () => {
  const account = session();
  let finish;
  const first = new Promise((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const catalog = new ModelCatalog(account, async () =>
    ++calls === 1 ? first : Response.json({ models: [{ slug: "new", visibility: "list" }] }),
  );
  const old = catalog.discover();
  await new Promise((resolve) => setImmediate(resolve));
  account.revision++;
  account.emit("changed");
  await catalog.discover();
  finish(Response.json({ models: [{ slug: "old", visibility: "list" }] }));
  await assert.rejects(old, (error) => error.code === "account_changed");
  assert.deepEqual(
    catalog.models.map((m) => m.id),
    ["new"],
  );
});
test("subscription adapter preserves explicit parallel tool control in both directions", () => {
  const request = {
    model: "fixture",
    stream: true,
    input: [],
    tools: [{ type: "function", name: "read", parameters: {} }],
  };
  for (const parallel of [true, false]) {
    assert.equal(
      subscriptionRequest({ ...request, parallel_tool_calls: parallel }).parallel_tool_calls,
      parallel,
    );
  }
  assert.equal(Object.hasOwn(subscriptionRequest(request), "parallel_tool_calls"), false);
});
test("SIWC adapter namespaces tools and keeps call IDs, history and supported controls", () => {
  const body = {
    model: "fixture",
    stream: true,
    input: [
      { role: "system", content: "System" },
      { type: "function_call", name: "run", call_id: "call_fixture", arguments: "{}" },
      { type: "function_call_output", call_id: "call_fixture", output: "fixture" },
    ],
    tools: [{ type: "function", name: "run", parameters: {} }],
    tool_choice: { type: "function", name: "run" },
    reasoning: { effort: "low" },
    parallel_tool_calls: true,
  };
  const encoded = openaiRequest(body);
  assert.equal(encoded.store, false);
  assert.equal(encoded.stream, true);
  assert.equal(encoded.instructions, "System");
  assert.equal(encoded.input[0].call_id, "call_fixture");
  assert.equal(encoded.input[0].namespace, "areal");
  assert.equal(encoded.tools[0].type, "namespace");
  assert.deepEqual(encoded.reasoning, body.reasoning);
  assert.equal(encoded.parallel_tool_calls, true);
  assert.equal(body.input.length, 3);
  assert.equal(body.input[1].namespace, undefined);
  assert.throws(() => openaiRequest({ ...body, temperature: 0.5 }), /参数/);
  assert.deepEqual(protocolAdapters.openai.adjustments({ ...body, max_output_tokens: 1000 }), [
    "max_output_tokens:core_budget_only",
  ]);
});

import { AuthSessionDirectory } from "../packages/chatgpt-provider/sessions.js";
test("secure session directory migrates legacy grant and separates same-email registrations", async () => {
  let record = {
    kind: "grant",
    payload: {
      hostId: "urn:uuid:fixture",
      clientId: "client-one",
      email: "same@fixture.invalid",
      access: "fixture-one",
      refresh: "refresh-one",
    },
  };
  let chain = Promise.resolve();
  const store = {
    readRecord: async () => structuredClone(record),
    modifyRecord(_key, mutate) {
      const work = chain.then(async () => {
        record = await mutate(structuredClone(record));
        return structuredClone(record);
      });
      chain = work.catch(() => {});
      return work;
    },
  };
  const directory = new AuthSessionDirectory(store);
  assert.equal((await directory.view().readRecord()).payload.access, "fixture-one");
  const id = await directory.add();
  assert.equal((await directory.public()).activeAccountId, "primary");
  assert.equal((await directory.view(id).readRecord()).payload.hostId, "urn:uuid:fixture");
  await directory.view(id).modifyRecord("", () => ({
    kind: "grant",
    payload: {
      clientId: "client-two",
      email: "same@fixture.invalid",
      access: "fixture-two",
      refresh: "refresh-two",
    },
  }));
  await directory.activate(id);
  assert.equal((await directory.view().readRecord()).payload.access, "fixture-two");
  assert.equal((await directory.view("primary").readRecord()).payload.clientId, "client-one");
  const publicState = JSON.stringify(await directory.public());
  assert.ok(
    !publicState.includes("fixture-one") &&
      !publicState.includes("refresh-one") &&
      !publicState.includes("client-two"),
  );
  assert.equal((await directory.public()).accounts.length, 2);
  const restarted = new AuthSessionDirectory(store);
  assert.equal((await restarted.public()).activeAccountId, id);
});

import { OpenAIAccount } from "../packages/chatgpt-provider/openai.js";
test("switching saved sessions validates each grant and cannot combine client IDs and tokens", async () => {
  const grant = (clientId) => ({
    kind: "grant",
    payload: {
      type: "oauth",
      hostId: "urn:uuid:fixture",
      clientId,
      subject: "subject-" + clientId,
      accountId: "subject-" + clientId,
      issuer: "https://auth.openai.com",
      access: "access-" + clientId,
      refresh: "refresh-" + clientId,
      expires: Date.now() + 3600000,
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    },
  });
  let record = grant("one");
  let chain = Promise.resolve();
  const store = {
    readRecord: async () => structuredClone(record),
    modifyRecord(_key, mutate) {
      const work = chain.then(async () => {
        const next = await mutate(structuredClone(record));
        if (next !== undefined) record = next;
        return structuredClone(record);
      });
      chain = work.catch(() => {});
      return work;
    },
  };
  const account = new OpenAIAccount(store, {
    fetch: async () => assert.fail("fresh sessions do not need OAuth"),
  });
  const second = await account.directory.add();
  await account.directory.view(second).modifyRecord("", () => grant("two"));
  await account.selectAccount(second);
  assert.equal(await account.accessToken(), "access-two");
  await account.selectAccount("primary");
  assert.equal(await account.accessToken(), "access-one");
  await assert.rejects(
    account.selectAccount("missing"),
    (error) => error.state === "reauth_required",
  );
  assert.equal((await account.directory.public()).activeAccountId, "primary");
  await account.close();
});

import { createRequire } from "node:module";
const { generateKeyPair, exportJWK, SignJWT } = await import(
  createRequire(new URL("../packages/chatgpt-provider/package.json", import.meta.url)).resolve(
    "jose",
  )
);
test("fixture SIWC validates new identity before activation and keeps busy-host authorization inactive", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = await exportJWK(publicKey);
  key.kid = "fixture-key";
  let nonce,
    record = {
      kind: "grant",
      payload: {
        type: "oauth",
        hostId: "urn:uuid:fixture",
        clientId: "fixture-old",
        subject: "fixture-old-user",
        accountId: "fixture-old-user",
        issuer: "https://auth.openai.com",
        email: "same@fixture.invalid",
        access: "fixture-old-access",
        refresh: "fixture-old-refresh",
        expires: Date.now() + 3600000,
        scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
      },
    };
  let chain = Promise.resolve();
  const store = {
    readRecord: async () => structuredClone(record),
    modifyRecord(_key, mutate) {
      const work = chain.then(async () => {
        const next = await mutate(structuredClone(record));
        if (next !== undefined) record = next;
        return structuredClone(record);
      });
      chain = work.catch(() => {});
      return work;
    },
  };
  const account = new OpenAIAccount(store, {
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, "https://auth.openai.com");
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/keys",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (url.endsWith("/keys")) return Response.json({ keys: [key] });
      assert.ok(url.endsWith("/token"));
      assert.equal(options.body.get("client_id"), "fixture-issued");
      const idToken = await new SignJWT({
        sub: "fixture-new-user",
        nonce,
        email: "same@fixture.invalid",
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
        .setIssuer("https://auth.openai.com")
        .setAudience("fixture-issued")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
      return Response.json({
        token_type: "bearer",
        access_token: "fixture-new-access",
        refresh_token: "fixture-new-refresh",
        id_token: idToken,
        expires_in: 3600,
        scope: "resource.invoke chatgpt.tokens.use.direct",
      });
    },
  });
  account.activateAuthorized = async () => false;
  try {
    const login = await account.begin({ newAccount: true });
    const url = new URL(login.authUrl);
    nonce = url.searchParams.get("nonce");
    assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(url.searchParams.get("ext_agent_host_id"), "urn:uuid:fixture");
    assert.ok(url.searchParams.get("scope").includes("chatgpt.tokens.use.direct"));
    assert.equal((await account.directory.public()).activeAccountId, "primary");
    const completion = account.attempt.done;
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({
      state: url.searchParams.get("state"),
      code: "fixture-code",
      client_id: "fixture-issued",
    }).toString();
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await completion;
    const status = await account.directory.public();
    assert.equal(status.activeAccountId, "primary");
    const saved = status.accounts.find((entry) => entry.id !== "primary");
    assert.equal(saved.state, "saved");
    assert.equal(saved.email, "same@fixture.invalid");
    assert.equal(await account.accessToken(), "fixture-old-access");
    await account.selectAccount(saved.id);
    assert.equal(await account.accessToken(), "fixture-new-access");
    assert.equal(
      (await account.directory.view("primary").readRecord()).payload.clientId,
      "fixture-old",
    );
  } finally {
    await account.close();
  }
});
