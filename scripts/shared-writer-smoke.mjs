// 真实 Core/Runtime：作者等待模型时让出已结算租约，后台进程仍保留租约直到取消结算。
import assert from "node:assert/strict";
import { respondToSessionName } from "./model-fixture.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";

const root = await mkdtemp(join(tmpdir(), "areal-shared-writer-"));
const workspace = join(root, "workspace");
const data = join(root, "data");
await mkdir(workspace);
await writeFile(
  join(root, "config.toml"),
  'schema_version=1\n[network]\nretry_mode="bounded"\n[limits]\nmax_repeated_tool_failures=2\n',
);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let failure,
  rpc,
  child,
  diagnostic = "";
let serial = 0;
const waiting = new Map();
const arrivals = [];
const calls = [];
let staleCallIds = [];
let staleBatchObserved = false;
const reconsideredCommand = {
  argv: ["/bin/sh", "-c", "echo accepted-after-observation > redecided.txt"],
  timeoutMs: 5000,
};
function reply(response, name, args, text = "final verified handoff", additional = []) {
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = name
    ? {
        tool_calls: [{ name, args }, ...additional].map((call, index) => ({
          index,
          id: `lease-${++serial}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      }
    : { content: text };
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
  return delta.tool_calls?.map((call) => call.id) ?? [];
}
const model = createServer(async (request, response) => {
  try {
    let bytes = "";
    for await (const part of request) bytes += part;
    const input = JSON.parse(bytes);
    if (respondToSessionName(input, response)) return;
    const body = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    const taskIndex = input.messages.findLastIndex(
      (m) =>
        m.role === "user" && !body(m).startsWith("AReaL runtime context (not a user request):"),
    );
    const text = body(input.messages[taskIndex]);
    const toolMessages = input.messages.slice(taskIndex + 1).filter((m) => m.role === "tool");
    const results = toolMessages.map((m) => JSON.parse(m.content));
    const worker = text.match(/LEASE_WORKER:([abx])/);
    calls.push({ worker: worker?.[1] ?? "parent", results: results.length, at: Date.now() });
    if (worker) {
      const key = worker[1];
      if (!results.length) {
        if (key === "x")
          return reply(response, "run_command", {
            argv: ["/bin/sleep", "30"],
            yieldMs: 0,
            timeoutMs: 60000,
          });
        return reply(response, "fs_create", { path: `${key}.txt`, text: `${key} committed\n` });
      }
      const last = results.at(-1);
      const conflict = results.find((result) => result.error?.code === "CONFLICT");
      if (conflict) {
        assert.match(conflict.error.message, /NOT executed/);
        if (key === "a" && !staleBatchObserved) {
          assert.equal(staleCallIds.length, 5);
          for (const id of staleCallIds) {
            const paired = toolMessages.filter((message) => message.tool_call_id === id);
            assert.equal(
              paired.length,
              1,
              `missing or duplicate receipt for advertised call ${id}`,
            );
            const result = JSON.parse(paired[0].content);
            assert.equal(result.error?.code, "CONFLICT", JSON.stringify(result));
            assert.match(result.error.message, /WORKSPACE_CHANGED_BEFORE_EXECUTION.*NOT executed/);
          }
          for (const path of ["stale-command.txt", "stale-followup.txt", "redecided.txt"])
            await assert.rejects(
              access(join(workspace, path)),
              `stale response executed ${path} before the model observed the conflict`,
            );
          staleBatchObserved = true;
          return reply(response, "run_command", reconsideredCommand);
        }
        if (key === "a") {
          assert.equal(last.error, undefined, JSON.stringify(last));
          assert.equal(last.exitCode, 0, JSON.stringify(last));
        }
        if (results.some((result) => result.sha256))
          return reply(
            response,
            null,
            null,
            "stale command rejected before execution; source inspected by parent",
          );
        return reply(response, "fs_create", { path: `${key}.txt`, text: `${key} committed\n` });
      }
      if (key === "x") assert.equal(last.commandStatus, "running");
      else assert(last.sha256, JSON.stringify(results));
      arrivals.push(key);
      waiting.set(key, response);
      return;
    }
    if (text.includes("LEASE_PARENT")) {
      if (results.length < 2)
        return reply(response, "agent_spawn", {
          prompt: `LEASE_WORKER:${results.length ? "b" : "a"}`,
          intent: "modify",
          delivery: "changes",
          writes: [`${results.length ? "b" : "a"}.txt`],
          requiresCurrentEnvironment: true,
        });
      if (results.length === 2) {
        const end = Date.now() + 5000;
        while (!(waiting.has("a") && waiting.has("b"))) {
          assert(Date.now() < end, "authors did not yield their effect leases");
          await delay(10);
        }
        return reply(response, "fs_create", {
          path: "parent.txt",
          text: "parent progressed while authors wait\n",
        });
      }
      if (results.length === 3) {
        assert(results[2].sha256, JSON.stringify(results[2]));
        // 先归还父模型请求容量，再等待作者；fixture 自身不能占名额制造假死。
        void (async () => {
          const end = Date.now() + 5000;
          while (!(waiting.has("a") && waiting.has("b"))) {
            assert(Date.now() < end, "shared writers serialized during model wait");
            await delay(10);
          }
          for (const key of ["a", "b"]) {
            if (key === "a")
              staleCallIds = reply(
                waiting.get(key),
                "run_command",
                {
                  argv: ["/bin/sh", "-c", "echo must-not-run > stale-command.txt"],
                  timeoutMs: 5000,
                },
                "",
                [
                  {
                    name: "run_command",
                    args: {
                      argv: ["/bin/sh", "-c", "echo must-not-run > stale-followup.txt"],
                      timeoutMs: 5000,
                    },
                  },
                  ...Array.from({ length: 3 }, () => ({
                    name: "run_command",
                    args: reconsideredCommand,
                  })),
                ],
              );
            else reply(waiting.get(key), null);
            waiting.delete(key);
          }
        })().catch((error) => {
          failure ??= error;
          for (const response of waiting.values()) response.destroy();
        });
      }
      const executions = results.slice(0, 2).map((r) => r.executionId);
      const settled = new Set(
        results
          .flatMap((r) => r.completed ?? [r])
          .filter((r) => r.settled && r.resourcesReleased)
          .map((r) => r.executionId),
      );
      const pending = executions.filter((id) => !settled.has(id));
      if (pending.length)
        return reply(response, "agent_wait_any", { executionIds: pending, timeoutMs: 10000 });
      return reply(response, null);
    }
    if (text.includes("LEASE_PIN_PARENT")) {
      if (!results.length)
        return reply(response, "agent_spawn", {
          prompt: "LEASE_WORKER:x",
          intent: "modify",
          delivery: "changes",
          writes: ["unused.txt"],
          requiresCurrentEnvironment: true,
        });
      if (results.length === 1) {
        const end = Date.now() + 5000;
        while (!waiting.has("x")) {
          assert(Date.now() < end, "background worker never entered model wait");
          await delay(10);
        }
        return reply(response, "fs_create", {
          path: "after-cancel.txt",
          text: "released after cleanup\n",
        });
      }
      assert(results[1].sha256, JSON.stringify(results));
      return reply(response, null, null, "cancelled child; source progressed after cleanup");
    }
    throw Error(`unexpected model input: ${text.slice(0, 180)}`);
  } catch (error) {
    failure ??= error;
    response.destroy(error);
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
try {
  child = spawn(
    "python3",
    [
      "scripts/launch.py",
      "--config",
      join(root, "config.toml"),
      "--bin-dir",
      resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug"),
      "--listen",
      "127.0.0.1:0",
      "--data-dir",
      data,
      "--workspace",
      workspace,
      "--allow-write",
      "--permissions",
      "yolo",
      "--model-endpoint",
      `http://127.0.0.1:${model.address().port}/`,
      "--model",
      "fixture",
      "--model-concurrency",
      "4",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = once(child, "exit");
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-65536);
  });
  const end = Date.now() + 20000;
  while (!/ws:\/\/127\.0\.0\.1:\d+/.test(diagnostic)) {
    assert(Date.now() < end && child.exitCode === null, diagnostic);
    await delay(20);
  }
  rpc = await connect(
    diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+/)[0],
    join(data, "security/auth.json"),
  );
  async function start(prompt) {
    const { thread } = await rpc.call("thread/start");
    const { turn } = await rpc.call("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: prompt }],
    });
    return { thread, turn };
  }
  async function settled({ thread, turn }) {
    const event = await rpc.waitEvent(
      "turn/completed",
      (event) => event.threadId === thread.id && event.turn.id === turn.id,
    );
    assert.equal(failure, undefined, failure?.stack);
    assert.equal(event.turn.status, "completed", JSON.stringify(event));
  }
  await settled(await start("LEASE_PARENT"));
  for (const name of ["a", "b", "parent"])
    assert((await readFile(join(workspace, `${name}.txt`), "utf8")).length > 0);
  await assert.rejects(
    access(join(workspace, "stale-command.txt")),
    "stale source command executed before rebase",
  );
  await assert.rejects(
    access(join(workspace, "stale-followup.txt")),
    "a later write from the same stale response executed after the first conflict",
  );
  assert(staleBatchObserved, "the model never observed all stale call receipts");
  assert.equal(
    await readFile(join(workspace, "redecided.txt"), "utf8"),
    "accepted-after-observation\n",
  );
  const pinned = await start("LEASE_PIN_PARENT");
  const until = Date.now() + 10000;
  while (!waiting.has("x")) {
    assert(Date.now() < until);
    await delay(10);
  }
  await delay(150);
  await assert.rejects(
    access(join(workspace, "after-cancel.txt")),
    "running process lost its writer lease",
  );
  const records = await rpc.call("areal/execution/list", {
    parentThreadId: pinned.thread.id,
    offset: 0,
    limit: 20,
  });
  const items = records.data;
  assert(items?.length, JSON.stringify(records));
  const executionId = items[0].executionId;
  await rpc.call("areal/execution/cancel", {
    parentThreadId: pinned.thread.id,
    executionId,
    mode: "graceful",
  });
  reply(waiting.get("x"), null, null, "terminal tail after cancellation");
  waiting.delete("x");
  await settled(pinned);
  assert((await readFile(join(workspace, "after-cancel.txt"), "utf8")).length > 0);
  const result = {
    passed: true,
    root,
    authorsReachedModelWait: arrivals,
    calls,
    staleCallIds,
    checks: [
      "independent shared authors reach model wait concurrently",
      "parent source write progresses while authors wait",
      "running managed process pins writer lease",
      "stale source command rejected before dispatch",
      "all writes from the stale response stay unexecuted until the model observes the conflict",
      "a fresh model decision can write after observing the conflict",
      "three identical suppressed calls do not exhaust the finite repeated-failure limit",
      "cancellation settles resources before parent source write",
    ],
  };
  if (process.env.AREAL_SHARED_WRITER_EVIDENCE)
    await writeFile(process.env.AREAL_SHARED_WRITER_EVIDENCE, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await rpc.close();
  rpc = null;
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0, diagnostic);
} finally {
  for (const response of waiting.values()) response.destroy();
  await rpc?.close();
  if (child?.exitCode === null) child.kill("SIGTERM");
  await writeFile(join(root, "stderr.log"), diagnostic);
  await writeFile(
    join(root, "calls.json"),
    JSON.stringify({ calls, arrivals, failure: failure?.stack }, null, 2),
  );
  model.closeAllConnections();
  model.close();
}
