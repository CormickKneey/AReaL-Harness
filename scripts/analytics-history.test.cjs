"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { resolve, dirname } = require("node:path");
const { once } = require("node:events");
const analyticsPath =
  require.resolve("../clients/gui/app/src/core/analytics.cjs");
const appRequire = createRequire(analyticsPath);
const { UsageAnalytics } = appRequire(analyticsPath);
const { WebSocket, WebSocketServer } = appRequire("ws");
const clientModule = import(
  pathToFileURL(
    resolve(
      dirname(analyticsPath),
      "../../node_modules/@areal/runtime-client/core.js",
    ),
  )
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, respond, handshake) {
  const { CoreClient } = await clientModule;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const sockets = [];
  const methods = [];
  server.on("connection", (socket, request) => {
    sockets.push(socket);
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      methods.push(message.method);
      const reply = (result) =>
        socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === "initialize") {
        if (sockets.length > 1 && handshake)
          handshake({ socket, message, reply });
        else reply({});
      } else if (message.method === "areal/capabilities") reply({});
      else if (message.method === "thread/read")
        respond({ socket, message, reply, primary: sockets[0] });
    });
  });
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  const primary = new CoreClient({
    createSocket: () =>
      new WebSocket(endpoint, {
        headers: { Authorization: "Bearer fixture-token" },
        followRedirects: false,
        maxPayload: 4 * 1024 * 1024,
      }),
  });
  await primary.connect();
  const project = {
    id: "project",
    client: primary,
    endpoint,
    token: "fixture-token",
    service: { serviceId: "service", generation: "generation" },
    model: { connected: false },
    summaries: [{ id: "history" }],
  };
  const backend = {
    projects: new Map([[project.id, project]]),
    closing: false,
    save: async () => {},
  };
  const analytics = new UsageAnalytics(backend);
  t.after(async () => {
    primary.close();
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    primary,
    project,
    backend,
    analytics,
    sockets,
    methods,
    CoreClient,
  };
}
test("oversized analytics history keeps the primary ready and retains cached usage", async (t) => {
  const f = await fixture(t, ({ reply }) =>
    reply({
      thread: {
        id: "history",
        turns: [],
        padding: "x".repeat(4 * 1024 * 1024),
      },
    }),
  );
  f.analytics.ingest("project", {
    id: "cached",
    turns: [{ id: "turn", usage: { inputTokens: 7, outputTokens: 3 } }],
  });
  await f.analytics.syncProject(f.project);
  assert.equal(f.primary.ready, true);
  assert.equal(f.primary.closed, false);
  assert.equal(f.analytics.summary().tokens, 10);
  assert.match(f.analytics.summary().error, /部分历史/);
  assert.equal(f.sockets.length, 2);
  await tick();
  assert.equal(f.primary.closeListeners.size, 0);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const history = {
  id: "history",
  turns: [
    {
      id: "turn",
      usage: { inputTokens: 20, outputTokens: 5 },
      items: [
        {
          id: "skill",
          type: "dynamicToolCall",
          tool: "skill_read",
          status: "completed",
          success: true,
          arguments: { skill: { id: "example" } },
        },
      ],
    },
  ],
};
async function readerClosed(f) {
  if (f.sockets[1]?.readyState !== WebSocket.CLOSED)
    await once(f.sockets[1], "close");
  assert.equal(f.primary.closeListeners.size, 0);
  assert.equal(f.analytics.summary().syncing, false);
}
test("startup sync reads undated usage once and preserves live dates and skill deduplication", async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, async ({ reply }) => {
    entered.resolve();
    await release.promise;
    reply({ thread: history });
  });
  f.analytics.observe("project", "turn/completed", {
    threadId: "history",
    turn: history.turns[0],
  });
  const date = Object.values(f.analytics.value.turns)[0].date;
  const first = f.analytics.syncProject(f.project);
  await entered.promise;
  f.project.summaries.push({ id: "added-after-capture" });
  const second = f.analytics.syncProject(f.project);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(f.project.model.connected, false);
  assert.equal(f.analytics.summary().tokens, 25);
  assert.equal(f.analytics.summary().skillCalls, 1);
  assert.equal(Object.values(f.analytics.value.turns)[0].date, date);
  assert.equal(f.analytics.summary().error, null);
  assert.equal(f.sockets.length, 2);
  assert.deepEqual(f.methods, [
    "initialize",
    "initialized",
    "areal/capabilities",
    "initialize",
    "initialized",
    "areal/capabilities",
    "thread/read",
  ]);
  await readerClosed(f);
  f.project.summaries = [{ id: "history" }];
  const undated = new UsageAnalytics(f.backend);
  await undated.syncProject(f.project);
  assert.equal(undated.summary().undatedTokens, 25);
  assert.equal(undated.summary().undatedSkills, 1);
});
for (const identity of [
  "project",
  "client",
  "endpoint",
  "token",
  "serviceId",
  "generation",
]) {
  test(`changed ${identity} fences in-flight history and preserves the prior sync error`, async (t) => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture(t, async ({ reply }) => {
      entered.resolve();
      await release.promise;
      reply({ thread: history });
    });
    f.analytics.syncErrors.set("project", "previous failure");
    const sync = f.analytics.syncProject(f.project);
    await entered.promise;
    let replacement;
    if (identity === "project")
      f.backend.projects.set("project", { ...f.project });
    else if (identity === "client") {
      replacement = new f.CoreClient({
        createSocket: () =>
          new WebSocket(f.project.endpoint, {
            headers: { Authorization: "Bearer fixture-token" },
          }),
      });
      await replacement.connect();
      f.project.client = replacement;
      t.after(() => replacement.close());
    } else if (["serviceId", "generation"].includes(identity))
      f.project.service[identity] = "changed";
    else f.project[identity] = "changed";
    release.resolve();
    await sync;
    assert.equal(f.analytics.summary().tokens, 0);
    assert.equal(f.analytics.summary().error, "previous failure");
    assert.equal(f.primary.ready, true);
    if (replacement) assert.equal(replacement.ready, true);
    await readerClosed(f);
  });
}
test("a later oversized history retains already ingested usage as partial", async (t) => {
  const f = await fixture(t, ({ message, reply }) =>
    reply({
      thread:
        message.params.threadId === "history"
          ? history
          : { padding: "x".repeat(4 * 1024 * 1024) },
    }),
  );
  f.project.summaries.push({ id: "oversized" });
  await f.analytics.syncProject(f.project);
  assert.equal(f.analytics.summary().tokens, 25);
  assert.match(f.analytics.summary().error, /部分历史/);
  assert.equal(f.primary.ready, true);
  await readerClosed(f);
});
for (const stage of ["handshake", "read"]) {
  test(`${stage} timeout releases the reader without closing the primary`, async (t) => {
    const f = await fixture(
      t,
      () => {},
      stage === "handshake" ? () => {} : undefined,
    );
    const original = f.CoreClient.prototype.connect;
    t.mock.method(f.CoreClient.prototype, "connect", function () {
      // 使用现有客户端期限边界缩短 fixture 等待，不改变生产默认值。
      this.timeoutMs = 25;
      return original.call(this);
    });
    await f.analytics.syncProject(f.project);
    assert.match(f.analytics.summary().error, /部分历史/);
    assert.equal(f.primary.ready, true);
    await readerClosed(f);
  });
}
test("history RPC error releases the reader and retains partial status", async (t) => {
  const f = await fixture(t, ({ socket, message }) =>
    socket.send(
      JSON.stringify({
        id: message.id,
        error: { code: -1, message: "fixture failure" },
      }),
    ),
  );
  await f.analytics.syncProject(f.project);
  assert.match(f.analytics.summary().error, /部分历史/);
  assert.equal(f.primary.ready, true);
  await readerClosed(f);
});
test("primary close during module import opens no reader", async (t) => {
  const f = await fixture(t, ({ reply }) => reply({ thread: history }));
  const sync = f.analytics.syncProject(f.project);
  f.primary.close();
  await sync;
  assert.equal(f.sockets.length, 1);
  assert.equal(f.primary.closeListeners.size, 0);
  assert.equal(f.analytics.summary().tokens, 0);
  assert.match(f.analytics.summary().error, /部分历史/);
});
for (const stage of ["handshake", "read", "backend exit"]) {
  test(`primary close during ${stage} interrupts the reader and releases its listener`, async (t) => {
    const entered = deferred();
    const f = await fixture(
      t,
      () => entered.resolve(),
      stage === "handshake" ? () => entered.resolve() : undefined,
    );
    const sync = f.analytics.syncProject(f.project);
    await entered.promise;
    if (stage === "backend exit") f.backend.closing = true;
    f.primary.close();
    await sync;
    assert.equal(f.analytics.summary().tokens, 0);
    assert.match(f.analytics.summary().error, /部分历史/);
    await readerClosed(f);
  });
}

test("primary close after partial history keeps ingested counts and reports incomplete sync", async (t) => {
  const waiting = deferred();
  const f = await fixture(t, ({ message, reply }) => {
    if (message.params.threadId === "history") reply({ thread: history });
    else waiting.resolve();
  });
  f.project.summaries.push({ id: "waiting" });
  const sync = f.analytics.syncProject(f.project);
  await waiting.promise;
  f.primary.close();
  await sync;
  assert.equal(f.analytics.summary().tokens, 25);
  assert.equal(f.analytics.summary().skillCalls, 1);
  assert.match(f.analytics.summary().error, /部分历史/);
  await readerClosed(f);
});
