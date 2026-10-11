import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(gui, "app");
const require = createRequire(join(desktop, "package.json"));
const { _electron: electron } = require("playwright-core");
const root = resolve(gui, "../..");
const binary = process.env.AREAL_GUI_EXECUTABLE
  ? resolve(dirname(process.env.AREAL_GUI_EXECUTABLE), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.ok(binary, "AREAL_CORE_BIN must point to the actual built Core");
const binarySha256AtStart = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const scratch = await mkdtemp("/private/tmp/areal-gui-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user-home"));
execFileSync("git", ["init", "-b", "main"], {
  cwd: workspace,
  stdio: "ignore",
});
await writeFile(join(workspace, "hello.ts"), 'export const hello = "world";\n');
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync(
  "git",
  ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
  { cwd: workspace, stdio: "ignore" },
);
await writeFile(join(workspace, "hello.ts"), 'export const hello = "AReaL";\n');
const skill = join(scratch, "skill");
await mkdir(skill);
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\nExplain the fixture project.\n",
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    skills: [{ id: "fixture-skill", revision: "v1", root: skill }],
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the task",
        allowThreadProcesses: true,
        approvalTools: ["fs_create"],
        skills: [{ id: "fixture-skill", revision: "v1" }],
      },
    ],
  }),
);
const received = [];
let finishBackground;
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/preview")) {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<html><body style="font:20px system-ui;background:#edf5f1;padding:48px"><h1>Project preview</h1><p>AReaL local workspace</p><a href="/preview?next">Next page</a><button onclick="this.textContent=\'Preview clicked\'">Try preview</button></body></html>',
    );
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  received.push(body);
  if (body.stream === false) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    return;
  }
  const msgs = body.messages ?? [],
    last = msgs.findLastIndex((m) => m.role === "user"),
    content = msgs[last]?.content;
  const text =
    typeof content === "string" ? content : (content ?? []).map((x) => x.text ?? "").join("");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (text.includes("后台持续执行")) {
    send({ content: "后台开始。" });
    finishBackground = () => {
      send({ content: "后台完成。" });
      send({}, "stop");
      res.end("data: [DONE]\n\n");
    };
    return;
  }
  if (text.includes("等待停止")) {
    send({ content: "正在运行，等待下一步指令。" });
    return;
  }
  if (text.includes("审批写入") && !msgs.slice(last + 1).some((m) => m.role === "tool")) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "write",
          type: "function",
          function: {
            name: "fs_create",
            arguments: JSON.stringify({
              path: "approved.txt",
              text: "approved once",
            }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  } else if (text.includes("需要问答") && !msgs.slice(last + 1).some((m) => m.role === "tool")) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "question",
          type: "function",
          function: {
            name: "ask_user_question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "choice",
                  title: "选择实现方式",
                  options: ["最小修改", "重构"],
                  allowFreeText: false,
                },
              ],
            }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  } else if (text.includes("启动子任务") && !msgs.slice(last + 1).some((m) => m.role === "tool")) {
    send({
      tool_calls: [
        {
          index: 0,
          id: "child",
          type: "function",
          function: {
            name: "agent_spawn",
            arguments: JSON.stringify({
              prompt: "只读检查项目",
              intent: "inspect",
              delivery: "report",
            }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  } else {
    send({
      content:
        "已完成工作区检查。\n\n- 文件已读取\n- 下一步可以查看改动\n\n```ts\nconst ready = true;\n```",
    });
    send({}, "stop");
  }
  res.write(
    `data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  previewUrl = `http://127.0.0.1:${server.address().port}/preview`;
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\n`,
);
// 本地 SSE fixture 必须直连；保留宿主已有排除项并同步两种大小写。
const noProxy = [
  ...new Set(
    [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1,localhost,::1"]
      .filter(Boolean)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  ),
].join(",");
const env = {
  ...process.env,
  NO_PROXY: noProxy,
  no_proxy: noProxy,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user-home"),
  AREAL_HARNESS_HOME: join(scratch, "runtime"),
  AREAL_CORE_CONFIG: config,
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
};
delete env.AREAL_CORE_WORKSPACE;
if (process.env.AREAL_GUI_EXECUTABLE) delete env.AREAL_CORE_BIN;
let app,
  page,
  passed = false,
  failure = null;
const errors = [],
  frames = [],
  checks = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
async function call(name, params) {
  const result = await page.evaluate(
    async ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
async function until(predicate, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const s = await state();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
async function shot(name) {
  await page.screenshot({
    path: join(scratch, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
  frames.push(name + ".png");
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.AREAL_GUI_EXECUTABLE || require("electron"),
    args: process.env.AREAL_GUI_EXECUTABLE ? [] : [desktop],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (d) => {
    if (String(d).includes("Error")) process.stderr.write(d);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("[data-testid=areal-workbench]").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
}
async function openPanel(name) {
  if (await button("返回工作区").isVisible()) await button("返回工作区").click();
  if (name === "终端") {
    await button(name).click();
    return;
  }
  await button("任务操作").click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function quit() {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await app.close();
  app = null;
}
console.log("GUI evidence:", scratch);
console.log("Core binary SHA-256 at start:", binarySha256AtStart);
try {
  await launch();
  const sandbox = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  assert.deepEqual(sandbox, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await shot("01-empty");
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => s.projects[0]?.state?.connected, "project ready");
  const pid = (await state()).projects[0].id;
  const input = () => page.locator("[data-testid=chat-input]");
  const turnCountOf = (s) =>
    Object.values(s.projects[0].state.threads).reduce((n, t) => n + (t.turns?.length ?? 0), 0);
  const send = async (text) => {
    const count = turnCountOf(await state());
    await input().fill(text);
    await button("发送").click();
    await until((s) => turnCountOf(s) > count, "turn admission");
  };
  await send("检查当前项目");
  await until(
    (s) =>
      Object.values(s.projects[0].state.threads).some(
        (t) => t.turns?.at(-1)?.status === "completed",
      ),
    "first send",
  );
  const tid = await page.locator("[data-testid=areal-workbench]").getAttribute("data-thread-id");
  const current = (s) => s.projects[0].state.threads[tid];
  assert.ok(tid);
  await shot("02-conversation");
  checks.push("sandboxed Electron; project picker; first send; real Core/Runtime and local SSE");
  await send("启动子任务");
  await until((s) => current(s).turns.at(-1)?.status === "completed", "delegation settled");
  const executionList = await call("manage", {
    projectId: pid,
    parentThreadId: tid,
    operation: "executions",
    offset: 0,
    limit: 50,
  });
  const execution = executionList.data.find((item) => item.title === "只读检查项目");
  assert.ok(execution?.executionId);
  assert.equal(execution.settled, true);
  assert.equal(execution.verification.status, "notRun");
  assert.equal(execution.delivery.status, "notRequired");
  await openPanel("子任务");
  const executionCard = page.getByTestId(`execution-${execution.executionId}`);
  await executionCard.waitFor();
  assert.match(await executionCard.innerText(), /未运行检查/);
  assert.match(await executionCard.innerText(), /报告交付/);
  assert.equal(await button("创建子任务").isVisible(), false);
  await shot("02-subtask-delivery");
  await button("关闭面板").click();
  checks.push(
    "unified agent delegation; one subtask panel; verification and delivery stay distinct",
  );
  await send("审批写入");
  await button("允许一次").click();
  await until((s) => current(s).turns.at(-1)?.status === "completed", "approved write");
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "approved once");
  await send("需要问答");
  await page.getByRole("radio", { name: /最小修改/ }).click();
  await until((s) => current(s).turns.at(-1)?.status === "completed", "question resumed");
  checks.push("tool approval executes filesystem write; question reply resumes same turn");
  await send("等待停止");
  await until((s) => current(s).turns.at(-1)?.status === "inProgress", "running");
  await call("stop", { projectId: pid, threadId: tid });
  await until((s) => current(s).turns.at(-1)?.status !== "inProgress", "stopped");
  checks.push("explicit turn cancellation");
  await openPanel("文件");
  await page.getByRole("treeitem", { name: "hello.ts", exact: true }).click();
  await button("文件更多").click();
  await page.getByRole("menuitem", { name: "编辑代码", exact: true }).click();
  await page.getByLabel("编辑 hello.ts", { exact: true }).fill('export const hello = "edited";\n');
  await button("保存").click();
  await page.getByText("文件已保存", { exact: true }).waitFor();
  assert.match(await readFile(join(workspace, "hello.ts"), "utf8"), /edited/);
  await shot("03-files");
  await openPanel("改动");
  await shot("04-diff");
  await button("关闭面板").click();
  checks.push("native file edit and Git diff panel");
  await button("终端").click();
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.waitFor();
  await terminal.pressSequentially("printf 'AREAL_TERMINAL_OK\\n'");
  await terminal.press("Enter");
  let output = "";
  for (let i = 0; i < 100; i++) {
    const processes = await call("manage", {
      projectId: pid,
      threadId: tid,
      operation: "processes",
    });
    if (processes.data?.length) {
      const result = await call("manage", {
        projectId: pid,
        threadId: tid,
        operation: "processOutput",
        id: processes.data.at(-1).id,
        maxBytes: 4096,
      });
      output = (result.chunks ?? [])
        .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString())
        .join("");
      if (output.includes("AREAL_TERMINAL_OK")) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /AREAL_TERMINAL_OK/);
  await shot("05-terminal");
  await page
    .locator(".bottom-terminal")
    .getByRole("button", { name: "关闭面板", exact: true })
    .click();
  checks.push("real Runtime PTY with input/output");
  await openPanel("预览");
  await page.getByLabel("预览地址").fill(previewUrl);
  await page.getByLabel("预览地址").press("Enter");
  let previewEvidence;
  for (let i = 0; i < 100; i++) {
    previewEvidence = await app.evaluate(async ({ webContents }, url) => {
      const content = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url));
      if (!content || content.isLoading()) return null;
      return {
        text: await content.executeJavaScript("document.body.innerText"),
        bridge: await content.executeJavaScript("typeof window.arealDesktop"),
        image: (await content.capturePage()).toPNG().toString("base64"),
      };
    }, previewUrl);
    if (previewEvidence?.text.includes("Project preview")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(previewEvidence?.text ?? "", /Project preview/);
  assert.equal(previewEvidence.bridge, "undefined");
  await writeFile(
    join(scratch, "06-native-preview.png"),
    Buffer.from(previewEvidence.image, "base64"),
  );
  frames.push("06-native-preview.png");
  await shot("06-preview");
  await button("关闭面板").click();
  checks.push("native embedded preview opens local workspace page");
  await button("设置").click();
  await button("手机连接").click();
  await shot("06-mobile-settings");
  await button("外观").click();
  await shot("06-settings");
  await button("返回应用").click();
  checks.push("settings navigation and appearance");
  await input().fill("保留未发送草稿");
  await call("send", { projectId: pid, threadId: tid, text: "后台持续执行" });
  await until(
    (s) => current(s).turns.at(-1)?.status === "inProgress" && finishBackground,
    "background started",
  );
  const turnCount = current(await state()).turns.length;
  const requestCount = received.length;
  const adapter = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
  await quit();
  process.kill(adapter.pid, 0);
  finishBackground();
  await launch();
  await until(
    (s) => s.projects[0]?.state?.connected && current(s)?.turns.at(-1)?.status === "completed",
    "recover after GUI exit",
  );
  assert.equal(current(await state()).turns.length, turnCount);
  assert.equal(received.length, requestCount);
  assert.equal(await input().textContent(), "保留未发送草稿");
  await shot("07-background-recovered");
  checks.push(
    "running Core turn completes after GUI quit; reopen restores history/draft without replay",
  );
  await quit();
  process.kill(adapter.pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(adapter.pid, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const transport = JSON.parse(
    await readFile(join(scratch, "core/subscription-transport.json"), "utf8"),
  );
  await launch();
  await until((s) => s.projects[0]?.state?.connected, "recover after adapter exit");
  const restored = JSON.parse(
    await readFile(join(scratch, "core/subscription-transport.json"), "utf8"),
  );
  assert.deepEqual(restored, transport);
  await send("适配器重连后继续");
  await until(
    (s) =>
      current(s).turns.length === turnCount + 1 && current(s).turns.at(-1)?.status === "completed",
    "continued after adapter exit",
  );
  const publicState = JSON.stringify(await state());
  assert.ok(!publicState.includes(transport.token));
  assert.ok(!publicState.includes(adapter.token));
  checks.push(
    "adapter restart reuses Core history and local capability; no tokens exposed in renderer snapshot",
  );
  const scheduled = await call("manage", {
    projectId: pid,
    operation: "taskCreate",
    mode: "scheduled",
    objective: "检查当前项目",
    interactionMode: "headless",
    schedule: { at: Math.floor(Date.now() / 1000) + 3 },
    maxTurns: 1,
    maxActiveSeconds: 60,
  });
  assert.ok(scheduled.id);
  await quit();
  await new Promise((r) => setTimeout(r, 4500));
  await launch();
  await until((s) => s.projects[0]?.state?.connected, "scheduled task reconnect");
  let task;
  for (let i = 0; i < 100; i++) {
    task = await call("manage", { projectId: pid, operation: "task", taskId: scheduled.id });
    if (task.runs?.length && !["running", "queued"].includes(task.runs.at(-1).status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(task.runs.length, 1);
  assert.ok(!["running", "queued"].includes(task.runs[0].status));
  await call("manage", {
    projectId: pid,
    operation: "taskCancel",
    taskId: task.id,
    expectedRevision: task.revision,
  });
  await button("执行任务").click();
  await shot("08-tasks");
  checks.push(
    "Core scheduled task triggers once while GUI is closed and run history survives reopening",
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, scratch, checks }));
} catch (error) {
  failure = error.stack || error.message;
  console.error("renderer errors", errors);
  console.error(await page?.locator("body").innerText());
  await shot("failure").catch(() => {});
  throw error;
} finally {
  await quit();
  try {
    const { ServiceConnection } = require(join(desktop, "src/core/service-client.cjs"));
    const connection = new ServiceConnection();
    try {
      await connection.connect(
        JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8")),
      );
      await connection.request("stopService", { protocol: "areal.desktop-service.v1" }, true);
      checks.push("explicit safe service stop completes");
    } finally {
      connection.close();
    }
  } catch (error) {
    console.error("Adapter fixture cleanup:", error.message);
    if (passed) {
      passed = false;
      process.exitCode = 1;
      errors.push(`Explicit safe stop failed: ${error.message}`);
    }
    // 仅清理本次隔离 home 中的服务；失败不遗留模型任务或后台进程。
    try {
      const instances = JSON.parse(
        execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8" }),
      );
      for (const instance of instances)
        if (instance.workspace === workspace && instance.state !== "stopped") {
          execFileSync(
            binary,
            ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
            { env, timeout: 120000, stdio: "pipe" },
          );
        }
    } catch (failure) {
      console.error("Core fixture cleanup:", failure.message);
    }
    try {
      const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
      process.kill(metadata.pid, "SIGTERM");
    } catch {}
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const sourceFiles = {};
  for (const path of execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean)) {
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
        sourceFiles,
        binarySha256AtStart,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        diffSha256: createHash("sha256").update(diff).digest("hex"),
        binary,
        platform: process.platform,
        arch: process.arch,
        runtime: "real Electron + real Rust Core/Runtime + deterministic local HTTP/SSE model",
        nativeDialogs: "project picker and archive/quit confirmations injected",
        scratch,
        frames,
        checks,
        errors,
        failure,
      },
      null,
      2,
    ),
  );
}
