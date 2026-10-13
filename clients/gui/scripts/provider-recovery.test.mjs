import test from "node:test";
import assert from "node:assert/strict";
import { ChatGPTAccount } from "../packages/chatgpt-provider/account.js";
import { AppProviders } from "../app/src/core/providers.cjs";

function fixture(oauth) {
  let record = {
    kind: "grant",
    payload: {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 0,
      accountId: "fixture-account",
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
    deleteRecord: async () => {
      record = undefined;
    },
  };
  return {
    store,
    account: new ChatGPTAccount(store, { oauth }),
    get record() {
      return record;
    },
  };
}

test("temporary refresh failure shares one attempt and preserves the grant", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    throw new TypeError("fixture network");
  });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => f.account.accessToken()),
  );
  assert.equal(calls, 1);
  assert.ok(
    results.every((r) => r.status === "rejected" && r.reason.state === "temporarily_unavailable"),
  );
  assert.equal(f.record.kind, "grant");
  assert.equal((await f.account.status()).state, "temporarily_unavailable");
});

test("terminal refresh error retains registration and stops using tokens", async () => {
  const f = fixture(async () => {
    throw Object.assign(new Error("secret upstream text"), {
      code: "invalid_grant",
      phase: "refresh",
    });
  });
  await assert.rejects(
    f.account.accessToken(),
    (e) => e.state === "reauth_required" && !e.message.includes("secret"),
  );
  assert.equal(f.record.kind, "registration");
  assert.equal(f.record.payload.access, undefined);
  assert.equal((await f.account.status()).state, "reauth_required");
});

test("cancelled initiating request still persists a rotation for concurrent waiters", async () => {
  let finish,
    calls = 0;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(async (_action, { credential }) => {
    calls++;
    await wait;
    return {
      ...credential,
      access: "rotated",
      refresh: "rotated-refresh",
      expires: Date.now() + 3600000,
    };
  });
  const controller = new AbortController();
  const cancelled = f.account.accessToken(controller.signal);
  const live = f.account.accessToken();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  finish();
  await assert.rejects(cancelled);
  assert.equal(await live, "rotated");
  assert.equal(f.record.payload.refresh, "rotated-refresh");
  assert.equal(calls, 1);
});

test("locked storage is diagnosable without reporting logout", async () => {
  const f = fixture(async () => assert.fail("must not refresh"));
  f.store.readRecord = async () => {
    throw Object.assign(new Error("fixture storage"), { code: "storage_locked" });
  };
  const status = await f.account.status();
  assert.equal(status.state, "storage_locked");
  assert.equal(status.authenticated, false);
  assert.equal(status.diagnostic.code, "storage_locked");
});

function providers() {
  const service = new AppProviders({ onChange() {} }, {});
  service.config.value = {
    revision: "fixture",
    data: [
      {
        id: "fixture",
        name: "Gateway",
        endpoint: "https://fixture.invalid/v1/responses",
        protocol: "responses",
        models: [{ id: "m", parameters: { contextWindowTokens: 131072 } }],
        parameters: { contextWindowTokens: 200000 },
        enabled: true,
      },
    ],
  };
  service.config.current = async () => service.config.value;
  service.config.execute = async (_op, next) => ({ ...next, revision: "next" });
  service.config.public = () => service.config.value;
  return service;
}
test("provider save preserves Core context budgets and rejects unknown parameters", async () => {
  const service = providers();
  const provider = {
    ...service.value.data[0],
    name: "Renamed",
    baseUrl: "https://fixture.invalid/v1",
    protocol: "responses",
  };
  await service.command({ operation: "save", expectedRevision: "fixture", provider });
  assert.equal(service.value.data[0].parameters.contextWindowTokens, 200000);
  assert.equal(service.value.data[0].models[0].parameters.contextWindowTokens, 131072);
  const invalid = providers();
  await assert.rejects(
    invalid.command({
      operation: "save",
      expectedRevision: "fixture",
      provider: { ...provider, parameters: { unknown: 1 } },
    }),
    /参数/,
  );
});

test("rotation write failure retries the new token without a second exchange", async () => {
  let calls = 0;
  const f = fixture(async (_action, { credential }) => {
    calls++;
    return {
      ...credential,
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 3600000,
    };
  });
  const modify = f.store.modifyRecord.bind(f.store);
  let fail = true;
  f.store.modifyRecord = (key, mutate) =>
    modify(key, async (current) => {
      const next = await mutate(current);
      if (fail) {
        fail = false;
        throw Object.assign(new Error("fixture disk full"), { code: "storage_write_failed" });
      }
      return next;
    });
  await assert.rejects(f.account.accessToken(), (e) => e.state === "storage_locked");
  assert.equal(f.record.payload.refresh, "fixture-refresh");
  assert.equal(await f.account.accessToken(), "next-access");
  assert.equal(calls, 1);
  assert.equal(f.record.payload.refresh, "next-refresh");
  const restarted = new ChatGPTAccount(f.store, {
    oauth: async () => assert.fail("saved token should be fresh"),
  });
  assert.equal(await restarted.accessToken(), "next-access");
});

test("restarted terminal session still requires reauthorization", async () => {
  const f = fixture(async () => {
    throw Object.assign(new Error("fixture"), { code: "refresh_token_reused" });
  });
  await assert.rejects(f.account.accessToken());
  const restarted = new ChatGPTAccount(f.store, {
    oauth: async () => assert.fail("terminal grant must not be reused"),
  });
  assert.equal((await restarted.status()).state, "reauth_required");
});

import { CoreSubscription } from "../packages/chatgpt-provider/core.js";
import { responseError, safeRefresh } from "../packages/chatgpt-provider/errors.js";
const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const successStream = () =>
  new Response(
    event({ type: "response.output_text.delta", delta: "OK" }) +
      event({
        type: "response.completed",
        response: { status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1 } },
      }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
async function relay(t, inference, catalog) {
  let refreshes = 0,
    sends = 0,
    catalogCalls = 0;
  const f = fixture();
  await f.store.modifyRecord("", (current) => ({
    ...current,
    payload: {
      ...current.payload,
      clientId: "fixture-client",
      subject: "fixture-account",
      hostId: "urn:uuid:fixture",
      issuer: "https://auth.openai.com",
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
      expires: Date.now() + 3600000,
    },
  }));
  const audits = [];
  const service = new CoreSubscription({
    store: f.store,
    token: "fixture-loopback",
    kind: "openai",
    onRequest: (audit) => audits.push(audit),
    fetch: async (url, options) => {
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/keys",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (url.endsWith("/token")) {
        refreshes++;
        return Response.json({
          token_type: "bearer",
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
          scope: "resource.invoke chatgpt.tokens.use.direct",
        });
      }
      if (url.endsWith("/models"))
        return catalog
          ? catalog(++catalogCalls, options)
          : Response.json({
              models: [{ slug: "fixture-model", display_name: "Fixture", visibility: "list" }],
            });
      assert.equal(url, "https://api.openai.com/v1/responses");
      sends++;
      return inference({ sends, options });
    },
  });
  t.after(() => service.close());
  await service.discover();
  await service.ready();
  const send = () =>
    fetch(service.endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer fixture-loopback", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", input: [], stream: true }),
    });
  return {
    service,
    send,
    audits,
    get sends() {
      return sends;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

test("inference token rejection is diagnosed without automatic POST replay", async (t) => {
  const f = await relay(t, () =>
    Response.json(
      { error: { code: "invalid_token", message: "fixture-secret-text" } },
      { status: 401 },
    ),
  );
  const response = await f.send();
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_token");
  assert.equal(f.sends, 1);
  assert.equal(f.refreshes, 0);
});

for (const [status, body, state] of [
  [401, { detail: "fixture-secret-text" }, "temporarily_unavailable"],
  [
    403,
    { error: { code: "subscription_sharing_user_not_eligible", message: "fixture-secret-text" } },
    "permission_denied",
  ],
  [429, { error: { code: "subscription_sharing_usage_limit_exceeded" } }, "quota_exceeded"],
  [503, { error: { code: "subscription_sharing_usage_unavailable" } }, "temporarily_unavailable"],
])
  test(`admission ${status} preserves credentials without replay or billing fallback`, async (t) => {
    const f = await relay(t, () =>
      Response.json(body, { status, headers: { "x-request-id": "fixture-request" } }),
    );
    const response = await f.send();
    const text = await response.text();
    assert.equal(response.status, status);
    assert.equal(JSON.parse(text).error.state, state);
    assert.ok(!text.includes("fixture-secret-text") && !text.includes("fixture-access"));
    assert.equal(f.sends, 1);
    assert.equal(f.refreshes, 0);
    assert.equal((await f.service.account.status()).authenticated, true);
    assert.equal(f.audits[0].requestId, "fixture-request");
  });

test("accepted or partial response never qualifies for replay", async () => {
  const error = await responseError(
    Response.json({ id: "resp_fixture", error: { code: "invalid_token" } }, { status: 401 }),
    "admission",
  );
  assert.equal(safeRefresh(error), false);
});

test("terminal forced refresh plus failed persistence cannot revive a still-fresh old grant", async () => {
  let exchanges = 0;
  const f = fixture(async () => {
    exchanges++;
    throw Object.assign(new Error("fixture terminal"), { code: "invalid_grant" });
  });
  await f.store.modifyRecord("", (record) => ({
    ...record,
    payload: { ...record.payload, expires: Date.now() + 3600000 },
  }));
  const modify = f.store.modifyRecord.bind(f.store);
  let writes = 0;
  f.store.modifyRecord = (key, mutate) =>
    modify(key, async (current) => {
      const next = await mutate(current);
      if (++writes === 1)
        throw Object.assign(new Error("fixture disk failure"), { code: "storage_write_failed" });
      return next;
    });
  await assert.rejects(
    f.account.accessToken(undefined, { force: true, rejectedToken: "fixture-access" }),
    (error) => error.state === "storage_locked",
  );
  assert.equal(f.record.kind, "grant");
  await assert.rejects(f.account.accessToken(), (error) => error.state === "reauth_required");
  assert.equal(f.record.kind, "registration");
  assert.equal(f.record.payload.access, undefined);
  assert.equal(exchanges, 1);
  assert.equal((await f.account.status()).state, "reauth_required");
});

test("status to Core sync retains provider while refreshing or storage is locked", async () => {
  let finish;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(async (_action, { credential }) => {
    await wait;
    return { ...credential, expires: Date.now() + 3600000 };
  });
  const calls = [];
  const app = new AppProviders({ submit: async (...args) => calls.push(args) }, {});
  const project = {
    client: {
      request: async () => ({
        data: [{ id: "areal_openai", revision: 1, models: ["fixture-model"] }],
      }),
    },
  };
  const service = { id: "areal_openai", account: f.account, models: [], ready: async () => {} };
  const rotation = f.account.accessToken();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.account.status()).state, "refreshing");
  await app.applySubscription(project, service);
  assert.deepEqual(calls, []);
  finish();
  await rotation;
  f.store.readRecord = async () => {
    throw Object.assign(new Error("fixture lock"), { code: "storage_locked" });
  };
  assert.equal((await f.account.status()).state, "storage_locked");
  await app.applySubscription(project, service);
  assert.deepEqual(calls, []);
});

test("Core sync removes subscription only on explicit sign-out or confirmed empty ready catalog", async () => {
  const calls = [];
  const app = new AppProviders({ submit: async (_project, method) => calls.push(method) }, {});
  const project = {
    client: { request: async () => ({ data: [{ id: "areal_openai", revision: 1 }] }) },
  };
  for (const status of [
    { state: "signed_out", authenticated: false },
    { state: "ready", authenticated: true, models: [] },
  ]) {
    await app.applySubscription(project, {
      id: "areal_openai",
      account: { status: async () => status },
    });
  }
  assert.deepEqual(calls, ["areal/provider/remove", "areal/provider/remove"]);
});

test("partial SSE followed by transport failure is not replayed or billed elsewhere", async (t) => {
  const f = await relay(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                event({ type: "response.output_text.delta", delta: "partial fixture" }),
              ),
            );
            setTimeout(() => controller.error(new Error("fixture stream disconnect")), 25);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const response = await f.send();
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
  assert.equal(f.sends, 1);
  assert.equal(f.refreshes, 0);
});

test("stream EOF alone is not accepted as a successful connection probe", async (t) => {
  const f = await relay(
    t,
    () =>
      new Response(event({ type: "response.output_text.delta", delta: "partial fixture" }), {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  await assert.rejects(f.service.probe("fixture-model"), /未完成/);
  assert.equal(f.sends, 1);
  assert.equal(f.refreshes, 0);
  assert.equal(f.audits[0].outcome, "forwarded");
});

for (const recover of [true, false])
  test(`catalog GET refreshes once and ${recover ? "recovers" : "stops on second 401"}`, async (t) => {
    let calls = 0;
    const models = () => Response.json({ models: [{ slug: "fixture-model", visibility: "list" }] });
    const f = await relay(
      t,
      () => successStream(),
      () => {
        calls++;
        return calls === 1 || (recover && calls === 3)
          ? models()
          : Response.json({ error: { code: "invalid_token" } }, { status: 401 });
      },
    );
    f.service.catalogExpires = 0;
    if (f.service.catalog) f.service.catalog.expiresAt = 0;
    if (recover) {
      await f.service.discover({ force: true });
      const response = await f.send();
      assert.equal(response.status, 200);
      assert.match(await response.text(), /input_tokens/);
    } else {
      await assert.rejects(f.service.discover({ force: true }));
      assert.deepEqual(f.service.models, []);
    }
    assert.equal(calls, 3);
    assert.equal(f.refreshes, 1);
    assert.equal(f.sends, recover ? 1 : 0);
  });
