import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { BrowserState } from "../renderer/remote-web/browser-state.mjs";
import { CommandState } from "../renderer/remote-web/command-state.mjs";
import { acceptSessionMessage } from "../renderer/remote-web/session-state.mjs";

const source = await readFile(new URL("../renderer/remote-web/main.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  for (let n = 0; n < 80; n++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), "production page did not reach expected state");
}
function sessionStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function events() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) ?? [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) ?? []) callback(event);
    },
  };
}
class Element {
  children = [];
  dataset = {};
  style = {};
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  #text = "";
  constructor(tag) {
    this.tag = tag;
    this.attributes = new Map();
    Object.assign(this, events());
  }
  set textContent(value) {
    this.#text = value;
    this.children = [];
  }
  get textContent() {
    return this.#text;
  }
  append(...values) {
    this.children.push(...values);
  }
  replaceChildren(...values) {
    this.children = values;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  click() {
    if (!this.disabled) this.dispatchEvent({ type: "click" });
  }
}
function inbox() {
  const incoming = [],
    waiting = [];
  let done = false;
  return {
    push(value) {
      if (done) return;
      waiting.length ? waiting.shift()({ value, done: false }) : incoming.push(value);
    },
    close() {
      done = true;
      for (const resolve of waiting.splice(0)) resolve({ done: true });
    },
    next() {
      return incoming.length
        ? Promise.resolve({ value: incoming.shift(), done: false })
        : done
          ? Promise.resolve({ done: true })
          : new Promise((resolve) => waiting.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
function page({
  db = new IDBFactory(),
  drafts = sessionStorage(),
  hash = "#host=host",
  makeIdentity = async () => "identity",
  beforeSecure,
  ready = {},
  onCall,
} = {}) {
  const elements = new Map(),
    calls = [],
    sockets = [],
    wireOptions = [],
    timers = new Set(),
    scheduled = new Map(),
    intervals = new Set();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element("work-filter").value = "all";
  const window = events();
  const document = {
    ...events(),
    hidden: false,
    body: new Element("body"),
    getElementById: element,
    createElement: (tag) => new Element(tag),
  };
  const location = {
    hash,
    pathname: "/remote.html",
    origin: "http://localhost",
    protocol: "http:",
    host: "localhost",
    href: "http://localhost/remote.html" + hash,
  };
  const navigator = { onLine: true };
  const reply = (call, result) => call.messages.push({ id: call.id, result });
  let nextConnection = 0;
  function transport(socket) {
    const messages = inbox();
    socket.messages = messages;
    const connectionId = `connection-${++nextConnection}`;
    return {
      messages: () => messages,
      send(value) {
        const call = { ...value, messages, connectionId };
        calls.push(call);
        if (onCall?.(call, reply)) return;
        if (call.method === "hello")
          messages.push({
            event: "ready",
            hostId: "host",
            connectionId,
            gatewayGeneration: "gateway",
            grantRevision: 1,
            capabilities: ["observe", "submit", "interrupt", "answer"],
            limits: { applicationMessageBytes: 262144 },
            ...ready,
          });
        if (call.method === "project.list")
          reply(call, {
            projects: [{ projectId: "project", name: "Project", connectionState: "online" }],
          });
        if (call.method === "work.list")
          reply(call, {
            data: [
              {
                kind: "thread",
                threadId: "thread",
                title: "Session",
                execution: { state: "idle" },
                attentionCount: 0,
                attentionComplete: true,
                attentionRefs: [],
                queue: { pendingCount: 0 },
              },
            ],
            complete: true,
            serviceGeneration: "service",
          });
        if (call.method === "subscription.close") reply(call, {});
        if (call.method === "session.open")
          reply(call, {
            projectId: "project",
            connectionId,
            gatewayGeneration: "gateway",
            serviceGeneration: "service",
            subscriptionId: `sub-${calls.length}`,
            sequence: 0,
            snapshot: {
              threadId: call.params.threadId,
              title: "Session",
              status: "idle",
              configRevision: 7,
              ownership: { kind: "ordinary" },
              turns: [],
              attentionRefs: [],
              queue: { pendingCount: 0, paused: false },
              history: { hasMore: false },
            },
          });
      },
    };
  }
  class Socket {
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        if (!this.closed) this.onopen?.();
      });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.messages?.close();
      this.onclose?.();
    }
  }
  const context = createContext({
    document,
    window,
    location,
    navigator,
    history: {
      replaceState() {
        location.hash = "";
      },
    },
    Event,
    TextEncoder,
    URL,
    URLSearchParams,
    crypto,
    structuredClone,
    CommandState,
    acceptSessionMessage,
    BrowserState: class extends BrowserState {
      constructor(options) {
        super({ ...options, indexedDB: db, sessionStorage: drafts, channel: null });
      }
    },
    createIdentity: makeIdentity,
    identityId: (key) => `peer-${key}`,
    WebSocket: Socket,
    createRemoteWire: (socket, options) => {
      wireOptions.push(options);
      return {
        wire: { close() {}, receive() {} },
        ready: new Promise((resolve, reject) => {
          socket.onopen = resolve;
          socket.onerror = () => reject(new Error("Host 暂不可用，请检查连接"));
        }),
      };
    },
    remoteLocator: (fragment) => ({ host: fragment.get("host"), room: fragment.get("room") }),
    publicLocator: (locator) =>
      new URLSearchParams(Object.entries(locator).filter(([, value]) => value)).toString(),
    secureChannel: async () => {
      const socket = sockets.at(-1);
      await beforeSecure?.();
      return transport(socket);
    },
    setTimeout(callback, delay) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        scheduled.delete(timer);
        callback();
      }, delay);
      timer.unref();
      timers.add(timer);
      scheduled.set(timer, { callback, delay });
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
      timers.delete(timer);
      scheduled.delete(timer);
    },
    setInterval(callback, delay) {
      const timer = setInterval(callback, delay);
      timer.unref();
      intervals.add(timer);
      return timer;
    },
    clearInterval(timer) {
      clearInterval(timer);
      intervals.delete(timer);
    },
  });
  runInContext(source.replace(/^import[\s\S]*?;\n/gm, ""), context);
  return {
    db,
    drafts,
    element,
    calls,
    sockets,
    wireOptions,
    window,
    document,
    navigator,
    reply,
    advanceTimers(elapsed) {
      const due = [...scheduled].filter(([, value]) => value.delay <= elapsed);
      for (const [timer, value] of due) {
        clearTimeout(timer);
        timers.delete(timer);
        scheduled.delete(timer);
        value.callback();
      }
      return due.length;
    },
    async dispose() {
      window.dispatchEvent({ type: "pagehide" });
      for (const socket of sockets) socket.close();
      for (const timer of timers) clearTimeout(timer);
      for (const timer of intervals) clearInterval(timer);
      await tick();
    },
  };
}
async function remember(db, drafts, room = null) {
  const state = new BrowserState({
    createIdentity: async () => "identity",
    identityId: (key) => `peer-${key}`,
    indexedDB: db,
    sessionStorage: drafts,
    channel: null,
  });
  const token = await state.remember(
    await state.prepareRemember(await state.guest()),
    "host",
    room,
  );
  return { state, token };
}

test("production reload restores remembered pin and only queries original unknown commands", async () => {
  const db = new IDBFactory(),
    drafts = sessionStorage();
  const { state, token } = await remember(db, drafts);
  await state.persistLocator(token, {
    hostId: "host",
    projectId: "project",
    commandId: "original",
    method: "session.send",
    params: { threadId: "thread", text: "not persisted" },
  });
  const p = page({ db, drafts, hash: "" });
  try {
    await until(() => p.calls.some((call) => call.method === "command.read"));
    assert.equal(p.calls.filter((call) => call.method === "hello").length, 1);
    assert.equal(
      p.calls.find((call) => call.method === "command.read").params.commandId,
      "original",
    );
    assert.equal(
      p.calls.some((call) =>
        ["session.send", "session.create", "turn.stop", "interaction.respond"].includes(
          call.method,
        ),
      ),
      false,
    );
    assert.match(p.element("device-storage").textContent, /已记住/);
  } finally {
    await p.dispose();
    state.close();
  }
});

function writeGate(db) {
  const originalOpen = db.open.bind(db);
  let armed = false,
    held = false,
    started = false,
    abortNext = false,
    quotaNext = false;
  db.open = (...args) => {
    const request = originalOpen(...args);
    request.addEventListener("success", () => {
      const database = request.result,
        transaction = database.transaction.bind(database);
      database.transaction = (...args) => {
        const tx = transaction(...args),
          objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const store = objectStore(name),
            put = store.put.bind(store);
          store.put = (...args) => {
            if (quotaNext) {
              quotaNext = false;
              throw new DOMException("fixture quota", "QuotaExceededError");
            }
            const result = put(...args);
            if (abortNext) {
              abortNext = false;
              result.addEventListener("success", () => tx.abort());
            }
            if (armed) {
              armed = false;
              held = true;
              const keepAlive = () => {
                if (held) {
                  const pending = store.get("keep-alive-fixture");
                  pending.onsuccess = keepAlive;
                }
              };
              result.addEventListener("success", () => {
                started = true;
                keepAlive();
              });
            }
            return result;
          };
          return store;
        };
        return tx;
      };
    });
    return request;
  };
  return {
    quota() {
      quotaNext = true;
    },
    abort() {
      abortNext = true;
    },
    arm() {
      armed = true;
      started = false;
    },
    release() {
      held = false;
    },
    started: () => started,
  };
}
test("production remembered submission waits for transaction commit before transport send", async () => {
  const db = new IDBFactory(),
    gate = writeGate(db);
  const p = page({ db });
  try {
    await until(() => !p.element("connect").disabled);
    p.element("remember-device").checked = true;
    p.element("connect").click();
    await until(() => !p.element("session-create").disabled);
    gate.arm();
    p.element("session-create").click();
    await until(gate.started);
    assert.equal(
      p.calls.some((call) => call.method === "session.create"),
      false,
    );
    gate.release();
    await until(() => p.calls.some((call) => call.method === "session.create"));
    const sent = p.calls.find((call) => call.method === "session.create");
    assert.equal(sent.context.projectId, "project");
    const storage = new BrowserState({
      createIdentity: async () => "unused",
      identityId: (key) => `peer-${key}`,
      indexedDB: db,
      channel: null,
    });
    const restored = await storage.restore();
    assert.equal((await storage.locators(restored))[0].commandId, sent.commandId);
    storage.close();
  } finally {
    gate.release();
    await p.dispose();
  }
});

async function connectedPage(options = {}) {
  const p = page(options);
  await until(() => !p.element("connect").disabled);
  p.element("remember-device").checked = true;
  p.element("connect").click();
  await until(() => !p.element("session-create").disabled);
  return p;
}
function openThread(p) {
  p.element("work-items")
    .children[0].children.find((child) => child.textContent === "打开会话")
    .click();
}
test("forget fences a held locator transaction and cannot dispatch or resurrect credentials", async () => {
  const db = new IDBFactory(),
    gate = writeGate(db),
    p = await connectedPage({ db });
  try {
    gate.arm();
    p.element("session-create").click();
    await until(gate.started);
    p.element("forget-device").click();
    assert.equal(p.element("session-create").disabled, true);
    gate.release();
    await until(() => /已清除此/.test(p.element("status").textContent));
    assert.equal(
      p.calls.some((call) => call.method === "session.create"),
      false,
    );
    assert.equal(
      p.sockets.every((socket) => socket.closed),
      true,
    );
    const fresh = new BrowserState({
      createIdentity: async () => "unused",
      identityId: (key) => `peer-${key}`,
      indexedDB: db,
      channel: null,
    });
    assert.equal(await fresh.restore(), null);
    fresh.close();
  } finally {
    gate.release();
    await p.dispose();
  }
});
test("transaction failure prevents dispatch and leaves the user's draft in memory", async () => {
  const db = new IDBFactory(),
    gate = writeGate(db),
    p = await connectedPage({ db });
  try {
    openThread(p);
    await until(() => p.element("session-title").textContent === "Session");
    p.element("session-draft").value = "do not lose this";
    p.element("session-draft").dispatchEvent({ type: "input" });
    gate.abort();
    p.element("session-send").click();
    await until(() => /本次未发送/.test(p.element("send-command-state").textContent));
    assert.equal(
      p.calls.some((call) => call.method === "session.send"),
      false,
    );
    assert.equal(p.element("session-draft").value, "do not lose this");
  } finally {
    await p.dispose();
  }
});
test("navigation during locator commit keeps the original target and sends nothing", async () => {
  const db = new IDBFactory(),
    gate = writeGate(db),
    p = await connectedPage({ db });
  try {
    openThread(p);
    await until(() => p.element("session-title").textContent === "Session");
    p.element("session-draft").value = "original target";
    p.element("session-draft").dispatchEvent({ type: "input" });
    gate.arm();
    p.element("session-send").click();
    await until(gate.started);
    p.element("session-close").click();
    gate.release();
    await until(() => /页面或连接已变化/.test(p.element("storage-error").textContent));
    assert.equal(
      p.calls.some((call) => call.method === "session.send"),
      false,
    );
    const reader = new BrowserState({
      createIdentity: async () => "unused",
      identityId: (key) => `peer-${key}`,
      indexedDB: db,
      channel: null,
    });
    assert.deepEqual(await reader.locators(await reader.restore()), []);
    reader.close();
  } finally {
    gate.release();
    await p.dispose();
  }
});
test("late identity generation and Noise completion cannot restore a forgotten page", async () => {
  let resolveIdentity;
  const first = page({
    makeIdentity: () =>
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
  });
  try {
    await until(() => !first.element("connect").disabled);
    first.element("connect").click();
    await until(() => Boolean(resolveIdentity));
    first.element("forget-device").click();
    resolveIdentity("obsolete");
    for (let n = 0; n < 10; n++) await tick();
    assert.equal(first.calls.length, 0);
    assert.equal(first.element("device").textContent, "");
  } finally {
    await first.dispose();
  }
  let releaseNoise;
  const second = page({
    beforeSecure: () =>
      new Promise((resolve) => {
        releaseNoise = resolve;
      }),
  });
  try {
    await until(() => !second.element("connect").disabled);
    second.element("connect").click();
    await until(() => Boolean(releaseNoise));
    second.element("forget-device").click();
    releaseNoise();
    for (let n = 0; n < 10; n++) await tick();
    assert.equal(
      second.calls.some((call) => call.method === "hello"),
      false,
    );
    assert.equal(second.element("host").textContent, "");
  } finally {
    await second.dispose();
  }
});
test("reload recovers opted-in tab draft without sending or erasing it from an unrelated receipt", async () => {
  const db = new IDBFactory(),
    drafts = sessionStorage();
  const { state, token } = await remember(db, drafts);
  state.setDraftPersistence(token, true);
  state.saveDraft(token, "project", "thread", "draft at reload");
  await state.persistLocator(token, {
    hostId: "host",
    projectId: "project",
    commandId: "old-send",
    method: "session.send",
    params: { threadId: "thread", text: "discarded body" },
  });
  const p = page({ db, drafts, hash: "" });
  try {
    await until(() => p.calls.some((call) => call.method === "command.read"));
    openThread(p);
    await until(() => p.element("session-draft").value === "draft at reload");
    const query = p.calls.find((call) => call.method === "command.read");
    p.reply(query, {
      commandId: "old-send",
      admissionState: "accepted",
      threadId: "thread",
      turnId: "turn",
    });
    await until(() => /已受理/.test(p.element("send-command-state").textContent));
    assert.equal(p.element("session-draft").value, "draft at reload");
    assert.equal(
      p.calls.some((call) => call.method === "session.send"),
      false,
    );
    assert.equal(state.drafts(token).values[0].text, "draft at reload");
  } finally {
    await p.dispose();
    state.close();
  }
});
test("a different invitation Host never replaces the remembered pin", async () => {
  const db = new IDBFactory();
  const { state, token } = await remember(db);
  const p = page({ db, hash: "#host=other&invite=" + "a".repeat(64) });
  try {
    await until(() => /Host.*不同/.test(p.element("status").textContent));
    p.element("connect").click();
    await tick();
    assert.equal(p.calls.length, 0);
    assert.equal(state.current().hostId, "host");
    assert.equal(token.hostId, "host");
  } finally {
    await p.dispose();
    state.close();
  }
});

test("one numeric storage failure after accepted receipt stays unknown until a read-only retry commits", async () => {
  const db = new IDBFactory(),
    gate = writeGate(db);
  let confirmQuery = false;
  const p = await connectedPage({
    db,
    onCall(call, reply) {
      if (call.method === "session.send") {
        gate.quota();
        reply(call, {
          commandId: call.commandId,
          method: "session.send",
          admissionState: "accepted",
          submissionUnknown: false,
        });
        return true;
      }
      if (call.method === "command.read") {
        if (confirmQuery)
          reply(call, {
            commandId: call.params.commandId,
            method: "session.send",
            admissionState: "accepted",
            submissionUnknown: false,
          });
        return true;
      }
    },
  });
  const reader = new BrowserState({
    createIdentity: async () => "unused",
    identityId: (key) => `peer-${key}`,
    indexedDB: db,
    channel: null,
  });
  try {
    openThread(p);
    await until(() => p.element("session-title").textContent === "Session");
    p.element("session-draft").value = "keep until retirement commits";
    p.element("session-draft").dispatchEvent({ type: "input" });
    p.element("session-send").click();
    await until(() => p.element("send-command-state").textContent.includes("quota"));
    assert.equal(p.element("session-send").disabled, true);
    assert.match(p.element("send-command-state").textContent, /未知/);
    const token = await reader.restore();
    assert.equal((await reader.locators(token)).length, 1);
    assert.equal(p.element("session-draft").value, "keep until retirement commits");
    confirmQuery = true;
    p.element("send-query").click();
    await until(() => p.element("send-command-state").textContent.includes("已受理"));
    assert.equal((await reader.locators(token)).length, 0);
    assert.equal(p.calls.filter((call) => call.method === "session.send").length, 1);
  } finally {
    reader.close();
    await p.dispose();
  }
});

test("empty project list keeps the connection and recovers original locators without a detail target", async () => {
  const db = new IDBFactory(),
    { state, token } = await remember(db);
  await state.persistLocator(token, {
    hostId: "host",
    projectId: "project",
    commandId: "original-empty",
    method: "session.create",
    params: {},
  });
  const p = page({
    db,
    hash: "",
    onCall(call, reply) {
      if (call.method === "project.list") {
        reply(call, { projects: [] });
        return true;
      }
    },
  });
  try {
    await until(() => p.calls.some((call) => call.method === "command.read"));
    assert.match(p.element("status").textContent, /^已连接/);
    assert.equal(p.sockets[0].closed, undefined);
    assert.equal(
      p.calls.find((call) => call.method === "command.read").params.commandId,
      "original-empty",
    );
    assert.equal(
      p.calls.some((call) => call.method === "session.create"),
      false,
    );
  } finally {
    state.close();
    await p.dispose();
  }
});

test("human pairing can exceed the transport deadline while Host approval and expiry stay authoritative", async () => {
  for (const expires of [false, true]) {
    const p = page({
      onCall(call) {
        if (call.method === "hello") {
          call.messages.push({ event: "pairing" });
          return true;
        }
      },
    });
    try {
      await until(() => !p.element("connect").disabled);
      p.element("remember-device").checked = true;
      p.element("connect").click();
      await until(() => p.element("status").textContent.includes("等待桌面确认"));
      assert.equal(
        p.advanceTimers(15001),
        0,
        "transport deadline must end when human pairing starts",
      );
      assert.equal(p.sockets[0].closed, undefined);
      const hello = p.calls.find((call) => call.method === "hello");
      if (expires) {
        hello.messages.push({
          error: { code: "PAIRING_EXPIRED", message: "Host invitation expired" },
        });
        await until(() => p.element("status").textContent.includes("PAIRING_EXPIRED"));
        assert.equal(p.sockets[0].closed, true);
        assert.equal(p.advanceTimers(30000), 0);
        const reader = new BrowserState({
          createIdentity: async () => "unused",
          identityId: (key) => `peer-${key}`,
          indexedDB: p.db,
          channel: null,
        });
        assert.equal(await reader.restore(), null);
        reader.close();
      } else {
        hello.messages.push({
          event: "ready",
          hostId: "host",
          connectionId: hello.connectionId,
          gatewayGeneration: "gateway",
          grantRevision: 1,
          capabilities: ["observe", "submit"],
          limits: { applicationMessageBytes: 262144 },
        });
        await until(() => p.element("status").textContent.startsWith("已连接"));
        assert.match(p.element("device-storage").textContent, /已记住/);
      }
    } finally {
      await p.dispose();
    }
  }
});

function taskQuestionPage(call, reply) {
  const target = { taskId: "task", runId: "run", questionId: "question" };
  if (call.method === "work.list") {
    reply(call, {
      data: [
        {
          kind: "taskRun",
          ...target,
          title: "Task Inbox",
          execution: { state: "running" },
          attentionCount: 1,
          attentionComplete: true,
          attentionRefs: [{ kind: "asyncQuestion", ...target, summary: "Choose target" }],
          queue: { pendingCount: 0 },
        },
      ],
      complete: true,
      serviceGeneration: "service",
    });
    return true;
  }
  if (call.method === "task.question.read") {
    const questions = [
      { id: "choice", title: "Choose exact target", options: ["A", "B"], allowFreeText: false },
    ];
    reply(call, {
      projectId: "project",
      serviceGeneration: "service",
      ...target,
      kind: "asyncQuestion",
      status: "pending",
      expiresAt: null,
      taskPaused: true,
      runStatus: "paused",
      complete: true,
      questions,
    });
    return true;
  }
}
function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}
async function openTaskQuestion(p) {
  await until(() =>
    descendants(p.element("work-items")).some((value) => value.textContent === "审阅待处理事项"),
  );
  descendants(p.element("work-items"))
    .find((value) => value.textContent === "审阅待处理事项")
    .click();
  await until(() => p.element("attention-questions").children.length === 1);
  const input = p.element("attention-questions").children[0].children.at(-1);
  input.value = "B";
  input.dispatchEvent({ type: "change" });
}
test("Task Inbox reply uses exact Task target without Session selection and waits for locator commit", async () => {
  const db = new IDBFactory(),
    gate = writeGate(db);
  const p = await connectedPage({ db, onCall: taskQuestionPage });
  try {
    await openTaskQuestion(p);
    assert.match(p.element("attention-target").textContent, /Task task.*Run run.*question/);
    assert.match(p.element("attention-status").textContent, /继续工作.*不会恢复/);
    assert.equal(p.element("attention-answer").disabled, false);
    assert.equal(
      p.calls.some((call) => call.method === "session.open"),
      false,
    );
    gate.arm();
    p.element("attention-answer").click();
    await until(gate.started);
    assert.equal(
      p.calls.some((call) => call.method === "task.question.reply"),
      false,
    );
    gate.release();
    await until(() => p.calls.some((call) => call.method === "task.question.reply"));
    const sent = p.calls.find((call) => call.method === "task.question.reply");
    assert.deepEqual(JSON.parse(JSON.stringify(sent.params)), {
      taskId: "task",
      runId: "run",
      questionId: "question",
      answers: { choice: "B" },
    });
    const storage = new BrowserState({
      createIdentity: async () => "unused",
      identityId: (key) => `peer-${key}`,
      indexedDB: db,
      channel: null,
    });
    try {
      const token = await storage.restore();
      const saved = (await storage.locators(token))[0];
      assert.deepEqual(saved.params, { taskId: "task", runId: "run", questionId: "question" });
      assert.equal(saved.commandId, sent.commandId);
    } finally {
      storage.close();
    }
  } finally {
    gate.release();
    await p.dispose();
  }
});
test("Task reply reload queries only original command without persisted answers or automatic resend", async () => {
  const db = new IDBFactory(),
    { state, token } = await remember(db);
  await state.persistLocator(token, {
    hostId: "host",
    projectId: "project",
    commandId: "original-task",
    method: "task.question.reply",
    params: { taskId: "task", runId: "run", questionId: "question", answers: { choice: "SECRET" } },
  });
  const p = page({ db, hash: "", onCall: taskQuestionPage });
  try {
    await until(() => p.calls.some((call) => call.method === "command.read"));
    assert.equal(
      p.calls.find((call) => call.method === "command.read").params.commandId,
      "original-task",
    );
    assert.equal(
      p.calls.some((call) => call.method === "task.question.reply"),
      false,
    );
    await openTaskQuestion(p);
    assert.equal(p.element("attention-answer").disabled, true);
    assert.equal(p.element("attention-query").disabled, false);
  } finally {
    state.close();
    await p.dispose();
  }
});

test("Task reply cancels dispatch when original detail changes during IndexedDB commit", async () => {
  const db = new IDBFactory(),
    gate = writeGate(db),
    p = await connectedPage({ db, onCall: taskQuestionPage });
  try {
    await openTaskQuestion(p);
    gate.arm();
    p.element("attention-answer").click();
    await until(gate.started);
    p.element("attention-close").click();
    gate.release();
    await until(() => p.element("storage-error").textContent.includes("未发送"));
    assert.equal(
      p.calls.some((call) => call.method === "task.question.reply"),
      false,
    );
  } finally {
    gate.release();
    await p.dispose();
  }
});

test("Task pause reviews original Run and requires explicit future-schedule confirmation", async () => {
  let paused = false;
  const p = await connectedPage({
    ready: { capabilities: ["observe", "submit", "pauseTask"] },
    onCall(call, reply) {
      if (call.method === "work.list") {
        reply(call, {
          data: [
            {
              kind: "taskRun",
              taskId: "task",
              runId: "run",
              title: "Task",
              execution: { state: "running" },
              attentionCount: 0,
              attentionComplete: true,
              attentionRefs: [],
              queue: { pendingCount: 0 },
            },
          ],
          complete: true,
          serviceGeneration: "service",
        });
        return true;
      }
      if (call.method === "task.read") {
        reply(call, {
          projectId: "project",
          serviceGeneration: "service",
          taskId: "task",
          runId: "run",
          currentRunId: "run",
          revision: 7,
          available: !paused,
          taskPaused: paused,
          runStatus: paused ? "paused" : "running",
          workersSettled: paused,
          settled: paused,
        });
        return true;
      }
      if (call.method === "task.pause") {
        reply(call, {
          commandId: call.commandId,
          admissionState: "unknown",
          submissionUnknown: true,
          observedState: {
            taskId: "task",
            runId: "run",
            taskPaused: true,
            runStatus: "completed",
            workersSettled: false,
            settled: false,
            provesCommandAdmission: false,
          },
        });
        return true;
      }
    },
  });
  try {
    await until(() => p.element("work-items").children.length === 1);
    const button = p
      .element("work-items")
      .children[0].children.find((x) => x.textContent === "审阅暂停 Task");
    assert.ok(button, "Task Run exposes explicit pause review");
    button.click();
    await until(() => p.calls.some((x) => x.method === "task.read"));
    await tick();
    assert.equal(p.element("task-pause-confirm").disabled, true);
    p.element("task-pause-reviewed").checked = true;
    p.element("task-pause-reviewed").dispatchEvent({ type: "change" });
    assert.equal(p.element("task-pause-confirm").disabled, false);
    p.element("task-pause-confirm").click();
    await until(() => p.calls.some((x) => x.method === "task.pause"));
    await tick();
    const sent = p.calls.find((x) => x.method === "task.pause");
    assert.deepEqual(JSON.parse(JSON.stringify(sent.params)), {
      taskId: "task",
      expectedRunId: "run",
      expectedRevision: 7,
    });
    assert.match(p.element("task-pause-state").textContent, /结果未知/);
    assert.match(p.element("task-pause-state").textContent, /worker.*结算/);
    paused = true;
    p.element("task-pause-refresh").click();
    await until(() => p.calls.filter((x) => x.method === "task.read").length === 2);
    await tick();
    assert.match(p.element("task-pause-state").textContent, /结果未知/);
    assert.match(p.element("task-pause-state").textContent, /全部 worker 已结算/);
    assert.equal(p.element("task-pause-confirm").disabled, true);
  } finally {
    await p.dispose();
  }
});

test("Task pause cannot confirm historical Run, absent guard or revoked pause grant", async () => {
  for (const kind of ["historical", "missingGuard", "revoked"]) {
    const p = await connectedPage({
      ready: {
        capabilities:
          kind === "revoked" ? ["observe", "submit"] : ["observe", "submit", "pauseTask"],
      },
      onCall(call, reply) {
        if (call.method === "work.list") {
          reply(call, {
            data: [
              {
                kind: "taskRun",
                taskId: "task",
                runId: "old",
                title: "Task",
                execution: { state: "completed" },
                attentionCount: 0,
                attentionComplete: true,
                attentionRefs: [],
                queue: { pendingCount: 0 },
              },
            ],
            complete: true,
            serviceGeneration: "service",
          });
          return true;
        }
        if (call.method === "task.read") {
          reply(call, {
            projectId: "project",
            serviceGeneration: "service",
            taskId: "task",
            runId: "old",
            currentRunId: kind === "historical" ? "new" : "old",
            revision: 7,
            available: kind === "revoked",
            runStatus: "completed",
          });
          return true;
        }
      },
    });
    try {
      p.element("work-items")
        .children[0].children.find((x) => x.textContent === "审阅暂停 Task")
        .click();
      await until(() => p.calls.some((x) => x.method === "task.read"));
      await tick();
      p.element("task-pause-reviewed").checked = true;
      p.element("task-pause-reviewed").dispatchEvent({ type: "change" });
      assert.equal(p.element("task-pause-confirm").disabled, true, kind);
      p.element("task-pause-confirm").click();
      await tick();
      assert.equal(
        p.calls.some((x) => x.method === "task.pause"),
        false,
      );
    } finally {
      await p.dispose();
    }
  }
});

async function pauseReviewPage(onPauseCall) {
  const p = await connectedPage({
    ready: { capabilities: ["observe", "submit", "pauseTask"] },
    onCall(call, reply) {
      if (onPauseCall(call, reply)) return true;
      if (call.method === "work.list") {
        reply(call, {
          data: [
            {
              kind: "taskRun",
              taskId: "task",
              runId: "run",
              title: "Task",
              execution: { state: "running" },
              attentionCount: 0,
              attentionComplete: true,
              attentionRefs: [],
              queue: { pendingCount: 0 },
            },
          ],
          complete: true,
          serviceGeneration: "service",
        });
        return true;
      }
    },
  });
  p.element("work-items")
    .children[0].children.find((x) => x.textContent === "审阅暂停 Task")
    .click();
  await until(() => p.calls.some((x) => x.method === "task.read"));
  await tick();
  return p;
}
const pauseReview = (revision) => ({
  projectId: "project",
  serviceGeneration: "service",
  taskId: "task",
  runId: "run",
  currentRunId: "run",
  revision,
  available: true,
  taskPaused: false,
  runStatus: "running",
  workersSettled: false,
  settled: false,
});
function confirmPause(p) {
  p.element("task-pause-reviewed").checked = true;
  p.element("task-pause-reviewed").dispatchEvent({ type: "change" });
  p.element("task-pause-confirm").click();
}
test("known pause after local same-Run resume requires fresh review and a new explicit command", async () => {
  let revision = 7;
  const p = await pauseReviewPage((call, reply) => {
    if (call.method === "task.read") {
      reply(call, pauseReview(revision));
      return true;
    }
    if (call.method === "task.pause") {
      reply(call, {
        commandId: call.commandId,
        admissionState: "accepted",
        submissionUnknown: false,
        observedState: {
          ...pauseReview(revision + 1),
          available: false,
          taskPaused: true,
          provesCommandAdmission: false,
        },
      });
      return true;
    }
  });
  try {
    confirmPause(p);
    await until(() => p.calls.filter((x) => x.method === "task.pause").length === 1);
    await until(() => p.element("task-pause-state").textContent.includes("已受理"));
    const original = p.calls.find((x) => x.method === "task.pause");
    assert.equal(
      p.element("task-pause-confirm").disabled,
      true,
      "accepted response alone cannot permit another pause",
    );
    revision = 9; // 模拟桌面 Core 本地恢复同一 Run，Remote 不发 resume。
    p.element("task-pause-refresh").click();
    await until(() => p.calls.filter((x) => x.method === "task.read").length === 2);
    await tick();
    assert.equal(p.element("task-pause-reviewed").checked, false);
    assert.equal(p.element("task-pause-confirm").disabled, true);
    assert.equal(p.calls.filter((x) => x.method === "task.pause").length, 1);
    p.element("task-pause-reviewed").checked = true;
    p.element("task-pause-reviewed").dispatchEvent({ type: "change" });
    assert.equal(p.element("task-pause-confirm").disabled, false);
    p.element("task-pause-confirm").click();
    await until(() => p.calls.filter((x) => x.method === "task.pause").length === 2);
    const next = p.calls.filter((x) => x.method === "task.pause")[1];
    assert.notEqual(next.commandId, original.commandId);
    assert.deepEqual(JSON.parse(JSON.stringify(next.params)), {
      taskId: "task",
      expectedRunId: "run",
      expectedRevision: 9,
    });
    assert.equal(
      p.calls.some((x) => x.method.includes("resume")),
      false,
    );
  } finally {
    await p.dispose();
  }
});
test("UNKNOWN pause with unavailable observation never claims unpaused or worker settlement", async () => {
  let failRead = false;
  const unavailable = { source: "task.read", status: "unavailable", provesCommandAdmission: false };
  const p = await pauseReviewPage((call, reply) => {
    if (call.method === "task.read") {
      if (failRead) {
        call.messages.push({
          id: call.id,
          error: { code: "CORE_UNAVAILABLE", message: "read failed" },
        });
        return true;
      }
      reply(call, pauseReview(7));
      return true;
    }
    if (call.method === "task.pause" || call.method === "command.read") {
      reply(call, {
        commandId: call.commandId ?? call.params.commandId,
        admissionState: "unknown",
        submissionUnknown: true,
        observedState: unavailable,
      });
      return true;
    }
  });
  try {
    confirmPause(p);
    await until(() => p.calls.some((x) => x.method === "task.pause"));
    await tick();
    p.element("task-pause-query").click();
    await until(() => p.calls.some((x) => x.method === "command.read"));
    await tick();
    const rendered = p.element("task-pause-state").textContent;
    assert.match(rendered, /结果未知/);
    assert.match(rendered, /Task 未知/);
    assert.match(rendered, /Run 未知/);
    assert.match(rendered, /结算状态未知/);
    assert.doesNotMatch(rendered, /Task 未暂停|已结算|等待原 Run/);
    assert.equal(unavailable.provesCommandAdmission, false);
    p.element("task-pause-refresh").click();
    await until(() => p.calls.filter((x) => x.method === "task.read").length === 2);
    await tick();
    p.element("task-pause-reviewed").checked = true;
    p.element("task-pause-reviewed").dispatchEvent({ type: "change" });
    assert.equal(
      p.element("task-pause-confirm").disabled,
      true,
      "fresh available view cannot permit UNKNOWN replay",
    );
    assert.equal(p.calls.filter((x) => x.method === "task.pause").length, 1);
    failRead = true;
    p.element("task-pause-refresh").click();
    await until(() => p.element("task-pause-error").textContent.includes("read failed"));
    assert.match(
      p.element("task-pause-state").textContent,
      /结果未知.*Task 未知.*Run 未知.*结算状态未知/,
    );
    assert.doesNotMatch(p.element("task-pause-state").textContent, /Task 未暂停|已结算/);
  } finally {
    await p.dispose();
  }
});

test("production remembered Relay root or manifest launch restores its room before wire selection", async (t) => {
  const db = new IDBFactory(),
    drafts = sessionStorage(),
    room = "a".repeat(64);
  await remember(db, drafts, room);
  const restored = page({ db, drafts, hash: "" });
  t.after(() => restored.dispose());
  await until(() => restored.wireOptions.length === 1);
  assert.equal(restored.wireOptions[0].room, room);
  await until(() => restored.calls.some((call) => call.method === "project.list"));
});

test("same-Host explicit Relay re-enrollment room replaces remembered route only after verified ready", async (t) => {
  const db = new IDBFactory(),
    drafts = sessionStorage(),
    roomA = "a".repeat(64),
    roomB = "b".repeat(64);
  const saved = await remember(db, drafts, roomA);
  t.after(() => saved.state.close());
  const refused = page({
    db,
    drafts,
    hash: `#host=host&room=${roomB}`,
    onCall(call) {
      if (call.method !== "hello") return false;
      call.messages.push({ error: { code: "FORBIDDEN", message: "denied" } });
      return true;
    },
  });
  t.after(() => refused.dispose());
  await until(() => refused.calls.some((call) => call.method === "hello"));
  assert.equal(
    (await saved.state.transaction(false, (record) => record)).credential.relayRoom,
    roomA,
  );
  await refused.dispose();
  const changed = page({ db, drafts, hash: `#host=host&room=${roomB}` });
  t.after(() => changed.dispose());
  await until(() => changed.calls.some((call) => call.method === "project.list"));
  assert.equal(changed.wireOptions[0].room, roomB);
  assert.equal(
    (await saved.state.transaction(false, (record) => record)).credential.relayRoom,
    roomB,
  );
  await changed.dispose();
  const restored = page({ db, drafts, hash: "" });
  t.after(() => restored.dispose());
  await until(() => restored.calls.some((call) => call.method === "project.list"));
  assert.equal(restored.wireOptions[0].room, roomB);
});

test("pasted Relay invitation fences a held remembered connection before changing its route", async (t) => {
  for (const accepted of [true, false])
    await t.test(accepted ? "new room verified" : "new room refused", async (t) => {
      const db = new IDBFactory(),
        drafts = sessionStorage();
      const roomA = "a".repeat(64),
        roomB = "b".repeat(64),
        invitation = "c".repeat(64);
      const saved = await remember(db, drafts, roomA);
      t.after(() => saved.state.close());
      const hellos = [];
      const p = page({
        db,
        drafts,
        hash: "",
        onCall(call) {
          if (call.method !== "hello") return false;
          hellos.push(call);
          return true;
        },
      });
      t.after(() => p.dispose());
      const ready = (call) =>
        call.messages.push({
          event: "ready",
          hostId: "host",
          connectionId: call.connectionId,
          gatewayGeneration: "gateway",
          grantRevision: 1,
          capabilities: ["observe"],
          limits: { applicationMessageBytes: 262144 },
        });
      const storedRoom = async () =>
        (await saved.state.transaction(false, (record) => record)).credential.relayRoom;
      await until(() => hellos.length === 1);
      assert.equal(p.wireOptions[0].room, roomA);
      p.element("invitation").value =
        `http://localhost/remote.html#host=host&room=${roomB}&invite=${invitation}`;
      p.element("paste").click();
      ready(hellos[0]);
      for (let n = 0; n < 12; n++) await tick();
      assert.equal(
        await storedRoom(),
        roomA,
        "old room ready cannot persist the newly pasted room",
      );
      assert.equal(p.sockets[0].closed, true);
      assert.equal(
        p.calls.filter((call) => call.method === "project.list").length,
        0,
        "old ready cannot revive application state",
      );
      assert.match(p.element("status").textContent, /邀请已载入/);
      p.element("connect").click();
      await until(() => hellos.length === 2);
      assert.equal(p.wireOptions[1].room, roomB);
      assert.equal(hellos[1].inviteSecret, invitation);
      assert.equal(
        await storedRoom(),
        roomA,
        "selection alone cannot replace the remembered route",
      );
      if (accepted) {
        ready(hellos[1]);
        await until(() => p.calls.some((call) => call.method === "project.list"));
        assert.equal(await storedRoom(), roomB);
      } else {
        hellos[1].messages.push({ error: { code: "FORBIDDEN", message: "new room denied" } });
        await until(() => p.element("status").textContent.includes("new room denied"));
        assert.equal(await storedRoom(), roomA);
        assert.equal(p.calls.filter((call) => call.method === "project.list").length, 0);
      }
    });
});
