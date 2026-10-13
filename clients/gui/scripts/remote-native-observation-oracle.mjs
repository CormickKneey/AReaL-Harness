import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function installNavigationProbe({ app, webContents }, { url, capacity = 2048 }) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 2048)
    throw new Error("Invalid native diagnostic capacity");
  const trace = (globalThis.rc04NavigationTrace = { events: [], dropped: 0, total: 0, capacity });
  globalThis.rc04PublicState = null;
  const record = (value) => {
    const sequence = ++trace.total;
    if (trace.events.length < trace.capacity)
      trace.events.push({ at: Date.now(), sequence, ...value });
    else trace.dropped++;
  };
  globalThis.rc04InstallLoadProbe = (contents) => {
    const original = contents.loadURL;
    contents.loadURL = function (...args) {
      if (args[0] !== url) return original.apply(this, args);
      const invocation = {
        webContentsId: contents.id,
        url: args[0],
        publicStateBeforeExplicitNavigation: globalThis.rc04PublicState,
      };
      record({ event: "loadURL", ...invocation });
      let pending;
      try {
        pending = original.apply(this, args);
      } catch (error) {
        record({
          event: "loadURL-throw",
          ...invocation,
          message: error.message,
          code: error.code,
          errno: error.errno,
        });
        throw error;
      }
      pending.then(
        () => record({ event: "loadURL-resolved", ...invocation }),
        (error) => {
          const own = Object.fromEntries(
            Object.getOwnPropertyNames(error).map((key) => [key, String(error[key])]),
          );
          record({
            event: "loadURL-rejected",
            ...invocation,
            message: error.message,
            code: error.code,
            errno: error.errno,
            own,
          });
        },
      );
      return pending;
    };
  };
  const watch = (contents) => {
    for (const event of [
      "did-start-loading",
      "did-start-navigation",
      "did-navigate",
      "did-frame-navigate",
      "did-fail-load",
      "did-fail-provisional-load",
      "did-finish-load",
      "did-stop-loading",
      "destroyed",
    ])
      contents.on(event, (...args) =>
        record({
          event,
          webContentsId: contents.id,
          url: contents.isDestroyed() ? null : contents.getURL(),
          args: args.filter((value) => ["string", "number", "boolean"].includes(typeof value)),
        }),
      );
  };
  webContents.getAllWebContents().forEach(watch);
  app.on("web-contents-created", (_event, contents) => watch(contents));
}

export function drainNavigationProbe() {
  const trace = globalThis.rc04NavigationTrace;
  if (!trace) return { installed: false, events: [], complete: false };
  return {
    installed: true,
    events: trace.events.splice(0),
    dropped: trace.dropped,
    total: trace.total,
    capacity: trace.capacity,
    complete: trace.dropped === 0,
  };
}

export function nativeReady(state, native, expected) {
  return Boolean(
    state?.url === expected.url &&
    state?.browser?.pageId === expected.pageId &&
    !state.loading &&
    !state.error &&
    native?.url === expected.url &&
    !native.loading &&
    native.readyState === "complete" &&
    typeof native.sentinel === "string" &&
    native.sentinel.length > 0,
  );
}
export function assertObserve(record, thread, expected) {
  const { request, response } = record;
  assert.equal(request.operation, "observe");
  assert.equal(request.threadId, expected.threadId);
  assert.equal(request.turnId, expected.turnId);
  assert.equal(request.pageId, expected.pageId);
  assert.equal(response.requestId, request.requestId);
  assert.ok(!response.error, JSON.stringify(response));
  assert.ok(response.result && !response.result.error, JSON.stringify(response));
  assert.equal(
    response.result.nativeWebContentsId,
    expected.nativeWebContentsId,
    "nativeWebContentsId",
  );
  assert.equal(response.result.url, expected.url, "url");
  for (const key of [
    "projectId",
    "threadId",
    "turnId",
    "callId",
    "pageId",
    "coreInstanceId",
    "coreGeneration",
    "browserHostId",
    "hostGeneration",
    "pageGeneration",
    "controlEpoch",
  ])
    assert.equal(response.result[key], request[key], key);
  assert.equal(thread.id, expected.threadId);
  const turn = thread.turns.find((value) => value.id === expected.turnId);
  assert.equal(turn?.status, "completed");
  const item = turn.items.find(
    (value) =>
      value.type === "dynamicToolCall" &&
      value.tool === "browser_v1" &&
      value.callId === request.callId,
  );
  assert.equal(item?.status, "completed");
  assert.equal(item.success, true);
  const content = item.contentItems?.find((value) => value.type === "inputText")?.text;
  assert.match(content ?? "", /RC04_NATIVE_SENTINEL/);
  assert.deepEqual(JSON.parse(content), response.result);
  return item;
}

// 反例来自验收边界：存在 WebContents、旧 Turn 或模型标记均不能证明 observe 成功。
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const target = new EventEmitter();
  target.id = 7;
  target.getURL = () => "http://127.0.0.1:1234/";
  target.isDestroyed = () => false;
  let rejectLoad;
  const originalPromise = new Promise((_resolve, reject) => {
    rejectLoad = reject;
  });
  target.loadURL = () => originalPromise;
  const electron = { app: new EventEmitter(), webContents: { getAllWebContents: () => [target] } };
  const isolated = createContext({
    electron,
    options: { url: target.getURL(), capacity: 4 },
    target,
  });
  assert.equal(runInContext("typeof require", isolated), "undefined");
  assert.equal(runInContext("typeof process", isolated), "undefined");
  runInContext(`(${installNavigationProbe.toString()})(electron, options)`, isolated);
  runInContext("globalThis.rc04InstallLoadProbe(target)", isolated);
  const actualPromise = runInContext("target.loadURL(options.url)", isolated);
  assert.equal(actualPromise, originalPromise, "target wrapper returns the same Promise");
  const originalError = Object.assign(new Error("(-3) loading fixture"), {
    code: "ERR_ABORTED",
    errno: -3,
    detail: "native-own-field",
  });
  rejectLoad(originalError);
  await assert.rejects(actualPromise, (error) => error === originalError);
  target.emit("did-fail-load", {}, -3, "ERR_ABORTED", target.getURL(), true);
  target.emit("did-stop-loading");
  const drain = () =>
    JSON.parse(JSON.stringify(runInContext(`(${drainNavigationProbe.toString()})()`, isolated)));
  const firstDrain = drain();
  assert.equal(firstDrain.complete, true);
  assert.equal(firstDrain.events.length, 4);
  assert.ok(firstDrain.events.every((value) => Number.isSafeInteger(value.at)));
  assert.equal(firstDrain.events[1].event, "loadURL-rejected");
  assert.equal(firstDrain.events[1].errno, -3);
  assert.equal(firstDrain.events[1].own.detail, "native-own-field");
  assert.deepEqual(
    firstDrain.events.map((value) => value.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(drain().events.length, 0, "drain removes only delivered events");
  for (let n = 0; n < 6; n++) target.emit("did-start-loading");
  const overflow = drain();
  assert.equal(overflow.events.length, 4);
  assert.equal(overflow.dropped, 2);
  assert.equal(overflow.complete, false);
  assert.equal(overflow.total, 10);
  assert.equal(drain().dropped, 2, "draining cannot erase overflow evidence");

  const expected = {
    url: "http://127.0.0.1:1234/",
    pageId: "page",
    nativeWebContentsId: 7,
    threadId: "thread",
    turnId: "new-turn",
  };
  const state = { url: expected.url, loading: false, error: "", browser: { pageId: "page" } };
  const native = {
    id: 7,
    url: expected.url,
    loading: false,
    readyState: "complete",
    sentinel: "document",
    unsaved: "edited",
  };
  assert.equal(nativeReady(state, native, expected), true);
  for (const [badState, badNative] of [
    [{ ...state, loading: true }, native],
    [{ ...state, error: "(-3) loading" }, native],
    [{ ...state, browser: { pageId: "other" } }, native],
    [state, { ...native, sentinel: undefined }],
    [state, { ...native, url: "about:blank" }],
    [state, { ...native, readyState: "loading" }],
  ])
    assert.equal(nativeReady(badState, badNative, expected), false);
  const request = {
    ...expected,
    requestId: 5,
    operation: "observe",
    callId: "call",
    projectId: "project",
    coreInstanceId: "core",
    coreGeneration: "generation",
    browserHostId: "host",
    hostGeneration: 1,
    pageGeneration: 2,
    controlEpoch: 3,
  };
  const result = { ...request, text: "RC04_NATIVE_SENTINEL" };
  const item = {
    id: "item",
    type: "dynamicToolCall",
    tool: "browser_v1",
    callId: "call",
    status: "completed",
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  };
  const thread = { id: "thread", turns: [{ id: "new-turn", status: "completed", items: [item] }] };
  const record = { request, response: { requestId: 5, result } };
  assertObserve(record, thread, expected);
  for (const badRecord of [
    { ...record, request: { ...request, operation: "describe" } },
    { ...record, response: { requestId: 6, result } },
    { ...record, response: { requestId: 5, result: { ...result, pageId: "other" } } },
    { ...record, response: { requestId: 5, error: "host failed", result } },
  ])
    assert.throws(() => assertObserve(badRecord, thread, expected));
  for (const badItem of [
    { ...item, success: false },
    { ...item, callId: "local-describe" },
    { ...item, contentItems: [{ type: "inputText", text: "RC04_NATIVE_PAGE_OBSERVED" }] },
  ])
    assert.throws(() =>
      assertObserve(
        record,
        { ...thread, turns: [{ ...thread.turns[0], items: [badItem] }] },
        expected,
      ),
    );
  assert.throws(() =>
    assertObserve(record, { ...thread, turns: [{ ...thread.turns[0], id: "old-turn" }] }, expected),
  );
  // 保持工具回执与 Core 正文一致，避免因正文不一致而掩盖原生页面绑定缺失。
  for (const turnId of ["first-observe", "post-oversize-observe"]) {
    const phaseExpected = { ...expected, turnId };
    const phaseRequest = { ...request, turnId };
    const verifyPage = (nativeResult) => {
      const phaseItem = {
        ...item,
        contentItems: [{ type: "inputText", text: JSON.stringify(nativeResult) }],
      };
      const phaseThread = {
        ...thread,
        turns: [{ id: turnId, status: "completed", items: [phaseItem] }],
      };
      assertObserve(
        { request: phaseRequest, response: { requestId: 5, result: nativeResult } },
        phaseThread,
        phaseExpected,
      );
    };
    const phaseResult = { ...result, turnId };
    verifyPage(phaseResult);
    assert.throws(
      () => verifyPage({ ...phaseResult, nativeWebContentsId: 999 }),
      /nativeWebContentsId/,
      turnId,
    );
    assert.throws(
      () => verifyPage({ ...phaseResult, url: "https://wrong.invalid/" }),
      /url/,
      turnId,
    );
  }
  console.log(
    "native observation oracle: readiness and matched real-observe negative cases passed",
  );
}
