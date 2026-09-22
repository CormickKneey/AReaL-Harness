import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

// 最小 DOM 替身用于验证客户端投影、计时和控制请求；不替代浏览器布局验收。
class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.value = "";
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => (enabled ? classes.add(name) : classes.delete(name)),
    };
    this.scrollTop = this.scrollHeight = this.clientHeight = 0;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector) {
    return this.children.find((child) => child.tag === selector) ?? null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector === "details[open]" && child.tag === "details" && child.open ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}
function client() {
  let now = 1000;
  const elements = new Map(),
    requests = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get("composer-context").append(new Element("span"));
  get("group-start").append(new Element("button"));
  get("refresh").append(new Element("svg"));
  get("interrupt").append(new Element("span"));
  const context = vm.createContext({
    document: {
      getElementById: get,
      createElement: (tag) => new Element(tag),
      createElementNS: (_, tag) => new Element(tag),
      documentElement: new Element("html"),
      body: new Element("body"),
      addEventListener: () => {},
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    localStorage: { getItem: () => null },
    crypto: { randomUUID },
    location: { href: "http://localhost/ui" },
    URL,
    WebSocket: class {
      send(request) {
        requests.push(JSON.parse(request));
      }
    },
    requestAnimationFrame: (callback) => callback(),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date: class extends Date {
      static now() {
        return now;
      }
    },
  });
  const run = (code) => vm.runInContext(code, context);
  run(readFileSync(new URL("../clients/web/app.js", import.meta.url), "utf8"));
  run(
    `connected = true; thread = {id:"thread",cwd:"/workspace",turns:[{id:"turn",status:"inProgress",items:[{id:"answer",type:"agentMessage",text:""}]}]}; render();`,
  );
  return {
    get,
    run,
    requests,
    advance: (seconds) => {
      now += seconds * 1000;
      run("renderProgress()");
    },
  };
}
function emit(client, method, params) {
  client.run(
    `event(${JSON.stringify({ method, params: { threadId: "thread", turnId: "turn", ...params } })})`,
  );
}

test("waiting, thinking and body stay separate; refresh replaces the baseline and discard removes it", () => {
  const c = client();
  assert.match(c.get("progress").textContent, /正在等待模型回复/);
  assert.equal(c.get("history").children.length, 0);
  c.advance(31);
  assert.match(c.get("progress").textContent, /仍未收到正文/);
  emit(c, "item/started", {
    item: { id: "reason", type: "reasoning", summary: [], content: [""] },
  });
  emit(c, "item/reasoning/textDelta", { itemId: "reason", contentIndex: 0, delta: "检查依赖" });
  assert.match(c.get("progress").textContent, /已收到模型思考/);
  const card = c.get("history").children[0];
  assert.equal(card.children[1].textContent, "检查依赖");
  card.open = true;
  c.run('thread.turns[0].items[1].content = ["检查依赖"]; render()');
  emit(c, "item/reasoning/textDelta", { itemId: "reason", contentIndex: 0, delta: "完成" });
  assert.equal(c.get("history").children[0].children[1].textContent, "检查依赖完成");
  assert.equal(c.get("history").children[0].open, true);
  emit(c, "item/agentMessage/delta", { itemId: "answer", delta: "正文" });
  assert.doesNotMatch(c.get("progress").textContent, /仍未收到正文/);
  assert.equal(c.get("history").children[0].children[1].textContent, "正文");
  emit(c, "areal/model/completionDiscarded", { itemIds: ["answer", "reason"] });
  assert.equal(c.get("history").children.length, 0);
});

test("refresh and interrupt expose pending states and tolerate switching threads", async () => {
  const c = client();
  const refresh = c.run("reload()");
  assert.equal(c.get("refresh").getAttribute("aria-label"), "刷新中…");
  assert.equal(c.get("refresh").disabled, true);
  assert.equal(c.get("refresh").getAttribute("aria-busy"), "true");
  assert.equal(c.get("refresh").children[0].tag, "svg");
  const request = c.requests.at(-1);
  c.run(
    `thread = {id:"other",turns:[]}; pending.get(${request.id}).resolve({thread:{id:"thread",turns:[]}})`,
  );
  await refresh;
  assert.equal(c.run("thread.id"), "other");
  assert.equal(c.get("refresh").disabled, false);
  c.run('thread = {id:"thread",turns:[{id:"turn",status:"inProgress",items:[]}]}; render()');
  const stop = c.get("interrupt").onclick();
  assert.equal(c.get("interrupt").disabled, true);
  assert.equal(c.get("interrupt").getAttribute("aria-label"), "正在停止…");
  assert.equal(c.get("interrupt").children[0].tag, "span");
  assert.match(c.get("progress").textContent, /已请求停止/);
  const interrupt = c.requests.at(-1);
  assert.equal(interrupt.method, "turn/interrupt");
  await c.get("interrupt").onclick();
  assert.equal(c.requests.at(-1).id, interrupt.id);
  c.run(`pending.get(${interrupt.id}).reject(Error("connection lost"))`);
  await stop;
  assert.equal(c.get("interrupt").disabled, false);
  emit(c, "turn/completed", { turn: { id: "turn", status: "interrupted", items: [] } });
  assert.equal(c.get("progress").hidden, true);
  assert.equal(c.get("interrupt").disabled, true);
  c.run("connected = false; render()");
  assert.equal(c.get("refresh").disabled, true);
});

test("a successful interrupt clears the stopping label when the terminal event arrives", async () => {
  const c = client();
  const stopping = c.get("interrupt").onclick();
  const interrupt = c.requests.at(-1);
  const turn = { id: "turn", status: "interrupted", items: [] };
  emit(c, "turn/completed", { turn });
  assert.equal(c.get("interrupt").getAttribute("aria-label"), "停止执行");
  assert.equal(c.get("progress").hidden, true);
  c.run(`pending.get(${interrupt.id}).resolve({})`);
  await Promise.resolve();
  const refresh = c.requests.at(-1);
  assert.equal(refresh.method, "thread/resume");
  c.run(
    `pending.get(${refresh.id}).resolve({thread:{id:"thread",turns:[${JSON.stringify(turn)}]}})`,
  );
  await stopping;
  assert.equal(c.get("interrupt").disabled, true);
});

test("Responses summary deltas grow indexed parts and show progress without body text", () => {
  const c = client();
  emit(c, "item/started", {
    item: { id: "response", type: "reasoning", summary: [], content: [] },
  });
  emit(c, "item/reasoning/summaryTextDelta", {
    itemId: "response",
    summaryIndex: 1,
    delta: "摘要",
  });
  emit(c, "item/reasoning/summaryTextDelta", {
    itemId: "response",
    summaryIndex: 1,
    delta: "完成",
  });
  assert.match(c.get("progress").textContent, /已收到模型思考/);
  assert.equal(c.get("history").children[0].children[0].children[0].textContent, "思考摘要");
  assert.equal(c.get("history").children[0].children[1].textContent, "\n摘要完成");
  emit(c, "item/reasoning/textDelta", { itemId: "response", contentIndex: 0, delta: "思考文本" });
  assert.equal(c.get("history").children[0].children[1].textContent, "\n摘要完成\n思考文本");
});

test("stop pauses an active goal during reasoning and between turns", async () => {
  for (const status of ["inProgress", "completed"]) {
    const c = client();
    const goal = {
      id: "goal",
      status: "active",
      objective: "Inspect",
      maxTurns: 10,
      usage: { tokensUsed: 1, timeUsedSeconds: 1, turnsStarted: 1, accountingComplete: true },
    };
    c.run(`thread.turns[0].status = ${JSON.stringify(status)}; goalsSupported = true`);
    emit(c, "areal/goal/updated", { goal, revision: 1, eventSequence: 1 });
    assert.equal(c.get("interrupt").disabled, false);
    const stopping = c.get("interrupt").onclick();
    const pause = c.requests.at(-1);
    assert.equal(pause.method, "areal/goal/pause");
    assert.equal(pause.params.goalId, "goal");
    assert.equal(c.get("interrupt").disabled, true);
    const count = c.requests.length;
    await c.get("interrupt").onclick();
    assert.equal(c.requests.length, count);
    const paused = { ...goal, status: "paused" };
    c.run(
      `pending.get(${pause.id}).resolve(${JSON.stringify({ threadId: "thread", goal: paused, revision: 2, eventSequence: 2 })})`,
    );
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const refresh = c.requests.at(-1);
    assert.equal(refresh.method, "thread/resume");
    const snapshot = {
      id: "thread",
      turns: [{ id: "turn", status: "interrupted", items: [] }],
      goals: { goal: paused, revision: 2, eventSequence: 2 },
    };
    c.run(`pending.get(${refresh.id}).resolve({thread:${JSON.stringify(snapshot)}})`);
    await stopping;
    assert.equal(c.get("interrupt").disabled, true);
    assert.equal(c.get("interrupt").getAttribute("aria-label"), "停止执行");
    assert.equal(c.get("progress").hidden, true);
  }
});
