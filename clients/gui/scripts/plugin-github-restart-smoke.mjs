import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, cp, rm, chmod, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CoreClient } from "../packages/runtime-client/core.js";
import { createProjectConversation, selectConversation } from "./smoke-navigation.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json")),
  { _electron: electron } = require("playwright-core"),
  WebSocket = require("ws"),
  exec = promisify(execFile);
function requiredEnv(name) {
  assert(process.env[name], name + " is required");
  return process.env[name];
}
const inputs = JSON.parse(await readFile(requiredEnv("AREAL_GITHUB_INPUTS"), "utf8"));
const evidence = resolve(
  process.env.AREAL_GITHUB_EVIDENCE_DIR ??
    join(root, ".scratch/github-mcp-fix-20261016/test-" + Date.now()),
);
await mkdir(evidence, { recursive: true });
const scratch = await makeTempDir("areal-github-gui-");
await chmod(scratch, 0o700);
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user"),
  coreHome = join(scratch, "core");
await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
await mkdir(coreHome);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const projectId = createHash("sha256").update(workspace).digest("hex").slice(0, 24),
  dataDir = join(coreHome, projectId, "state");
const liveHome = requiredEnv("AREAL_GITHUB_CREDENTIAL_HOME");
const liveProject = requiredEnv("AREAL_GITHUB_CREDENTIAL_PROJECT");
const binary = resolve(process.env.AREAL_CORE_BIN ?? join(root, "target/debug/areal"));
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: coreHome,
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: binary,
};
for (const key of Object.keys(env))
  if (
    /^AREAL_CREDENTIAL_|^AREAL_PLUGIN_CONNECTOR_/.test(key) ||
    [
      "AREAL_CORE_WORKSPACE",
      "AREAL_CORE_CONFIG",
      "AREAL_HARNESS_HOME",
      "AREAL_HARNESS_CONFIG",
      "AREAL_CORE_DESKTOP_CONFIG",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ].includes(key)
  )
    delete env[key];
env.NO_PROXY = [env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
env.no_proxy = env.NO_PROXY;
const cliEnv = {
  ...env,
  AREAL_HARNESS_HOME: join(userHome, ".areal"),
  [inputs.provider.apiKeyEnv]: "empty-thread-bootstrap-only",
};
const checks = [],
  rounds = [],
  errors = [],
  cleanup = [],
  profiles = [],
  cacheFiles = [];
let app,
  page,
  bootstrap,
  client,
  phase = "setup",
  failure,
  passed = false,
  threadId,
  bootstrapThreadId;
function mark(value) {
  phase = value;
  console.log(JSON.stringify({ phase }));
}
const currentCalls = new Map();
function identityResult(content) {
  let value = content;
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  if (!value || typeof value !== "object" || value.isError === true) return false;
  if (typeof value.login === "string" && value.login.length) return true;
  return Array.isArray(value)
    ? value.some(identityResult)
    : Object.values(value).some((v) =>
        typeof v === "object" || typeof v === "string" ? identityResult(v) : false,
      );
}
const safeError = (e) =>
  String(e.message ?? e)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .slice(0, 1000);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const source = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  diff: sha(
    execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
  ),
  core: sha(await readFile(binary)),
  acceptanceScript: sha(await readFile(fileURLToPath(import.meta.url))),
  rendererIndex: sha(await readFile(join(gui, "renderer/dist/index.html"))),
};
const relay = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks),
      q = JSON.parse(body),
      names = (q.tools ?? []).map((t) => t.function?.name).filter(Boolean),
      toolResults = (q.messages ?? []).filter((m) => m.role === "tool");
    const metadata = {
      phase,
      model: q.model,
      tools: names,
      toolResultCount: toolResults.length,
      successfulIdentityResult: toolResults.some(
        (m) => currentCalls.get(m.tool_call_id) === phase && identityResult(m.content),
      ),
      calls: [],
    };
    rounds.push(metadata);
    assert(
      names.some((n) => n.endsWith("__get_me")),
      "model request missing GitHub __get_me tool",
    );
    assert(rounds.length <= 12, "bounded real-provider acceptance rounds");
    const headers = {
      "Content-Type": "application/json",
      ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
    };
    const upstream = await fetch(inputs.provider.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(180000),
    });
    const responseChunks = [];
    for await (const chunk of upstream.body) responseChunks.push(Buffer.from(chunk));
    const responseBody = Buffer.concat(responseChunks),
      wire = responseBody.toString("utf8");
    const emitted = new Map();
    const packet = (value) => {
      for (const choice of value.choices ?? []) {
        const calls = choice.delta?.tool_calls ?? choice.message?.tool_calls ?? [];
        for (let i = 0; i < calls.length; i++) {
          const t = calls[i],
            index = t.index ?? i,
            item = emitted.get(index) ?? { id: "", name: "" };
          if (t.id) item.id = t.id;
          item.name += t.function?.name ?? "";
          emitted.set(index, item);
        }
      }
    };
    if (wire.trimStart().startsWith("{")) {
      try {
        packet(JSON.parse(wire));
      } catch {}
    } else
      for (const line of wire.split("\n")) {
        const match = /^data:\s*(.+)/.exec(line.trimStart());
        if (!match) continue;
        try {
          packet(JSON.parse(match[1]));
        } catch {}
      }
    for (const item of emitted.values()) {
      metadata.calls.push(item);
      if (item.id && item.name.endsWith("__get_me")) currentCalls.set(item.id, metadata.phase);
    }
    metadata.upstreamStatus = upstream.status;
    metadata.contentType = upstream.headers.get("content-type");
    metadata.responseBytes = responseBody.length;
    assert(
      metadata.calls.every((c) => c.name.endsWith("__get_me")),
      "model emitted a tool outside authorized read-only get_me",
    );
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
    });
    res.end(responseBody);
  } catch (e) {
    errors.push({ phase: "relay", message: safeError(e) });
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "GitHub acceptance relay failed" } }));
  }
});
async function cacheSnapshot(label) {
  const directory = join(dataDir, "private/mcp-auth"),
    files = await readdir(directory),
    states = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const v = JSON.parse(await readFile(join(directory, file), "utf8"));
    states.push({
      file,
      tokenPresent: !!(v.tokenResponse ?? v.token_response),
      grantedScopes: v.grantedScopes ?? v.granted_scopes,
      issuer: v.issuer,
    });
  }
  cacheFiles.push({ phase: label, files, states });
}
async function writableDirectories(path) {
  await chmod(path, 0o700);
  for (const e of await readdir(path, { withFileTypes: true }))
    if (e.isDirectory()) await writableDirectories(join(path, e.name));
}
async function poll(read, predicate, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await read();
    if (predicate(v)) return v;
    await delay(150);
  }
  throw Error("timeout: " + label);
}
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function command(name, request) {
  const r = await page.evaluate(({ name, request }) => window.arealDesktop.command(name, request), {
    name,
    request,
  });
  assert(r.ok, r.error?.message ?? "desktop command failed");
  return r.value;
}
async function manage(operation, extra = {}) {
  return command("manage", { projectId, operation, ...extra });
}
async function cli(args) {
  return JSON.parse(
    (await exec(binary, args, { env: cliEnv, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout,
  );
}
async function stopBootstrap() {
  client?.close();
  if (bootstrap) {
    const s = await cli([
      "service",
      "stop",
      "--json",
      "--workspace",
      workspace,
      "--expected-generation",
      bootstrap.generation,
      "--cancel",
    ]);
    assert.equal(s.state, "stopped");
    cleanup.push({ generation: bootstrap.generation, state: s.state });
    bootstrap = null;
  }
}
async function stopGui() {
  if (app) {
    await app.close();
    app = null;
  }
  const { ServiceConnection } = require("../app/src/core/service-client.cjs"),
    c = new ServiceConnection();
  try {
    const m = JSON.parse(await readFile(join(coreHome, "service.json"), "utf8"));
    await c.connect(m);
    await c.request("hello", { protocol: m.protocol, identity: m.identity });
    const { DesktopLifecycle } = require("../app/src/core/lifecycle.cjs");
    const lifecycle = new DesktopLifecycle({
      connection: c,
      metadata: m,
      home: coreHome,
      forUpdate: true,
      notify: async () => ({ response: 1 }),
    });
    await lifecycle.stop({ mode: failure || errors.length ? "cancel" : "ifIdle" });
    await poll(
      async () => {
        try {
          process.kill(m.pid, 0);
          return false;
        } catch (e) {
          if (e.code === "ESRCH") return true;
          throw e;
        }
      },
      Boolean,
      "isolated Main backend exited",
      20000,
    );
    cleanup.push({ pid: m.pid, exited: true });
  } finally {
    c.close();
  }
}
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(25000);
  page.on("pageerror", (e) => errors.push({ phase: "page", message: safeError(e) }));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await poll(state, (s) => s.connection?.state === "ready", "desktop ready");
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
  }, workspace);
}
async function send(label) {
  const before = rounds.length;
  await page
    .getByTestId("chat-input")
    .fill(
      "GitHub MCP 只读验收 " +
        label +
        "：只调用当前工具列表中名称后缀为 __get_me 的工具一次，读取已授权账户身份，报告成功及登录名。不要运行命令、gh、ATC、浏览器或更改任何数据。没有该工具请明确报告。",
    );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction((seed) => {
    const id = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
    return id && id !== "new" && id !== seed;
  }, bootstrapThreadId);
  threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  await poll(
    async () => {
      if (errors.length) throw Error("acceptance relay/page failure: " + errors.at(-1).message);
      return page.getByRole("button", { name: "停止", exact: true }).count();
    },
    (count) => count === 0 && rounds.length > before,
    "GUI turn terminal",
    240000,
  );
  const s = await poll(
      state,
      (s) => !!s.projects.find((p) => p.id === projectId)?.configurations?.[threadId],
      "accepted thread configuration",
    ),
    project = s.projects.find((p) => p.id === projectId);
  const accepted = project.configurations[threadId].profile;
  assert(accepted?.allowPluginSkills === true, "ordinary GUI chat permits plugins");
  assert.equal(
    accepted.revision,
    project.defaultProfile.revision,
    "GUI accepted current deployed default",
  );
  assert.notEqual(accepted.revision, "resources-000-historical");
  profiles.push({ label, threadId, configuration: project.configurations?.[threadId] });
  await page.screenshot({ path: join(evidence, label + ".png"), animations: "disabled" });
  const slice = rounds.slice(before);
  assert(
    slice.some((r) => r.calls.some((c) => c.name.endsWith("__get_me"))),
    "real model did not call GitHub get_me",
  );
  assert(
    slice.some((r) => r.successfulIdentityResult),
    "new get_me call identity result did not reach model in this phase",
  );
  checks.push(
    label + ": GUI submitted, actual model called real GitHub get_me and received identity result",
  );
}
try {
  await cp(
    join(liveHome, "provider-credentials.json"),
    join(coreHome, "provider-credentials.json"),
  );
  await chmod(join(coreHome, "provider-credentials.json"), 0o600);
  await mkdir(join(dataDir, "private"), { recursive: true });
  await cp(
    join(liveHome, liveProject, "state/private/mcp-auth"),
    join(dataDir, "private/mcp-auth"),
    { recursive: true },
  );
  try {
    await mkdir(join(dataDir, "desktop"), { recursive: true });
    await cp(
      join(liveHome, liveProject, "state/desktop/plugin-auth-configurations.json"),
      join(dataDir, "desktop/plugin-auth-configurations.json"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await cp(inputs.plugin.source, join(workspace, "github"), { recursive: true });
  await writeFile(
    join(workspace, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: "openai-curated",
      plugins: [
        {
          name: "github",
          source: "./github",
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        },
      ],
    }),
  );
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const config = join(userHome, ".areal/config.toml"),
    p = inputs.provider,
    m = inputs.defaultModel,
    q = JSON.stringify;
  await writeFile(
    config,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider=${q(p.id)}\nname=${q(m.modelId)}\n[model.providers.${q(p.id)}]\nname=${q(p.name)}\nendpoint="http://127.0.0.1:${relay.address().port}/v1/chat/completions"\nprotocol="chat-completions"\napi_key_env=${q(p.apiKeyEnv)}\nmodels=[{id=${q(m.modelId)},enabled=true}]\n`,
  );
  const old = join(scratch, "old-desktop.json");
  await writeFile(
    old,
    JSON.stringify({
      profiles: [
        {
          id: "areal-standard",
          revision: "resources-000-historical",
          displayName: "Historical",
          instructions: "Historical profile fixture.",
          allowPluginSkills: false,
          allowThreadProcesses: true,
        },
      ],
    }),
  );
  await mkdir(join(scratch, "runtime"), { recursive: true });
  mark("historical deployment bootstrap");
  bootstrap = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--data-dir",
    dataDir,
    "--scratch",
    join(scratch, "runtime"),
    "--config",
    config,
    "--desktop-config",
    old,
    "--allow-write",
    "--allow-concurrent-writes",
    "--desktop-process-timeout-ms",
    "86400000",
  ]);
  const auth = JSON.parse(await readFile(bootstrap.authFile, "utf8"));
  client = new CoreClient({
    createSocket: () =>
      new WebSocket(bootstrap.endpoint, {
        headers: { Authorization: "Bearer " + auth.principals[0].token },
      }),
  });
  await client.connect();
  bootstrapThreadId = (
    await client.request("areal/thread/start", {
      cwd: workspace,
      agentProfile: { id: "areal-standard", revision: "resources-000-historical" },
      requestId: randomUUID(),
    })
  ).thread.id;
  await stopBootstrap();
  mark("real GUI launch");
  await launch();
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await createProjectConversation(page, "workspace");
  await poll(
    state,
    (s) => s.projects.find((p) => p.id === projectId)?.state?.connected,
    "project ready",
  );
  await cacheSnapshot("copied");
  mark("official package install");
  const preview = await manage("plugin", { id: inputs.plugin.id });
  assert.equal(
    preview.sourceDigest,
    inputs.plugin.installedDigest,
    "official copied package digest must remain identical",
  );
  await manage("pluginInstall", {
    id: preview.id,
    scope: "user",
    expectedRevision: preview.revision,
    source: preview.source,
    expectedDigest: preview.sourceDigest,
    requestId: randomUUID(),
  });
  try {
    await manage("pluginConnection", {
      id: preview.id,
      expectedDigest: preview.sourceDigest,
      connect: true,
      requestId: randomUUID(),
    });
    await cacheSnapshot("after-connect");
    const connected = await manage("pluginMcp");
    const row = connected.data.find((p) => p.pluginId === preview.id);
    assert(
      row?.servers.some((s) => s.state === "connected"),
      "cached OAuth did not connect; state=" + row?.state,
    );
    checks.push("exact cached OAuth grant connected without auth start");
  } catch (e) {
    errors.push({ phase: "initial cached OAuth connection", message: safeError(e) });
  }
  if (errors.length) throw Error(errors.at(-1).message);
  mark("new-chat real call");
  await send("before-restart");
  mark("safe restart");
  await stopGui();
  await launch();
  await poll(
    state,
    (s) => s.projects.find((p) => p.id === projectId)?.state?.connected,
    "restored project",
  );
  await selectConversation(page, threadId);
  mark("same-chat real call after restart");
  await send("after-restart");
  passed = true;
} catch (e) {
  failure = { phase, message: safeError(e) };
  process.exitCode = 1;
  if (page)
    try {
      await page.screenshot({ path: join(evidence, "failure.png"), animations: "disabled" });
      const s = await state();
      await writeFile(
        join(evidence, "failure-public-state.json"),
        JSON.stringify(
          {
            projects: s.projects.map((p) => ({
              id: p.id,
              profiles: p.profiles,
              defaultProfile: p.defaultProfile,
              configurations: p.configurations,
              connection: p.state?.connected,
            })),
            rounds,
          },
          null,
          2,
        ),
      );
    } catch {}
} finally {
  try {
    await stopBootstrap();
  } catch (e) {
    cleanup.push({ error: safeError(e) });
  }
  try {
    if (app) await stopGui();
  } catch (e) {
    cleanup.push({ error: safeError(e) });
  }
  relay.closeAllConnections();
  await new Promise((r) => relay.close(r));
  const cleanupFailed = cleanup.some((c) => c.error);
  if (!cleanupFailed) {
    await writableDirectories(scratch);
    await rm(scratch, { recursive: true, force: true });
  } else {
    passed = false;
    process.exitCode = 1;
  }
  const manifest = {
    passed,
    phase,
    failure,
    checks,
    errors,
    cleanup,
    profiles,
    cacheFiles,
    rounds,
    source,
    privateRuntimeRemoved: !cleanupFailed,
    ...(cleanupFailed ? { privateRuntime: scratch } : {}),
    scope:
      "real isolated source GUI + actual configured provider + exact official GitHub portable OAuth; no fresh consent",
  };
  await writeFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(
    JSON.stringify({ passed, evidence, phase, failure, checks, errors, cleanup }, null, 2),
  );
}
