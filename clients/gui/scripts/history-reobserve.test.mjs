import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { CoreTaskModel } from "../packages/workbench/client/core-model.js";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { CoreBackend } = require("../app/src/core/backend.cjs");

// 最新一轮超过一页：补全时最后一页带上一轮的尾部条目，与真实 Core 的分页边界一致。
const latest = () => ({
  thread: {
    id: "thread",
    status: "active",
    turns: [
      {
        id: "active",
        status: "inProgress",
        items: [{ id: "live", type: "agentMessage", text: "LIVE" }],
      },
    ],
  },
  history: { snapshotId: "snapshot", nextCursor: "active:0", complete: false },
});
const entry = (turnId, status, item) => ({
  sourceThreadId: "thread",
  sourceTurnId: turnId,
  sourceItemId: item.id,
  sourceTurnStatus: status,
  turn: { id: turnId, status },
  item,
});

function fixture() {
  const model = new CoreTaskModel();
  const project = { id: "project", model, connectionGeneration: 1 };
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    projects: new Map([[project.id, project]]),
    providers: { redact: (value) => value },
    library: { recordThreadActivity: async () => {} },
    onChange: () => {},
  });
  project.client = {
    ready: true,
    closed: false,
    capabilities: { features: { boundedObservation: true, boundedHistory: true } },
    request: async (method, params) => {
      assert.equal(method, "areal/conversation/history");
      // 页内条目按时间顺序；第一页只含本轮，第二页跨到上一轮尾部。
      if (params.cursor === "active:0")
        return {
          snapshotId: "snapshot",
          data: [entry("active", "inProgress", { id: "step", type: "agentMessage", text: "STEP" })],
          nextCursor: "active:1",
          complete: false,
        };
      if (params.cursor === "active:1")
        return {
          snapshotId: "snapshot",
          data: [
            entry("previous", "completed", {
              id: "previous-answer",
              type: "agentMessage",
              text: "PREVIOUS",
            }),
            entry("active", "inProgress", {
              id: "user",
              type: "userMessage",
              content: [{ type: "text", text: "USER" }],
            }),
          ],
          nextCursor: "previous:1",
          complete: false,
        };
      throw new Error(`unexpected cursor ${params.cursor}`);
    },
  };
  return { backend, project, model };
}

const shape = (thread) =>
  (thread?.turns ?? []).map((turn) => `${turn.id}:${turn.items.map((item) => item.id).join("+")}`);

test("re-observing a mounted view keeps the displayed boundary turn and its order", async () => {
  const { backend, project, model } = fixture();
  backend.installObservation(project, latest());
  await backend.historyCommand(project, {
    threadId: "thread",
    viewId: "view",
    operation: "acquire",
  });
  const settled = shape(model.state.threads.thread);
  assert.deepEqual(settled, ["previous:previous-answer", "active:user+step+live"]);
  assert.equal(model.state.threads.thread.displayHistory.latestTurnComplete, true);

  const published = [];
  const unsubscribe = model.subscribe(() => published.push(shape(model.state.threads.thread)));
  // 打开会话、上下文压缩等路径会重新观察；同一连接、未失效的窗口不应先清掉已显示内容再补回。
  backend.installObservation(project, latest());
  await backend.historyCommand(project, {
    threadId: "thread",
    viewId: "view",
    operation: "acquire",
  });
  unsubscribe();
  assert.ok(published.length > 0);
  for (const turns of published) assert.deepEqual(turns, settled);
});

test("re-observation does not keep pages loaded through load-older", async () => {
  const { backend, project, model } = fixture();
  const request = project.client.request;
  project.client.request = async (method, params) =>
    params.cursor === "previous:1"
      ? {
          snapshotId: "snapshot",
          data: [
            entry("oldest", "completed", {
              id: "oldest-answer",
              type: "agentMessage",
              text: "OLDEST",
            }),
          ],
          nextCursor: null,
          complete: true,
        }
      : request(method, params);
  backend.installObservation(project, latest());
  const view = { threadId: "thread", viewId: "view" };
  await backend.historyCommand(project, { ...view, operation: "acquire" });
  await backend.historyCommand(project, { ...view, operation: "loadOlder" });
  assert.deepEqual(shape(model.state.threads.thread), [
    "oldest:oldest-answer",
    "previous:previous-answer",
    "active:user+step+live",
  ]);
  // 新窗口的分页游标从新快照开始；保留旧分页内容会让“加载更早”重复读到同一页。
  backend.installObservation(project, latest());
  assert.deepEqual(shape(model.state.threads.thread), [
    "previous:previous-answer",
    "active:user+step+live",
  ]);
  assert.equal(model.state.threads.thread.displayHistory.complete, false);
});
