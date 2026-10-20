import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  cp,
  rm,
  chmod,
} from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";

const exec = promisify(execFile),
  require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url)),
  WebSocket = require("ws");
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const evidence = process.env.AREAL_GITHUB_EVIDENCE_DIR
  ? resolve(process.env.AREAL_GITHUB_EVIDENCE_DIR)
  : await mkdtemp("/private/tmp/areal-plugin-github-evidence-");
await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp("/private/tmp/areal-plugin-github-"),
  workspace = join(scratch, "workspace"),
  checks = [];
const officialPackage = {
  root: resolve(
    process.env.AREAL_GITHUB_PLUGIN_ROOT ??
      join(homedir(), ".codex/plugins/cache/openai-curated-remote/github/0.1.12-5f7cd798dc99"),
  ),
  expectedVersion: process.env.AREAL_GITHUB_PLUGIN_VERSION ?? "0.1.12-5f7cd798dc99",
  repository: "https://github.com/openai/plugins",
  connectorId: "connector_76869538009648d5b282a4bb21c3d157",
};
const githubRead = {
  endpoint: "https://api.githubcopilot.com/mcp/",
  originalTool: "get_file_contents",
  arguments: { owner: "openai", repo: "plugins", path: ".agents/plugins/marketplace.json" },
};
const cleanup = { services: [], runtimeRemoved: false, errors: [] },
  scans = { modelInput: false, runtime: false, evidence: false };
let service,
  client,
  env,
  secret,
  coreSha256,
  sourceHead,
  sourceFiles = {},
  passed = false,
  phase = "credentials",
  failure,
  modelFailure,
  modelRounds = 0;

function secretForms() {
  return secret
    ? [...new Set([secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)])]
    : [];
}
function sanitized(value) {
  let text = String(value);
  for (const form of secretForms()) text = text.split(form).join("[redacted]");
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .slice(0, 2048);
}
function assertNoSecret(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  assert(
    !secretForms().some((form) => bytes.includes(Buffer.from(form))),
    `credential leaked into ${label}`,
  );
}
async function save(name, value) {
  const serialized = JSON.stringify(value, null, 2);
  assertNoSecret(serialized, name);
  await writeFile(join(evidence, name), serialized);
}
async function inventory(root, prefix = "") {
  const files = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
      path = join(root, relative),
      stat = await lstat(path);
    if (stat.isDirectory()) Object.assign(files, await inventory(root, relative));
    else {
      assert(stat.isFile(), `official package has a non-regular entry at ${relative}`);
      const bytes = await readFile(path);
      files[relative] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        executable: Boolean(stat.mode & 0o111),
      };
    }
  }
  return files;
}
function marketplaceResult(result) {
  assert.equal(result.isError ?? false, false, "real GitHub tool returned an error");
  const candidates = [];
  for (const block of result.content ?? []) {
    if (block.type === "resource" && typeof block.resource?.text === "string")
      candidates.push(block.resource.text);
    if (block.type === "resource" && typeof block.resource?.blob === "string")
      candidates.push(Buffer.from(block.resource.blob, "base64").toString("utf8"));
    if (block.type === "text") {
      try {
        const value = JSON.parse(block.text);
        if (value.name === "openai-curated") candidates.push(block.text);
        if (typeof value.content === "string")
          candidates.push(
            value.encoding === "base64"
              ? Buffer.from(value.content, "base64").toString("utf8")
              : value.content,
          );
      } catch {}
    }
  }
  for (const text of candidates) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (value.name !== "openai-curated") continue;
    assert(Array.isArray(value.plugins), "real marketplace plugins must be an array");
    const github = value.plugins.find((plugin) => plugin.name === "github");
    assert(github, "real openai-curated marketplace must contain github");
    return { text, value, github };
  }
  throw Error("real GitHub response did not contain the openai-curated marketplace file");
}
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    assertNoSecret(body, "model input");
    scans.modelInput = true;
    const request = JSON.parse(body),
      toolResults = request.messages.filter((message) => message.role === "tool");
    modelRounds++;
    assert(modelRounds <= 2, "deterministic model must make exactly one read call");
    assert(githubRead.tool, "tool must be discovered from GitHub before the turn");
    const offered = request.tools.find((tool) => tool.function?.name === githubRead.tool.toolName);
    assert(offered, "Core model projection must advertise the discovered GitHub tool");
    assert.deepEqual(offered.function.parameters, githubRead.tool.inputSchema);
    if (toolResults.length) {
      assert.equal(toolResults.length, 1, "Core must project one real read result");
      const projected = JSON.stringify(toolResults[0]);
      assert(
        projected.includes("openai-curated") && projected.includes("github"),
        "Core model input must contain the real marketplace content",
      );
      await save("model-tool-result.json", toolResults[0]);
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = toolResults.length
      ? { content: "GITHUB_MARKETPLACE_READ_OK" }
      : {
          tool_calls: [
            {
              index: 0,
              id: "github-readonly-1",
              type: "function",
              function: {
                name: githubRead.tool.toolName,
                arguments: JSON.stringify(githubRead.arguments),
              },
            },
          ],
        };
    res.write(
      "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n",
    );
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            { index: 0, delta: {}, finish_reason: toolResults.length ? "stop" : "tool_calls" },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    modelFailure = { message: sanitized(error.message) };
    if (!res.headersSent) res.writeHead(500);
    res.end("Deterministic model assertion failed");
  }
});
async function cli(args) {
  return JSON.parse(
    (await exec(bin, args, { env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout,
  );
}
async function rpc(method, params) {
  return client.request(method, params, { timeoutMs: 120000 });
}
async function connect() {
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--config",
    join(scratch, "config.toml"),
  ]);
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  client = new CoreClient({
    createSocket: () =>
      new WebSocket(service.endpoint, {
        headers: { Authorization: "Bearer " + auth.principals[0].token },
      }),
  });
  await client.connect();
}
async function stop() {
  client?.close();
  const stopped = await cli([
    "service",
    "stop",
    "--json",
    "--workspace",
    workspace,
    "--expected-generation",
    service.generation,
    "--cancel",
  ]);
  assert.equal(stopped.state, "stopped");
  const pids = [service.corePid, service.hostPid];
  for (const pid of pids) {
    assert(Number.isInteger(pid) && pid > 0, "service must identify its processes");
    let live = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          live = false;
          break;
        }
        throw error;
      }
      await delay(100);
    }
    assert.equal(live, false, `isolated service process ${pid} remains live`);
  }
  cleanup.services.push({
    generation: service.generation,
    pids,
    state: stopped.state,
    processesExited: true,
  });
  service = null;
}
async function writableDirectories(path) {
  if (!(await lstat(path)).isDirectory()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await writableDirectories(join(path, entry.name));
}
async function noSecret(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await noSecret(file);
    else if (entry.isFile()) assertNoSecret(await readFile(file), "acceptance storage");
  }
}
try {
  secret = process.env.AREAL_GITHUB_MCP_TOKEN?.trim();
  if (!secret) {
    try {
      secret = (await exec("gh", ["auth", "token"], { timeout: 15000 })).stdout.trim();
    } catch {
      throw Error("GitHub credential unavailable; configure gh or AREAL_GITHUB_MCP_TOKEN");
    }
  }
  assert(secret, "GitHub credential is empty");
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(AREAL_|OPENAI_|ANTHROPIC_|GITHUB_|GH_TOKEN$|OTEL_)/.test(key),
      ),
    ),
    AREAL_HARNESS_HOME: join(scratch, "home"),
    AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
    AREAL_CREDENTIAL_GITHUB_MCP: secret,
    OTEL_SDK_DISABLED: "true",
  };
  coreSha256 = createHash("sha256")
    .update(await readFile(bin))
    .digest("hex");
  sourceHead = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  for (const file of new Set(
    (await exec("git", ["ls-files", "-m", "-o", "--exclude-standard"])).stdout
      .trim()
      .split("\n")
      .filter(Boolean),
  )) {
    try {
      sourceFiles[file] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      sourceFiles[file] = null;
    }
  }
  phase = "official package";
  const manifest = JSON.parse(
    await readFile(join(officialPackage.root, ".codex-plugin/plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "github");
  assert.equal(manifest.author?.name, "OpenAI");
  assert.equal(manifest.repository, officialPackage.repository);
  assert.equal(
    manifest.version,
    officialPackage.expectedVersion,
    "configure AREAL_GITHUB_PLUGIN_VERSION to match the pinned official root",
  );
  const apps = JSON.parse(await readFile(join(officialPackage.root, ".app.json"), "utf8"));
  assert.equal(apps.apps?.github?.id, officialPackage.connectorId);
  officialPackage.version = manifest.version;
  officialPackage.files = await inventory(officialPackage.root);
  await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
  await cp(officialPackage.root, join(workspace, "github"), { recursive: true });
  assert.deepEqual(
    await inventory(join(workspace, "github")),
    officialPackage.files,
    "copied official package must preserve original contents and executable modes",
  );
  await writeFile(
    join(workspace, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: "github-acceptance",
      plugins: [{ name: "github", source: "./github", policy: { authentication: "ON_USE" } }],
    }),
  );
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(scratch, "config.toml"),
    'schema_version=1\n[model]\nname="github-deterministic-acceptance"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:' +
      model.address().port +
      '"\n',
  );
  phase = "Core launch";
  await connect();
  const preview = await rpc("areal/plugin/read", { id: "github@github-acceptance" });
  assert.equal(preview.version, officialPackage.version);
  const installed = await rpc("areal/plugin/install", {
    id: preview.id,
    scope: "user",
    expectedRevision: preview.revision,
    source: preview.source,
    expectedDigest: preview.sourceDigest,
    requestId: randomUUID(),
  });
  assert.equal(installed.installedVersion, officialPackage.version);
  assert.match(installed.installedDigest, /^[a-f0-9]{64}$/);
  assert.equal(installed.installedDigest, preview.sourceDigest);
  officialPackage.sourceDigest = preview.sourceDigest;
  officialPackage.installedDigest = installed.installedDigest;
  assert.equal(modelRounds, 0);
  checks.push(
    "official version installs with the previewed package digest without executing model or MCP",
  );
  const state = await rpc("areal/plugin/mcp/list", {}),
    packageState = state.data.find((plugin) => plugin.pluginId === preview.id);
  assert.equal(
    packageState.connectors.find((connector) => connector.id === officialPackage.connectorId)
      ?.state,
    "missingMapping",
  );
  assert.equal((await rpc("areal/mcp/apps/list", {})).data.length, 0);
  checks.push(
    "official original GitHub App ID remains unmapped and undiscoverable until explicit configuration",
  );
  phase = "explicit GitHub mapping";
  await rpc("areal/plugin/connector/configure", {
    id: preview.id,
    connectorId: officialPackage.connectorId,
    provider: "github",
    credentialRef: "GITHUB_MCP",
    expectedDigest: installed.installedDigest,
    requestId: randomUUID(),
  });
  phase = "real GitHub MCP connection";
  await rpc("areal/plugin/connection", {
    id: preview.id,
    expectedDigest: installed.installedDigest,
    connect: true,
    requestId: randomUUID(),
  });
  const connected = (await rpc("areal/plugin/mcp/list", {})).data.find(
    (plugin) => plugin.pluginId === preview.id,
  );
  assert(
    connected.servers.some(
      (server) => server.state === "connected" && server.config.transport === "streamable-http",
    ),
    "GitHub must connect through actual HTTP",
  );
  const directory = await rpc("areal/mcp/apps/list", {}),
    server = directory.data.find(
      (server) =>
        server.pluginId === preview.id &&
        server.tools.some((tool) => tool.name === githubRead.originalTool),
    );
  assert(server, "real GitHub must advertise get_file_contents");
  githubRead.tool = server.tools.find((tool) => tool.name === githubRead.originalTool);
  assert.equal(githubRead.tool.inputSchema.type, "object");
  for (const key of Object.keys(githubRead.arguments))
    assert.equal(
      githubRead.tool.inputSchema.properties?.[key]?.type,
      "string",
      `real GitHub schema must support ${key}`,
    );
  if (githubRead.tool.inputSchema.properties.ref) githubRead.arguments.ref = "refs/heads/main";
  for (const key of githubRead.tool.inputSchema.required ?? [])
    assert(Object.hasOwn(githubRead.arguments, key), `unsupported required GitHub argument ${key}`);
  await save("github-discovery.json", {
    package: officialPackage,
    connection: connected,
    server,
    request: githubRead.arguments,
  });
  checks.push("actual GitHub MCP HTTP discovery supplies the repository read schema");
  phase = "read-only ordinary Core turn";
  const { thread } = await rpc("thread/start", { cwd: workspace }),
    threadId = thread.id;
  const turn = await rpc("areal/turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Read only openai/plugins .agents/plugins/marketplace.json with get_file_contents once, then report whether the marketplace is openai-curated and contains github.",
      },
    ],
    requestId: randomUUID(),
  });
  let result;
  for (let attempt = 0; attempt < 240; attempt++) {
    result = await rpc("thread/read", { threadId, includeTurns: true });
    if (result.thread.turns.find((item) => item.id === turn.turn.id)?.status !== "inProgress")
      break;
    await delay(250);
  }
  await save("core-thread.json", result);
  assert.equal(
    result.thread.turns.find((item) => item.id === turn.turn.id)?.status,
    "completed",
    modelFailure?.message,
  );
  const raw = await rpc("areal/mcp/tool/result", { threadId, callId: "github-readonly-1" }),
    marketplace = marketplaceResult(raw.mcpResult);
  assert.equal(modelRounds, 2);
  assert.equal(modelFailure, undefined);
  await save("github-tool-result.json", raw);
  await save("core-thread.json", result);
  assertNoSecret(marketplace.text, "public marketplace");
  await writeFile(join(evidence, "marketplace.json"), marketplace.text);
  githubRead.result = {
    marketplace: marketplace.value.name,
    github: marketplace.github,
    contentSha256: createHash("sha256").update(marketplace.text).digest("hex"),
    threadId,
    turnId: turn.turn.id,
    callId: "github-readonly-1",
  };
  checks.push(
    "one ordinary Core turn reads actual openai/plugins marketplace content and projects openai-curated with github to the model",
  );
  phase = "disconnect";
  await rpc("areal/plugin/connection", {
    id: preview.id,
    expectedDigest: installed.installedDigest,
    connect: false,
    requestId: randomUUID(),
  });
  assert.equal((await rpc("areal/mcp/apps/list", {})).data.length, 0);
  checks.push("explicit disconnect removes the GitHub generation");
  phase = "explicit reconnect";
  await rpc("areal/plugin/connection", {
    id: preview.id,
    expectedDigest: installed.installedDigest,
    connect: true,
    requestId: randomUUID(),
  });
  const reconnected = (await rpc("areal/mcp/apps/list", {})).data.find(
    (item) => item.pluginId === preview.id,
  );
  assert(reconnected.tools.some((tool) => tool.name === githubRead.originalTool));
  assert.notEqual(reconnected.generation, server.generation);
  checks.push("explicit reconnect publishes a new real GitHub generation");
  phase = "package disable";
  let catalog = await rpc("areal/plugin/list", {});
  await rpc("areal/plugin/configure", {
    id: preview.id,
    scope: "user",
    enabled: false,
    expectedRevision: catalog.revision,
    requestId: randomUUID(),
  });
  assert.equal((await rpc("areal/mcp/apps/list", {})).data.length, 0);
  await assert.rejects(
    rpc("areal/plugin/connection", {
      id: preview.id,
      expectedDigest: installed.installedDigest,
      connect: true,
      requestId: randomUUID(),
    }),
  );
  checks.push("package disable removes discovery and rejects reconnect");
  catalog = await rpc("areal/plugin/list", {});
  await rpc("areal/plugin/configure", {
    id: preview.id,
    scope: "user",
    enabled: true,
    expectedRevision: catalog.revision,
    requestId: randomUUID(),
  });
  phase = "confirmed restart";
  await stop();
  await connect();
  const restored = (await rpc("areal/plugin/mcp/list", {})).data.find(
    (plugin) => plugin.pluginId === preview.id,
  );
  assert(
    restored.connectors.some(
      (connector) =>
        connector.id === officialPackage.connectorId && connector.state !== "missingMapping",
    ),
  );
  await rpc("areal/plugin/connection", {
    id: preview.id,
    expectedDigest: installed.installedDigest,
    connect: true,
    requestId: randomUUID(),
  });
  assert(
    (await rpc("areal/mcp/apps/list", {})).data.some(
      (item) =>
        item.pluginId === preview.id &&
        item.tools.some((tool) => tool.name === githubRead.originalTool),
    ),
  );
  assert.equal(modelRounds, 2);
  checks.push(
    "confirmed Core restart retains the original App mapping and reconnects with the credential reference without another read",
  );
  phase = "final disconnect";
  await rpc("areal/plugin/connection", {
    id: preview.id,
    expectedDigest: installed.installedDigest,
    connect: false,
    requestId: randomUUID(),
  });
  await stop();
  passed = true;
} catch (error) {
  failure = { phase, code: error.code ?? null, message: sanitized(error.message) };
} finally {
  client?.close();
  if (service)
    try {
      await stop();
    } catch (error) {
      passed = false;
      cleanup.errors.push(sanitized(error.message));
      failure ??= { phase: "cleanup", message: sanitized(error.message) };
    }
  model.closeAllConnections();
  if (model.listening) await new Promise((resolve) => model.close(resolve));
  try {
    await noSecret(scratch);
    scans.runtime = true;
    await noSecret(evidence);
    scans.evidence = true;
  } catch (error) {
    passed = false;
    failure ??= { phase: "secret scan", message: sanitized(error.message) };
  }
  if (!service)
    try {
      await writableDirectories(scratch);
      await rm(scratch, { recursive: true, force: true });
      cleanup.runtimeRemoved = true;
    } catch (error) {
      passed = false;
      failure ??= { phase: "runtime cleanup", message: sanitized(error.message) };
    }
  const coreUnchanged = coreSha256
    ? createHash("sha256")
        .update(await readFile(bin))
        .digest("hex") === coreSha256
    : false;
  if (coreSha256 && !coreUnchanged) {
    passed = false;
    failure ??= { phase: "binary identity", message: "Core binary changed during acceptance" };
  }
  if (passed)
    checks.push(
      "isolated services exited, runtime home/workspace were removed, and model/storage/evidence scans found no GitHub credential",
    );
  const manifest = {
    passed,
    phase,
    failure,
    modelFailure,
    checks,
    officialPackage,
    githubRead,
    model: { source: "deterministic local model", rounds: modelRounds },
    service: "actual GitHub MCP HTTP",
    scope:
      "public repository read through ordinary Core turn; real provider, GUI and signed package acceptance remain separate",
    core: bin,
    binarySha256: coreSha256,
    coreUnchanged,
    sourceHead,
    sourceFiles,
    scans,
    cleanup,
    runtimeRoot: cleanup.runtimeRemoved ? null : scratch,
  };
  await save("manifest.json", manifest);
  const output = JSON.stringify(manifest, null, 2);
  assertNoSecret(output, "console output");
  console.log(output);
  console.log("Evidence: " + evidence);
  if (!passed) process.exitCode = 1;
}
