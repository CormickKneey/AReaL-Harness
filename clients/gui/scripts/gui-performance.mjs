import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir, cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadavg, cpus } from "node:os";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import { selectConversation } from "./smoke-navigation.mjs";
import { CoreClient } from "../packages/runtime-client/core.js";
import { startupEnvironment, startupResources } from "./startup-resources.mjs";
import { makeTempDir } from "./support/temp.mjs";
import {
  artifactHashes,
  buildProfile,
  snapshotApplication,
  moduleLoadEvidence,
  mainPerformanceBootstrap,
  profilerMarker,
} from "./support/performance-profile.mjs";
import {
  performanceServers,
  deltaCount,
  deltaIntervalMs,
  domRows,
  frameCount,
  fixtureSentinel,
  streamText,
  installRendererInputProbe,
  installFirstUseProbe,
  distribution,
} from "./support/performance-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const WebSocket = require("ws");
const binary = resolve(process.env.AREAL_CORE_BIN ?? join(gui, "../../.local/dev-bin/areal"));
const rounds = Number(process.env.AREAL_PERFORMANCE_ROUNDS ?? 5);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const evidence = resolve(
  process.env.AREAL_PERFORMANCE_EVIDENCE ??
    join(gui, "../../.scratch/gui-performance", new Date().toISOString().replaceAll(":", "-")),
);
const variants = [
  ...(process.env.AREAL_PERFORMANCE_BASELINE_GUI
    ? [{ label: "baseline", gui: resolve(process.env.AREAL_PERFORMANCE_BASELINE_GUI) }]
    : []),
  { label: "current", gui },
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const binarySha256 = sha(await readFile(binary));
const coreRuntimeHashes = Object.fromEntries(
  await Promise.all(
    ["areal", "areal-runtime", "areal-runtime-fs"].map(async (name) => [
      name,
      sha(await readFile(join(dirname(binary), name))),
    ]),
  ),
);
const samples = [];
const failures = [];
await mkdir(evidence, { recursive: true });
const provenance = await Promise.all(
  variants.map(async (variant) => ({
    ...variant,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: variant.gui, encoding: "utf8" }).trim(),
    diffSha256: sha(
      execFileSync("git", ["diff", "--binary", "HEAD"], {
        cwd: variant.gui,
        maxBuffer: 64 * 1024 * 1024,
      }),
    ),
    normalArtifactHashes: await artifactHashes(join(variant.gui, "renderer/dist")),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        execFileSync(
          "git",
          [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "app/src",
            "renderer/src",
            "packages",
          ],
          { cwd: variant.gui, encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter((file) => /\.(cjs|mjs|js|ts|tsx|json|css)$/.test(file))
          .map(async (file) => [file, sha(await readFile(join(variant.gui, file)))]),
      ),
    ),
    packageHashes: Object.fromEntries(
      await Promise.all(
        ["package.json", "pnpm-lock.yaml", "app/package.json", "renderer/package.json"].map(
          async (file) => [file, sha(await readFile(join(variant.gui, file)))],
        ),
      ),
    ),
  })),
);
const scriptHashes = Object.fromEntries(
  await Promise.all(
    [
      "gui-performance.mjs",
      "startup-resources.mjs",
      "support/performance-profile.mjs",
      "support/performance-fixture.mjs",
    ].map(async (file) => [file, sha(await readFile(join(gui, "scripts", file)))]),
  ),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timeout waiting for ${label}`);
}
async function mainEvent(application, name, start = false) {
  return application.evaluate(
    ({ app }, { name, start }) =>
      new Promise((resolve) => {
        const handled = start ? app.emit(name, {}, resolve) : app.emit(name, resolve);
        if (!handled) throw new Error(`Missing fixture event ${name}`);
      }),
    { name, start },
  );
}

async function run(variant, mode, round) {
  const diagnostic = ["diagnostic", "react-diagnostic"].includes(mode);
  const profiling = mode.startsWith("react");
  const directory = join(evidence, `${variant.label}-${mode}-${round}`);
  await mkdir(directory);
  const scratch = await makeTempDir("apf-");
  const servers = await performanceServers();
  const workspace = join(scratch, "workspace");
  const userHome = join(scratch, "user");
  await mkdir(workspace);
  await mkdir(userHome);
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  const fixtureFile = 'export const PERFORMANCE_FILE_READY = "before";\n';
  await writeFile(join(workspace, "performance.ts"), fixtureFile);
  execFileSync("git", ["add", "performance.ts"], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Performance Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-m",
      "Fixture",
    ],
    { cwd: workspace, stdio: "ignore" },
  );
  await writeFile(join(workspace, "performance.ts"), fixtureFile.replace("before", "after"));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  Object.assign(env, {
    HOME: userHome,
    AREAL_CORE_BIN: binary,
    AREAL_GUI_USER_DATA: join(scratch, "profile"),
    AREAL_CORE_HOME: join(scratch, "core"),
    AREAL_CORE_USER_HOME: userHome,
    AREAL_HARNESS_HOME: join(scratch, "config-home"),
    AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
    AREAL_CORE_CONFIG: join(scratch, "config.toml"),
    AREAL_CORE_DESKTOP_CONFIG: join(scratch, "desktop.json"),
    AREAL_BROWSER_READ_TEST_TRACE: join(directory, "browser-trace.jsonl"),
  });
  env.NO_PROXY = env.no_proxy = [env.NO_PROXY, env.no_proxy, "127.0.0.1,localhost,::1"]
    .filter(Boolean)
    .join(",");
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(servers.modelUrl)}\n`,
  );
  await writeFile(
    env.AREAL_CORE_DESKTOP_CONFIG,
    JSON.stringify({
      profiles: [
        {
          id: "fixture",
          revision: "v1",
          displayName: "Fixture",
          instructions: "Use the fixture content and requested read tools.",
        },
      ],
    }),
  );
  await writeFile(env.AREAL_BROWSER_READ_TEST_TRACE, "");
  const snapshot = await snapshotApplication(
    variant.gui,
    join(scratch, "source"),
    profiling ? variant.react : variant.normal,
  );
  const fixture = await applicationFixture(
    snapshot.path,
    join(scratch, "app"),
    mainPerformanceBootstrap,
  );
  const result = {
    label: variant.label,
    mode,
    round,
    scratch,
    directory,
    passed: false,
    cleanup: false,
    applicationSourceHashes: snapshot.hashes,
    environment: { ...startupEnvironment(), loadAverage: loadavg() },
    input: [],
    firstUse: [],
    profiler: [],
    errors: [],
    coreDeltas: [],
    coreEvents: [],
    versions: null,
  };
  let application, page, observer, rendererProfile, metadata;
  const consoleEvents = [];
  const mainLog = [];
  async function command(name, request) {
    const response = await page.evaluate(
      ({ name, request }) => window.arealDesktop.command(name, request),
      { name, request },
    );
    assert.equal(response.ok, true, `${name}: ${JSON.stringify(response.error)}`);
    return response.value;
  }
  async function firstUse(id, selector, action, ready) {
    await page.screenshot({ path: join(directory, `${id}-before.png`) });
    await page.evaluate(installFirstUseProbe, { id, selector });
    await action();
    await page.screenshot({ path: join(directory, `${id}-loading.png`) });
    await ready();
    await page.evaluate(
      (id) => document.dispatchEvent(new Event(`areal-performance-first-use-stop-${id}`)),
      id,
    );
    const observation = await until(
      () => result.firstUse.find((item) => item.id === id),
      `${id} observation`,
    );
    assert.equal(
      Object.keys(observation.milestones).length,
      id === "message" ? 2 : 1,
      `${id} must record visible DOM readiness independently of screenshot overhead`,
    );
    await page.screenshot({ path: join(directory, `${id}-ready.png`) });
  }
  try {
    const launchAt = Date.now();
    application = await electron.launch({
      executablePath: require("electron"),
      args: [fixture.path],
      env,
      timeout: 120000,
    });
    result.mainPid = application.process().pid;
    application.process().stderr?.on("data", (bytes) => mainLog.push(String(bytes)));
    page = await application.firstWindow();
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => result.errors.push(error.message));
    page.on("console", (message) => {
      const text = message.text();
      const markers = [
        [profilerMarker, result.profiler],
        ["AREAL_PERFORMANCE_INPUT ", result.input],
        ["AREAL_PERFORMANCE_FIRST_USE ", result.firstUse],
      ];
      const entry = markers.find(([prefix]) => text.startsWith(prefix));
      if (entry) entry[1].push(JSON.parse(text.slice(entry[0].length)));
      else if (message.type() === "error") consoleEvents.push(text);
    });
    await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
    await until(
      async () =>
        (await page.evaluate(() => window.arealDesktop.snapshot())).connection?.state === "ready",
      "Desktop ready",
    );
    await application.evaluate(
      ({ app, BrowserWindow, dialog }, { workspace, origin }) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
        const showMessageBox = dialog.showMessageBox;
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1);
          if (
            options.title === "允许本地开发站点" &&
            options.message === `允许此浏览工作区访问 ${origin}？`
          )
            return { response: 1, checkboxChecked: false };
          return showMessageBox(...args);
        };
        BrowserWindow.getAllWindows()[0].setSize(1440, 960);
        app.focus({ steal: true });
        BrowserWindow.getAllWindows()[0].focus();
      },
      { workspace, origin: new URL(servers.siteUrl).origin },
    );
    await page.evaluate(() => window.arealDesktop.chooseProject());
    const project = await until(
      async () =>
        (await page.evaluate(() => window.arealDesktop.snapshot())).projects.find(
          (project) => project.root === workspace && project.state?.connected,
        ),
      "Project connected",
    );
    const projectId = project.id;
    result.resources = await startupResources(application, page);
    result.versions = result.resources.main.versions;
    result.initialResources = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
      })),
    );
    const create = () =>
      command("create", {
        projectId,
        browserEnabled: !profiling,
        profile: { id: "fixture", revision: "v1" },
        options: { preapprovedTools: ["browser_v1"] },
      });
    if (!profiling) {
      const heavy = await create();
      await selectConversation(page, heavy.threadId);
      await firstUse(
        "message",
        '[data-testid="chat-view"]',
        () => command("send", { projectId, threadId: heavy.threadId, text: "PERFORMANCE_HEAVY" }),
        async () => {
          await page
            .getByTestId("chat-view")
            .getByText("PERFORMANCE_CODE_READY", { exact: false })
            .first()
            .waitFor();
          await page
            .getByTestId("chat-view")
            .locator("svg")
            .filter({ hasText: "PERFORMANCE_DIAGRAM_READY" })
            .waitFor();
        },
      );
      await firstUse(
        "file",
        '[data-testid="workspace-file-preview"]',
        async () => {
          await page.getByRole("button", { name: "任务操作", exact: true }).click();
          await page.getByRole("menuitem", { name: "文件", exact: true }).click();
          await page.getByRole("treeitem", { name: "performance.ts", exact: true }).click();
        },
        () =>
          page
            .getByTestId("workspace-file-preview")
            .locator("diffs-container")
            .getByText("PERFORMANCE_FILE_READY", { exact: false })
            .waitFor(),
      );
      await firstUse(
        "diff",
        '[data-testid="workspace-review"]',
        async () => {
          await page.getByRole("button", { name: "任务操作", exact: true }).click();
          await page.getByRole("menuitem", { name: "改动", exact: true }).click();
          const file = page
            .getByTestId("workspace-review")
            .getByRole("button", { name: "performance.ts", exact: true });
          await file.waitFor();
          if ((await file.getAttribute("aria-expanded")) === "false") await file.click();
        },
        () =>
          page
            .getByTestId("workspace-review")
            .getByText("PERFORMANCE_FILE_READY", { exact: false })
            .first()
            .waitFor(),
      );
      await page.getByRole("button", { name: "关闭面板", exact: true }).click();
      await firstUse(
        "terminal",
        ".terminal-pane",
        () => page.keyboard.press("Control+Backquote"),
        async () => {
          await page.locator(".terminal-pane .xterm-screen").waitFor();
          const terminal = page.locator(".terminal-pane .xterm-helper-textarea");
          await terminal.pressSequentially("printf 'PERFORMANCE_TERMINAL_READY\\n'");
          await terminal.press("Enter");
          await until(
            async () =>
              /(?:^|\n)PERFORMANCE_TERMINAL_READY(?:\n|$)/.test(
                await page.locator(".terminal-pane .xterm-rows").innerText(),
              ),
            "terminal output",
          );
          await terminal.pressSequentially("exit");
          await terminal.press("Enter");
          await until(
            async () =>
              (
                await command("manage", {
                  projectId,
                  threadId: heavy.threadId,
                  operation: "processes",
                })
              ).data.every((item) =>
                ["completed", "failed", "exited", "killed"].includes(item.state),
              ),
            "terminal Runtime process stopped",
          );
        },
      );
    }
    const streamThread = await create();
    const browserThread = profiling ? null : await create();
    if (browserThread) {
      await selectConversation(page, browserThread.threadId);
      await page.keyboard.press("Meta+t");
      await page.locator(".preview-panel").waitFor();
      await page.evaluate((request) => window.arealDesktop.preview(request), {
        operation: "navigate",
        projectId,
        threadId: browserThread.threadId,
        url: servers.siteUrl,
      });
      result.nativePage = await until(
        () =>
          application.evaluate(async ({ webContents }, url) => {
            const contents = webContents
              .getAllWebContents()
              .find((item) => item.getURL() === url && !item.isLoadingMainFrame());
            if (!contents) return null;
            return {
              id: contents.id,
              osPid: contents.getOSProcessId(),
              facts: await contents.executeJavaScript(
                `({ nodes: document.querySelectorAll('*').length, frames: Array.from(document.querySelectorAll('iframe')).map(frame => ({ ready: frame.contentDocument?.readyState, nodes: frame.contentDocument?.querySelectorAll('*').length })), title: document.title })`,
              ),
            };
          }, servers.siteUrl),
        "large native document loaded",
      );
      assert.equal(result.nativePage.facts.frames.length, frameCount);
      assert.ok(result.nativePage.facts.nodes >= domRows * 4);
      assert.ok(
        result.nativePage.facts.frames.every(
          (frame) => frame.ready === "complete" && frame.nodes >= 1200,
        ),
      );
      const claim = await page.evaluate((request) => window.arealDesktop.preview(request), {
        operation: "claim",
        projectId,
        threadId: browserThread.threadId,
      });
      servers.state.pageId = claim.browser.pageId;
      assert.ok(servers.state.pageId);
    } else await selectConversation(page, streamThread.threadId);
    const descriptor = JSON.parse(
      await readFile(
        join(env.AREAL_HARNESS_SERVICE_HOME, "services", project.core.instanceId, "service.json"),
        "utf8",
      ),
    );
    const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
    const principal = auth.principals.find((item) => item.permissions?.includes("observe"));
    assert.ok(principal?.token);
    observer = new CoreClient({
      createSocket: () =>
        new WebSocket(descriptor.endpoint, {
          headers: { Authorization: `Bearer ${principal.token}` },
          followRedirects: false,
        }),
    });
    observer.onNotification((method, params) => {
      if (params.threadId !== streamThread.threadId && params.threadId !== browserThread?.threadId)
        return;
      if (method === "item/agentMessage/delta" && params.threadId === streamThread.threadId)
        result.coreDeltas.push({ ...params, receivedAt: Date.now() });
      if (["turn/started", "turn/completed"].includes(method))
        result.coreEvents.push({ method, params, receivedAt: Date.now() });
    });
    await observer.connect();
    await observer.request("areal/thread/observe", { threadId: streamThread.threadId });
    if (browserThread)
      await observer.request("areal/thread/observe", { threadId: browserThread.threadId });
    await sleep(1000);
    result.warmupMs = 1000;
    if (diagnostic) {
      const response = await mainEvent(application, "areal-performance-profile-start");
      assert.ok(!response.error, response.error);
      rendererProfile = await page.context().newCDPSession(page);
      await rendererProfile.send("Profiler.enable");
      await rendererProfile.send("Profiler.start");
    }
    if (!profiling) await page.evaluate(installRendererInputProbe);
    result.rendererStart = await page.evaluate(() => performance.now());
    result.windowStart = await mainEvent(application, "areal-performance-start", true);
    const generatorCpu = process.cpuUsage();
    await command("send", {
      projectId,
      threadId: streamThread.threadId,
      text: "PERFORMANCE_STREAM",
    });
    await until(() => result.coreDeltas.length > 0, "first actual Core delta");
    if (browserThread)
      await command("send", {
        projectId,
        threadId: browserThread.threadId,
        text: "PERFORMANCE_BROWSER",
      });
    if (!profiling) {
      const input = page.getByTestId("chat-input");
      await input.fill("");
      await input.focus();
      await page.keyboard.type("performance input probe", { delay: 80 });
      assert.equal(await input.innerText(), "performance input probe");
    }
    await until(
      () =>
        result.coreEvents.some(
          (event) =>
            event.method === "turn/completed" && event.params.threadId === streamThread.threadId,
        ),
      "stream completed",
    );
    if (browserThread)
      await until(
        () =>
          result.coreEvents.some(
            (event) =>
              event.method === "turn/completed" && event.params.threadId === browserThread.threadId,
          ),
        "browser reads completed",
      );
    else
      await page
        .getByTestId("chat-view")
        .getByText(/delta_199/)
        .waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    result.rendererEnd = await page.evaluate(() => performance.now());
    result.mainWindow = await mainEvent(application, "areal-performance-stop");
    result.loadGenerator = {
      pid: process.pid,
      cpuMicroseconds: process.cpuUsage(generatorCpu),
      role: "Node fixture server and Playwright driver, never the Electron latency source",
    };
    assert.equal(result.mainWindow.pid, result.mainPid);
    assert.ok(result.mainWindow.samples > 0);
    if (!profiling)
      await page.evaluate(() => document.dispatchEvent(new Event("areal-performance-input-stop")));
    if (diagnostic) {
      const mainProfile = await mainEvent(application, "areal-performance-profile-stop");
      assert.ok(!mainProfile.error, mainProfile.error);
      await writeFile(join(directory, "main.cpuprofile"), JSON.stringify(mainProfile.profile));
      const renderer = await rendererProfile.send("Profiler.stop");
      await writeFile(join(directory, "renderer.cpuprofile"), JSON.stringify(renderer.profile));
      await rendererProfile.detach();
      rendererProfile = null;
    }
    const thread = (
      await observer.request("thread/read", { threadId: streamThread.threadId, includeTurns: true })
    ).thread;
    assert.equal(thread.turns.at(-1).status, "completed");
    const text = thread.turns
      .at(-1)
      .items.filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("");
    assert.equal(
      text,
      streamText,
      "Authoritative Core history contains the exact generated stream",
    );
    assert.equal(
      result.coreDeltas.length,
      deltaCount,
      "Core emits exactly 200 deltas for the measured Thread",
    );
    assert.equal(result.coreDeltas.map((event) => event.delta).join(""), streamText);
    const streamed = servers.state.requests.filter((request) => request.kind === "stream");
    assert.equal(streamed.length, 1, "No stream replay or duplicate provider call");
    assert.equal(streamed[0].deltas, deltaCount);
    result.stream = {
      threadId: streamThread.threadId,
      turnId: thread.turns.at(-1).id,
      expectedDeltas: deltaCount,
      observedDeltas: result.coreDeltas.length,
      actualTextSha256: sha(text),
      provider: streamed[0],
    };
    if (!profiling) {
      result.inputSummary = distribution(result.input.map((sample) => sample.nextFrameMs));
      assert.equal(result.input.length, "performance input probe".length);
      assert.ok(
        result.input.every((sample) => sample.trusted && sample.focused),
        "Keyboard events reach the focused Composer",
      );
    }
    result.profiler = result.profiler.filter(
      (commit) =>
        commit.commitTime >= result.rendererStart && commit.commitTime <= result.rendererEnd,
    );
    if (profiling)
      result.profilerSummary = distribution(result.profiler.map((commit) => commit.actualDuration));
    if (browserThread) {
      const browser = (
        await observer.request("thread/read", {
          threadId: browserThread.threadId,
          includeTurns: true,
        })
      ).thread;
      const tools = browser.turns.at(-1).items.filter((item) => item.type === "dynamicToolCall");
      assert.equal(tools.length, 3);
      assert.ok(
        tools.every((item) => item.success === true),
        "All actual Core browser tools succeed",
      );
      assert.ok(
        JSON.stringify(tools[0]).includes(fixtureSentinel),
        "AX observation contains the fixture text",
      );
      assert.ok(
        JSON.stringify(tools[1]).includes("Fixed document text 3999"),
        "Text read reaches the final DOM row",
      );
      assert.ok(JSON.stringify(tools[2]).includes("image"), "Core capture returns image evidence");
      assert.equal(servers.state.toolReceipts.length, 3);
      assert.ok(
        servers.state.toolReceipts.every(
          (receipt) => receipt.at >= streamed[0].startedAt && receipt.at <= streamed[0].finishedAt,
        ),
        "Browser reads all complete while the stream is active",
      );
      result.browser = {
        threadId: browserThread.threadId,
        turn: browser.turns.at(-1),
        receipts: servers.state.toolReceipts,
      };
      await page.screenshot({ path: join(directory, "workload.png") });
      const png = await application.evaluate(
        async ({ webContents }, id) =>
          (await webContents.fromId(id).capturePage()).toPNG().toString("base64"),
        result.nativePage.id,
      );
      await writeFile(join(directory, "native-document.png"), Buffer.from(png, "base64"));
    }
    if (mode === "normal" && round === 0) {
      await until(
        async () => {
          const roots = join(env.AREAL_GUI_USER_DATA, "diagnostics/main");
          const runs = await readdir(roots);
          const events = (
            await Promise.all(
              runs.map(async (name) => {
                const files = (await readdir(join(roots, name))).filter((file) =>
                  /^events-.*\.ndjson$/.test(file),
                );
                return (
                  await Promise.all(files.map((file) => readFile(join(roots, name, file), "utf8")))
                ).join("\n");
              }),
            )
          )
            .join("\n")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          const stats = events.filter(
            (event) => event.type === "resource-sample" && event.eventLoopSamples > 0,
          );
          if (stats.length) return { status: "measured", events: stats };
          if (variant.label === "baseline" && Date.now() - launchAt >= 65000)
            return {
              status: "baseline-has-no-histogram",
              events: events.filter((event) => event.type === "resource-sample"),
            };
          return null;
        },
        "production 60-second diagnostics histogram",
        90000,
      ).then((value) => {
        result.productionDiagnostics = value;
      });
    }
    assert.deepEqual(servers.state.failures, []);
    assert.deepEqual(result.errors, []);
    result.moduleLoads = await moduleLoadEvidence(
      profiling ? variant.react : variant.normal,
      result.initialResources,
      result.firstUse,
    );
    result.passed = true;
  } catch (error) {
    result.failure = error.stack ?? String(error);
    if (page) await page.screenshot({ path: join(directory, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    observer?.close();
    if (rendererProfile) await rendererProfile.detach().catch(() => {});
    metadata = await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    try {
      if (application) await closeSmokeApplication(application);
      await fixture.close();
      await assertApplicationStopped(binary, env, metadata);
      result.cleanup = true;
    } catch (error) {
      result.cleanupFailure = error.stack ?? String(error);
      process.exitCode = 1;
    }
    await servers.close();
    result.fixture = servers.state;
    result.consoleErrors = consoleEvents;
    await writeFile(join(directory, "main.log"), mainLog.join(""));
    await cp(join(env.AREAL_GUI_USER_DATA, "diagnostics"), join(directory, "diagnostics"), {
      recursive: true,
    }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
    samples.push(result);
    if (result.passed && result.cleanup) await rm(scratch, { recursive: true });
    console.log(
      JSON.stringify({
        label: variant.label,
        mode,
        round,
        passed: result.passed,
        cleanup: result.cleanup,
        directory,
      }),
    );
  }
  assert.ok(result.cleanup, result.cleanupFailure);
}

try {
  for (const variant of variants) {
    variant.normal = await buildProfile(
      variant.gui,
      join(evidence, "builds", variant.label, "normal"),
      false,
    );
    variant.react = await buildProfile(
      variant.gui,
      join(evidence, "builds", variant.label, "react"),
      true,
    );
  }
  for (const mode of ["normal", "react"])
    for (let round = 0; round < rounds; round++)
      for (const variant of variants) await run(variant, mode, round);
  for (const mode of ["diagnostic", "react-diagnostic"])
    for (const variant of variants) await run(variant, mode, 0);
} catch (error) {
  failures.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  for (const source of provenance)
    assert.deepEqual(
      await artifactHashes(join(source.gui, "renderer/dist")),
      source.normalArtifactHashes,
      "Original artifacts restored",
    );
  assert.equal(sha(await readFile(binary)), binarySha256, "Fixed Core binary did not change");
  await writeFile(
    join(evidence, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        passed: failures.length === 0 && samples.every((sample) => sample.passed && sample.cleanup),
        evidence,
        binary,
        binarySha256,
        coreRuntimeHashes,
        provenance,
        scriptHashes,
        rounds,
        samples: samples.map((sample) => ({
          label: sample.label,
          mode: sample.mode,
          round: sample.round,
          directory: sample.directory,
          passed: sample.passed,
          cleanup: sample.cleanup,
          mainWindow: sample.mainWindow,
          profilerSummary: sample.profilerSummary,
          inputSummary: sample.inputSummary,
        })),
        summary: variants.flatMap((variant) =>
          ["normal", "react"].flatMap((mode) => {
            const group = samples.filter(
              (sample) =>
                sample.label === variant.label &&
                sample.mode === mode &&
                sample.passed &&
                sample.cleanup,
            );
            if (!group.length) return [];
            return [
              {
                label: variant.label,
                mode,
                completedRounds: group.length,
                metrics: {
                  mainP99Ms: distribution(group.map((sample) => sample.mainWindow.p99Ms)),
                  mainMaxMs: distribution(group.map((sample) => sample.mainWindow.maxMs)),
                  ...(mode === "normal"
                    ? {
                        rendererInputP99Ms: distribution(
                          group.map((sample) => sample.inputSummary.p99),
                        ),
                      }
                    : {}),
                  ...(mode === "react"
                    ? {
                        reactCommitCount: distribution(
                          group.map((sample) => sample.profilerSummary.count),
                        ),
                        reactActualDurationTotalMs: distribution(
                          group.map((sample) => sample.profilerSummary.total),
                        ),
                      }
                    : {}),
                },
              },
            ];
          }),
        ),
        fixture: { deltaCount, deltaIntervalMs, domRows, frameCount },
        failures,
        environment: {
          ...startupEnvironment(),
          loadAverage: loadavg(),
          logicalCores: cpus().length,
        },
        scope:
          "Real source Electron Main/Renderer, real Core Turns and browser_v1, deterministic local model and site. Normal production and React profiling builds are separate. Keyboard keydown-to-next-animation-frame excludes OS input transit. CPU profiles are separate diagnostic runs and excluded from reported timing. Fresh process/cache profile each round; OS cache retained. No packaged app or real provider claim.",
        verdict:
          "Observations only. Compare medians/ranges across at least five alternating runs and identify the limiting code from diagnostic CPU profiles before claiming a speedup.",
      },
      null,
      2,
    ),
  );
  console.log(`Performance evidence: ${evidence}`);
}
