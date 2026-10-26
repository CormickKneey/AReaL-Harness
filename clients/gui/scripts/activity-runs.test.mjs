// CONV-ACTIVITY-01 / CONV-PARALLEL-01：连续同一阶段的工具合成一段；子代理开始与完成是各自成段的事件。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(
  new URL("../renderer/src/conversationPresentation.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { activityRuns, activityRunLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const tool = (id, name, extra = {}) => ({
  id,
  type: "dynamicToolCall",
  tool: name,
  status: "completed",
  success: true,
  arguments: {},
  contentItems: [],
  ...extra,
});
const shape = (runs) => runs.map((run) => [run.key, run.items.map((item) => item.id)]);

test("contiguous same-stage tools merge; a different stage starts a new run", () => {
  const rows = [
    tool("c1", "run_command"),
    tool("c2", "run_command"),
    tool("r1", "fs_read"),
    tool("s1", "search_files"),
    tool("c3", "run_command"),
  ];
  assert.deepEqual(shape(activityRuns(rows)), [
    ["运行命令", ["c1", "c2"]],
    ["探索", ["r1", "s1"]],
    ["运行命令", ["c3"]],
  ]);
});

test("reasoning groups and breaker rows stay on their own and split runs", () => {
  const spawn = tool("a1", "agent_spawn");
  const rows = [
    tool("c1", "run_command"),
    { id: "g1", type: "reasoningGroup", items: [] },
    tool("c2", "run_command"),
    spawn,
    tool("c3", "run_command"),
  ];
  assert.deepEqual(shape(activityRuns(rows, (item) => item === spawn)), [
    ["运行命令", ["c1"]],
    [null, ["g1"]],
    ["运行命令", ["c2"]],
    [null, ["a1"]],
    ["运行命令", ["c3"]],
  ]);
});

test("unknown tools merge only with the same tool name", () => {
  const rows = [
    tool("x1", "lookup_ticket"),
    tool("x2", "lookup_ticket"),
    tool("y1", "post_comment"),
  ];
  assert.deepEqual(shape(activityRuns(rows)), [
    ["调用 lookup_ticket", ["x1", "x2"]],
    ["调用 post_comment", ["y1"]],
  ]);
});

test("labels count completed steps; running uses the progressive form", () => {
  const done = { key: "运行命令", items: [tool("c1", "run_command"), tool("c2", "run_command")] };
  assert.equal(activityRunLabel(done), "已运行 2 条命令");
  const running = {
    key: "运行命令",
    items: [
      tool("c1", "run_command"),
      tool("c2", "run_command", { status: "inProgress", success: undefined }),
    ],
  };
  assert.equal(activityRunLabel(running), "正在运行命令");
});

test("a child's finish is drawn only from a settled wait receipt", async () => {
  const { agentSettlements } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  );
  const receipt = (name, value) =>
    tool("w", name, { contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });
  assert.deepEqual(
    agentSettlements(
      receipt("agent_wait", {
        threadId: "c1",
        status: "completed",
        settled: true,
        timedOut: false,
      }),
    ),
    [{ threadId: "c1", label: "已完成" }],
  );
  assert.deepEqual(
    agentSettlements(
      receipt("agent_wait", {
        threadId: "c1",
        status: "inProgress",
        settled: false,
        timedOut: true,
      }),
    ),
    [],
  );
  assert.deepEqual(
    agentSettlements(
      receipt("agent_wait_any", {
        completed: [
          { threadId: "c1", status: "completed", settled: true },
          { threadId: "c2", status: "cancelled", settled: true },
        ],
        pending: [],
      }),
    ),
    [
      { threadId: "c1", label: "已完成" },
      { threadId: "c2", label: "已中断" },
    ],
  );
  assert.deepEqual(
    agentSettlements(receipt("agent_read", { threadId: "c1", status: "completed", settled: true })),
    [],
    "reading a child is not observing its finish",
  );
  assert.deepEqual(
    agentSettlements({
      ...receipt("agent_wait", { threadId: "c1", status: "completed", settled: true }),
      status: "failed",
      success: false,
    }),
    [],
  );
});
