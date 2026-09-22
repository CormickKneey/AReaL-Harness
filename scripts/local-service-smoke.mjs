// 真实 Core/Runtime 验证跨进程复用、客户端独立生命周期和故障恢复。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { connect as unixConnect } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";
const exec = promisify(execFile);
const root = await realpath(await mkdtemp("/tmp/as-"));
const workspace = join(root, "workspace"),
  home = join(root, "home"),
  config = join(root, "config.toml");
const bin = resolve("target/debug/areal");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AREAL_") && !key.startsWith("OTEL_"),
    ),
  ),
  AREAL_HARNESS_HOME: home,
  HOME: join(root, "user"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
const requests = [];
const clients = [],
  held = [];
const model = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const request = JSON.parse(body);
  const text = request.messages.at(-1).content;
  requests.push({ model: request.model, text });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "reply:" + text }, finish_reason: null }] })}\n\n`,
  );
  const finish = () =>
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  if (text === "hang") held.push(finish);
  else finish();
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
async function cli(args) {
  const { stdout } = await exec(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      "import subprocess,sys; sys.exit(subprocess.call(sys.argv[1:]))",
      bin,
      ...args,
    ],
    { env, timeout: 80000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
const local = ["--workspace", workspace, "--config", config];
const ensure = (extra = []) =>
  cli([
    "service",
    "ensure",
    "--json",
    ...local.filter((_, i) => !extra.includes(local[i - (i % 2)])),
    ...extra,
  ]);
const stop = (s, cancel = false) =>
  cli(["service", "stop", "--json", "--instance", s.serviceId, ...(cancel ? ["--cancel"] : [])]);
async function client(s) {
  const c = await connect(s.endpoint, s.authFile);
  clients.push(c);
  return c;
}
async function until(fn) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("condition timed out");
}
async function rejected(fn, pattern) {
  await assert.rejects(fn, (e) => pattern.test(e.stderr ?? e.message));
}
async function children(pid) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid="]);
  return stdout
    .trim()
    .split("\n")
    .map((s) => s.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === pid)
    .map(([id]) => id);
}
async function dead(pid) {
  await until(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      if (e.code === "ESRCH") return true;
      throw e;
    }
  });
}
async function control(s, request) {
  const socket = unixConnect(join(home, "services", s.serviceId, "control.sock"));
  await once(socket, "connect");
  socket.end(JSON.stringify(request) + "\n");
  let output = "";
  for await (const b of socket) output += b;
  return JSON.parse(output);
}
let current;
try {
  await mkdir(workspace);
  await writeFile(
    config,
    `schema_version = 1\n[model]\nname = "fixture"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n`,
  );
  const services = await Promise.all(Array.from({ length: 4 }, () => ensure()));
  current = services[0];
  assert(
    services.every(
      (s) =>
        s.serviceId === current.serviceId &&
        s.generation === current.generation &&
        s.corePid === current.corePid,
    ),
  );
  assert.equal((await cli(["web", "--json", ...local])).generation, current.generation);
  await symlink(workspace, join(root, "alias"));
  assert.equal((await ensure(["--workspace", join(root, "alias")])).generation, current.generation);
  await rejected(() => ensure(["--allow-network"]), /configuration conflict.*permissions/s);
  assert.equal((await fetch(current.webUrl)).status, 200);
  const url = new URL("/areal/service", current.webUrl);
  assert.equal((await fetch(url)).status, 401);
  const auth = JSON.parse(await readFile(current.authFile, "utf8")).principals[0].token;
  assert.equal(
    (
      await fetch(url, {
        headers: { Authorization: `Bearer ${auth}`, Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await (await fetch(url, { headers: { Authorization: `Bearer ${auth}` } })).json()).generation,
    current.generation,
  );
  assert(!JSON.stringify(current).includes(auth));
  assert.equal(
    (await control(current, { method: "stop", version: 1, generation: "stale", cancel: true }))
      .result,
    "error",
  );
  const first = await client(current),
    second = await client(current);
  const { thread } = await first.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: workspace,
  });
  await second.call("thread/resume", { threadId: thread.id });
  await first.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: "hang" }],
  });
  await until(() => held.length > 0);
  await first.close();
  await rejected(() => stop(current), /service is busy/);
  held.shift()();
  const completed = await second.waitEvent("turn/completed", (p) => p.threadId === thread.id);
  assert.equal(completed.turn.status, "completed");
  await exec(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      resolve("scripts/local-service-pty.py"),
      resolve("target/debug/areal-tui"),
      ...local,
    ],
    { env, timeout: 45000 },
  );
  assert.equal(
    (await cli(["service", "status", "--instance", current.serviceId])).generation,
    current.generation,
  );
  const ws2 = join(root, "other");
  await mkdir(ws2);
  const other = await ensure(["--workspace", ws2]);
  assert.notEqual(other.serviceId, current.serviceId);
  await rejected(
    () => ensure(["--workspace", ws2, "--data-dir", current.dataDir]),
    /bound to a different workspace/s,
  );
  await stop(other);
  // 没有配置模型的 Web 管理入口仍须能启动并输出发现信息。
  const empty = join(root, "empty.toml");
  await writeFile(empty, "schema_version = 1\n");
  const unconfigured = await ensure(["--workspace", ws2, "--config", empty]);
  await stop(unconfigured);
  await second.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: "hang" }],
  });
  await until(() => held.length > 0);
  assert.equal((await stop(current, true)).state, "stopped");
  await dead(current.corePid);
  const old = current;
  current = await ensure();
  assert.equal(current.serviceId, old.serviceId);
  assert.notEqual(current.generation, old.generation);
  const resumed = await client(current);
  const snapshot = await resumed.call("thread/resume", { threadId: thread.id });
  assert.equal(snapshot.thread.turns.length, 2);
  await resumed.close();
  // 强杀启动器和宿主均须关闭旧 Core/Runtime，然后才能产生下一代实例。
  for (const victim of ["launcher", "host"]) {
    const [launcher] = await children(current.hostPid);
    assert(launcher);
    const processes = await children(launcher);
    assert(processes.includes(current.corePid));
    if (victim === "host") {
      const runtime = processes.find((pid) => pid !== current.corePid);
      assert(runtime);
      // 让 Runtime 清理停在可观测窗口：Core 锁已释放，launcher 仍须阻止替代实例。
      process.kill(runtime, "SIGSTOP");
      try {
        process.kill(current.hostPid, "SIGKILL");
        process.kill(current.corePid, "SIGKILL");
        await dead(current.hostPid);
        await dead(current.corePid);
        await rejected(() => ensure(), /active owner but cannot be reached/);
      } finally {
        process.kill(runtime, "SIGCONT");
      }
    } else {
      process.kill(launcher, "SIGKILL");
    }
    for (const pid of processes) await dead(pid);
    await until(
      async () =>
        (await cli(["service", "status", "--instance", current.serviceId])).state === "stopped",
    );
    const previous = current;
    current = await ensure();
    assert.notEqual(current.generation, previous.generation);
  }
  await exec(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      resolve("scripts/local-service-pty.py"),
      resolve("target/debug/areal-tui"),
      ...local,
    ],
    { env: { ...env, TEST_EXPLICIT_STOP: "1" }, timeout: 45000 },
  );
  assert.equal(
    (await cli(["service", "status", "--instance", current.serviceId])).state,
    "stopped",
  );
  await cli(["service", "bind", ...local.slice(0, 2), "--data-dir", current.dataDir]);
  assert.equal((await ensure()).serviceId, current.serviceId);
  assert(
    (await cli(["service", "list", "--json"])).some(
      (s) => s.serviceId === current.serviceId && s.state === "ready",
    ),
  );
  held.splice(0);
  current = await ensure();
  const hot = await client(current);
  const hotConfig = (name, extra = "") =>
    `schema_version = 1\n[model]\nname = "${name}"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:${model.address().port}"\n${extra}`;
  const { thread: hotThread } = await hot.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: workspace,
  });
  await hot.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "hang" }],
  });
  await until(() => held.length > 0);
  await hot.call("areal/turn/enqueue", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "queued-before-reload" }],
  });
  await writeFile(config, hotConfig("fixture-new"));
  await until(async () =>
    (await hot.call("areal/model/list", {})).data.some((m) => m.modelId === "fixture-new"),
  );
  assert.equal((await ensure()).generation, current.generation);
  assert.equal(
    (await cli(["service", "status", "--workspace", workspace])).generation,
    current.generation,
  );
  await rejected(() => cli(["service", "restart", ...local]), /service is busy/);
  assert.equal((await hot.call("areal/server/status", {})).acceptingWork, true);
  held.shift()();
  await until(() => requests.some((r) => r.text === "queued-before-reload"));
  assert.equal(requests.find((r) => r.text === "queued-before-reload").model, "fixture");
  await until(
    async () =>
      (await hot.call("thread/read", { threadId: hotThread.id, includeTurns: true })).thread.status
        .type === "idle",
  );
  await hot.call("areal/turn/start", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "after-reload" }],
  });
  await until(() => requests.some((r) => r.text === "after-reload"));
  assert.equal(requests.find((r) => r.text === "after-reload").model, "fixture-new");
  await until(async () => (await hot.call("areal/server/status", {})).restartSafe);
  // 非法编辑保留旧配置，修复后无需重启即可再次更新。
  await writeFile(config, "schema_version = 1\n[model\n");
  await until(async () => (await hot.call("areal/server/status", {})).configuration.error);
  assert((await hot.call("areal/model/list", {})).data.some((m) => m.modelId === "fixture-new"));
  await writeFile(config, hotConfig("fixture-new"));
  await until(async () => !(await hot.call("areal/server/status", {})).configuration.error);
  // 暂停队列跨重启恢复，仍使用提交时的默认模型版本。
  const q = await hot.call("areal/queue/list", { threadId: hotThread.id });
  await hot.call("areal/queue/pause", { threadId: hotThread.id, expectedRevision: q.revision });
  await hot.call("areal/turn/enqueue", {
    requestId: crypto.randomUUID(),
    threadId: hotThread.id,
    input: [{ type: "text", text: "queued-across-restart" }],
  });
  await writeFile(config, hotConfig("fixture-third"));
  await until(async () =>
    (await hot.call("areal/model/list", {})).data.some((m) => m.modelId === "fixture-third"),
  );
  const beforeRestart = current;
  current = await cli(["service", "restart", ...local, "--cancel"]);
  assert.notEqual(current.generation, beforeRestart.generation);
  const restored = await client(current);
  await restored.call("thread/resume", { threadId: hotThread.id });
  const paused = await restored.call("areal/queue/list", { threadId: hotThread.id });
  await restored.call("areal/queue/resume", {
    threadId: hotThread.id,
    expectedRevision: paused.revision,
  });
  await until(() => requests.some((r) => r.text === "queued-across-restart"));
  assert.equal(requests.find((r) => r.text === "queued-across-restart").model, "fixture-new");
  await until(async () => (await restored.call("areal/server/status", {})).restartSafe);
  // 不可热更新的限额由 ensure 在空闲时自动重启，保留会话。
  await writeFile(config, hotConfig("fixture-third", "[limits]\nmax_threads = 1234\n"));
  const previousGeneration = current.generation;
  current = await ensure();
  assert.notEqual(current.generation, previousGeneration);
  const finalClient = await client(current);
  assert.equal((await finalClient.call("areal/server/status", {})).capacity.maxThreads, 1234);
  assert(
    (await finalClient.call("thread/resume", { threadId: hotThread.id })).thread.turns.length >= 4,
  );
  await exec(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      resolve("scripts/local-service-pty.py"),
      resolve("target/debug/areal-tui"),
      ...local,
    ],
    { env: { ...env, TEST_RELOAD_CONFIG: config }, timeout: 60000 },
  );
  await cli(["service", "stop", "--workspace", workspace]);
  console.log(
    "PASS shared local service: concurrent ensure, TUI windows, Web discovery, auth, busy/cancel stop, workspace isolation, history and crash recovery",
  );
} finally {
  for (const c of clients) await c.close().catch(() => {});
  for (const s of await cli(["service", "list"]).catch(() => []))
    if (s.state === "ready") await stop(s, true).catch((e) => console.error(e.stderr ?? e));
  model.closeAllConnections();
  model.close();
  await rm(root, { recursive: true, force: true });
}
