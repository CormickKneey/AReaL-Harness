import { assertApplicationStopped } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure, resizeConversation, selectConversation } from "./smoke-navigation.mjs";
import assert from "node:assert/strict";

import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
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
const secondSkill = join(scratch, "skill-two");
await mkdir(secondSkill);
await writeFile(
  join(secondSkill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Second source\n---\nSECOND_SKILL_CONTENT\n",
);
const pagedContent = "分页正文".repeat(2400) + "\nPAGED_SKILL_END";
await writeFile(
  join(skill, "SKILL.md"),
  "---\nname: fixture-skill\ndescription: Deterministic test skill\n---\n" + pagedContent,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    skills: [
      { id: "fixture-skill", revision: "v1", root: skill },
      { id: "fixture-two", revision: "v2", root: secondSkill },
    ],
    profiles: [
      {
        id: "standard",
        revision: "v1",
        displayName: "标准",
        instructions: "Complete the task",
        allowThreadProcesses: true,
        approvalTools: ["fs_create"],
        skills: [
          { id: "fixture-skill", revision: "v1" },
          { id: "fixture-two", revision: "v2" },
        ],
      },
    ],
  }),
);
const received = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (respondToSessionName(body, res)) return;
  received.push(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "COMPOSER_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(endpoint)}\n`,
);
const env = {
  ...process.env,
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
  passed = false;
const errors = [],
  frames = [],
  checks = [];
const pasteEvidence = { uploadedFile: null, folded: [] };
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (snapshot) =>
  snapshot.projects.find((p) => p.root === workspace && !p.projectless);
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
    if (await predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timeout: " + label);
}
async function shot(name) {
  const clip = await page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll(
        '.composer-dock, [data-slot="popover-content"], [data-testid="composer-catalog"]',
      ),
    ]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return undefined;
    const x = Math.max(0, Math.min(...boxes.map((box) => box.left)) - 8);
    const y = Math.max(0, Math.min(...boxes.map((box) => box.top)) - 8);
    return {
      x,
      y,
      width: Math.min(innerWidth, Math.max(...boxes.map((box) => box.right)) + 8) - x,
      height: Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom)) + 8) - y,
    };
  });
  await page.screenshot({
    clip,
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
async function quit() {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await app.close();
  app = null;
}
console.log("GUI evidence:", scratch);
try {
  await launch();
  await page.evaluate(() => localStorage.setItem("areal-gui:theme", "data-dense"));
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      };
    }),
    { sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => project(s)?.state?.connected, "project ready");
  const pid = project(await state()).id;
  const selectFixtureProfile = async () => {
    await page.waitForFunction((id) => {
      const workbench = document.querySelector('[data-testid="areal-workbench"]');
      return workbench?.dataset.projectId === id && !workbench.dataset.threadId;
    }, pid);
    assert(project(await state()).profiles.some((p) => p.id === "standard" && p.revision === "v1"));
    await page.evaluate((id) => {
      const key = `areal-gui:draft:${id}:new`;
      localStorage.setItem(`${key}:profile`, JSON.stringify({ id: "standard", revision: "v1" }));
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
    }, pid);
  };
  await selectFixtureProfile();
  await call("manage", {
    projectId: pid,
    operation: "providerSave",
    expectedRevision: 0,
    provider: {
      id: "fixture-provider",
      revision: 0,
      protocol: "chatCompletions",
      endpoint,
      models: ["fixture", "fixture-alt"],
      parameters: {},
    },
  });
  await until(
    (s) => project(s).models.some((model) => model.modelId === "fixture-alt"),
    "provider catalog",
  );
  const input = () => page.locator("[data-testid=chat-input]");
  const tags = () => page.locator(".composer-skill-tag");
  const openCatalog = async () => {
    await button("添加功能与 Skills").click();
    await page.getByRole("option").filter({ hasText: "Deterministic test skill" }).waitFor();
  };
  const chooseFirst = async () => {
    await openCatalog();
    await page.getByRole("option", { name: /Deterministic test skill/ }).click();
  };
  const sendAndWait = async () => {
    const count = received.length;
    await button("发送").click();
    await until(
      (s) =>
        Object.values(project(s).state.threads).some(
          (t) => t.turns?.at(-1)?.status === "completed",
        ) && received.length > count,
      "send completed",
    );
  };
  // 由 Chromium 驱动真实组词事件；候选中间态不能保存到草稿或触发发送。
  const checkComposition = async (draftKey, label) => {
    await input().fill("");
    await input().focus();
    await page.evaluate((key) => {
      window.composerInputProbe = { writes: [], restore: Storage.prototype.setItem };
      Storage.prototype.setItem = function (name, value) {
        if (name === key) window.composerInputProbe.writes.push(value);
        return window.composerInputProbe.restore.call(this, name, value);
      };
    }, draftKey);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.debugger.attach("1.3"),
    );
    const command = (method, params) =>
      app.evaluate(
        async ({ BrowserWindow }, { method, params }) =>
          BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand(method, params),
        { method, params },
      );
    const compose = (text) =>
      command("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    const writes = () => page.evaluate(() => window.composerInputProbe.writes);
    const requestCount = received.length;
    try {
      for (const text of ["n", "ni", "nihao", "你好"]) {
        await compose(text);
        await page.waitForFunction(
          (text) =>
            document
              .querySelector('[data-testid="chat-input"]')
              .textContent.replaceAll("\u200b", "") === text,
          text,
        );
      }
      assert.deepEqual(await writes(), [], `${label}: unconfirmed candidates stay in editor`);
      await input().evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      assert.equal(received.length, requestCount, `${label}: candidate Enter does not send`);
      await command("Input.insertText", { text: "你好" });
      await page.waitForFunction((key) => localStorage.getItem(key) === "你好", draftKey);
      assert.deepEqual(
        await writes(),
        ["你好"],
        `${label}: commit publishes once even when candidate text is unchanged`,
      );
      assert.equal(await input().textContent(), "你好");
      assert.deepEqual(
        await input().evaluate((element) => {
          const selection = getSelection();
          return {
            inside: element.contains(selection.anchorNode),
            offset: selection.anchorOffset,
            collapsed: selection.isCollapsed,
          };
        }),
        { inside: true, offset: 2, collapsed: true },
      );
      assert.equal(
        await input().evaluate((element) => {
          const style = getComputedStyle(element);
          return style.caretColor === style.color;
        }),
        true,
        `${label}: caret follows foreground color`,
      );
      await shot(`${label}-ime-committed`);
      await compose("mei");
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="chat-input"]').textContent.includes("mei"),
      );
      assert.deepEqual(await writes(), ["你好"]);
      await compose("");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="chat-input"]').textContent === "你好",
      );
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), draftKey), "你好");
      assert.deepEqual(
        await writes(),
        ["你好"],
        `${label}: canceled composition preserves committed draft`,
      );
      await input().press("Shift+Enter");
      await page.keyboard.type("a");
      await page.waitForFunction((key) => localStorage.getItem(key)?.endsWith("a"), draftKey);
      assert.match(await page.evaluate((key) => localStorage.getItem(key), draftKey), /^你好\n+a$/);
      assert.equal(received.length, requestCount);
      assert.equal(await button("发送").isEnabled(), true);
      checks.push(
        `${label}: native Chromium composition stays local; one final draft write; cancel, caret, Enter guard and newline remain correct`,
      );
    } finally {
      await page.evaluate(() => {
        Storage.prototype.setItem = window.composerInputProbe.restore;
        delete window.composerInputProbe;
      });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.debugger.detach(),
      );
    }
    await input().fill("");
    await page.keyboard.type("a");
    await page.waitForFunction((key) => localStorage.getItem(key) === "a", draftKey);
    assert.equal(await button("发送").isEnabled(), true, `${label}: first character enables send`);
    await input().fill("");
  };
  await checkComposition(`areal-gui:draft:${pid}:new`, "draft");
  // 草稿目录不创建 Thread，+/slash 同视图并保留正文与同名来源。
  await input().fill("正文保留");
  await chooseFirst();
  await page.getByRole("button", { name: /查看技能/ }).click();
  await page
    .getByRole("dialog", { name: "技能 fixture-skill" })
    .getByText(/PAGED_SKILL_END/)
    .waitFor();
  await page.getByRole("dialog", { name: "技能 fixture-skill" }).press("Escape");
  assert.equal(await tags().count(), 1);
  await chooseFirst();
  assert.equal(await tags().count(), 1);
  await openCatalog();
  await page.getByRole("option", { name: /Second source/ }).click();
  assert.equal(await tags().count(), 2);
  await page
    .getByRole("button", { name: /移除技能/ })
    .first()
    .click();
  assert.equal(await tags().count(), 1);
  assert.equal(await input().textContent(), "正文保留");
  await chooseFirst();
  assert.equal(await tags().count(), 2);
  assert.equal(project(await state()).summaries?.length ?? 0, 0);
  await input().fill("正文保留 /fixture");
  await page.getByRole("listbox", { name: "功能与 Skills" }).waitFor();
  await input().press("ArrowDown");
  await input().press("Enter");
  assert.equal(await input().textContent(), "正文保留 ");
  assert.equal(await tags().count(), 2);
  await openCatalog();
  const draftMenuGap = await page.evaluate(() => {
    const menu = document.querySelector('[data-testid="composer-catalog"]').getBoundingClientRect();
    const surface = document.querySelector(".composer-surface").getBoundingClientRect();
    return surface.top - menu.bottom;
  });
  assert.ok(Math.abs(draftMenuGap - 8) < 1, `draft menu gap: ${draftMenuGap}`);
  await shot("01-draft-catalog");
  await page.getByLabel("搜索功能与 Skills").press("Escape");
  await shot("01-draft-skills");
  await input().fill("正文保留 /no-such-skill");
  await page.getByText("无匹配结果", { exact: true }).waitFor();
  await input().press("Enter");
  assert.equal(await input().textContent(), "正文保留 /no-such-skill");
  assert.equal(received.length, 0);
  await input().press("Escape");
  await input().fill("正文保留 /goal");
  await page.getByRole("option", { name: /设置目标/ }).waitFor();
  await input().evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  assert.equal(await button("退出目标模式").count(), 0);
  await input().press("Escape");
  await input().fill("正文保留");
  checks.push(
    "new draft catalog without hidden Thread; shared +/slash grouping; keyboard/no-result/IME guards; source identity dedup; body preservation",
  );
  // 卡片与长粘贴走真实浏览器文件/剪贴板边界。
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#75a9eb";
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("input[type=file]").setInputFiles([
    { name: "image.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
    { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("文本附件内容") },
  ]);
  await page.getByRole("button", { name: "在文本框中显示 ›" }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="chat-input"]')?.textContent.includes("文本附件内容"),
  );
  assert.match(await input().textContent(), /正文保留.*文本附件内容/s);
  assert.equal(await page.locator(".composer-image-card").count(), 1);
  await page.waitForFunction(
    () => document.querySelector(".composer-image-card img")?.naturalWidth === 64,
  );
  const pasted = "粘贴正文".repeat(60);
  await input().evaluate((el, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, pasted);
  await page.getByRole("button", { name: "在文本框中显示 ›" }).waitFor();
  await shot("02-attachments");
  await page.getByRole("button", { name: "在文本框中显示 ›" }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="chat-input"]')?.textContent.includes("粘贴正文"),
  );
  assert.match(await input().textContent(), /粘贴正文/);
  const beforeRemove = await input().textContent();
  await button("移除附件 image.png").click();
  assert.equal(await input().textContent(), beforeRemove);
  checks.push(
    "image thumbnail; UTF-8 file and long-paste cards expand without losing existing body or other attachments",
  );
  // 真实目录与配置：选择模型后回到强度面板，提交到本地供应商。
  await button("模型").click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture-alt", exact: true }).click();
  const slider = page.getByRole("slider", { name: "思考强度" });
  await slider.waitFor();
  await slider.fill("4");
  assert.equal(await page.getByRole("button", { name: /快速|重置强度/ }).count(), 0);
  await shot("03-effort");
  await slider.press("Escape");
  await sendAndWait();
  const tid = await page.locator("[data-testid=areal-workbench]").getAttribute("data-thread-id");
  assert.equal(project(await state()).configurations[tid].profile.id, "standard");
  assert.equal(project(await state()).configurations[tid].profile.revision, "v1");
  const current = (s) => project(s).state.threads[tid];
  const sentBody = received.at(-1);
  assert.equal(sentBody.model, "fixture-alt");
  assert.equal(sentBody.reasoning_effort, "high");
  const sentText = JSON.stringify(sentBody.messages);
  assert.ok(sentText.includes("PAGED_SKILL_END"));
  assert.ok(sentText.includes("SECOND_SKILL_CONTENT"));
  assert.ok(sentText.includes("正文保留"));
  await until((s) => !project(s).pending.length, "submission settled");
  assert.equal(await tags().count(), 0);
  checks.push(
    "real paged Core Skill read (multibyte >8192 bytes) reaches model request; two-tier real model/effort selection reaches provider",
  );
  const pasteUploads = (await call("media", {
    projectId: pid, threadId: tid, operation: "list",
  })).uploads;
  for (const [label, text, body = "", newDraft = false] of [
    ["over-200-characters", "折叠正文开始\n" + "粘贴正文".repeat(60) + "\n折叠正文结束", "保留已有正文"],
    ["five-lines", "第一行\n第二行\n第三行\n第四行\n第五行"],
    ["new-draft-five-lines", "新聊天第一行\n第二行\n第三行\n第四行\n第五行", "", true],
  ]) {
    if (newDraft) {
      await button("新聊天").click();
      await page.waitForFunction(() =>
        !document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId,
      );
      await input().waitFor();
      await selectFixtureProfile();
    }
    let pasteTid = newDraft ? null : tid;
    const pasteThread = (s) => project(s).state.threads[pasteTid];
    assert.equal(
      await page.getByText("model does not support File input", { exact: true }).count(),
      0,
      `${label}: no preceding File refusal can satisfy this attempt`,
    );
    const expectedText = body ? `${body}\n\n${text}` : text;
    await input().fill(body);
    await input().evaluate((element, value) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData, bubbles: true, cancelable: true,
      }));
    }, text);
    await page.getByRole("button", { name: "在文本框中显示 ›" }).waitFor();
    assert.equal(await input().textContent(), body, `${label}: pasted text stays folded`);
    await shot(`03b-folded-${label}`);
    const beforePaste = {
      requests: received.length,
      turns: pasteThread(await state())?.turns.length ?? 0,
      uploads: newDraft ? [] : pasteUploads,
    };
    const evidence = { label, expectedText, before: beforePaste };
    pasteEvidence.folded.push(evidence);
    await button("发送").click();
    const accepted = await until(
      async (s) => {
        if (newDraft) pasteTid = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
        const refusal = await page.getByText("model does not support File input", { exact: true }).count();
        if (refusal) {
          evidence.observed = {
            error: "model does not support File input",
            draft: await input().textContent(),
            turns: pasteThread(s)?.turns.length ?? 0,
            modelRequests: received.slice(beforePaste.requests),
            uploads: pasteTid ? (await call("media", {
              projectId: pid, threadId: pasteTid, operation: "list",
            })).uploads : [],
          };
          assert.fail(`${label}: folded clipboard text was sent as File; expected exact Text input`);
        }
        return received.length === beforePaste.requests + 1 &&
          pasteThread(s)?.turns.length === beforePaste.turns + 1 &&
          pasteThread(s)?.turns.at(-1)?.status === "completed" && !project(s).pending.length;
      },
      `${label}: folded paste direct Send completes as Text`,
    );
    const turn = pasteThread(accepted).turns.at(-1);
    const userMessages = turn.items.filter((item) => item.type === "userMessage");
    assert.equal(userMessages.length, 1);
    assert.deepEqual(
      userMessages[0].content.map((part) => ({ type: part.type, text: part.text })),
      [{ type: "text", text: expectedText }],
      `${label}: Core accepted text contains every pasted character and no File part`,
    );
    const modelMessage = received.at(-1).messages.filter((message) => message.role === "user"
      && !(typeof message.content === "string" && message.content.startsWith("AReaL runtime context (not a user request):"))).at(-1);
    assert.equal(modelMessage.content, expectedText, `${label}: actual model request preserves exact text`);
    assert.deepEqual(
      (await call("media", { projectId: pid, threadId: pasteTid, operation: "list" })).uploads,
      beforePaste.uploads,
      `${label}: folded text creates no Core upload`,
    );
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="chat-input"]')?.textContent === "" &&
      !document.querySelector('[data-testid="composer-attachment"]'),
    );
    evidence.observed = { threadId: pasteTid, turn, modelMessage };
    checks.push(`${label}: folded direct UI Send reaches completed Core history and model as exact Text without upload`);
    if (newDraft) await selectConversation(page, tid);
  }
  const uploadedText = "真正通过文件选择器上传的文本，不是剪贴板正文。";
  const fileDraft = "真实文件拒绝时保留正文";
  const beforeFile = {
    requests: received.length,
    turns: current(await state()).turns.length,
    uploads: (await call("media", { projectId: pid, threadId: tid, operation: "list" })).uploads,
  };
  await input().fill(fileDraft);
  await page.locator("input[type=file]").setInputFiles({
    name: "粘贴的文本.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(uploadedText),
  });
  await button("发送").click();
  await page.getByText("model does not support File input", { exact: true }).first().waitFor();
  assert.equal(received.length, beforeFile.requests, "a real text file remains File input");
  assert.equal(current(await state()).turns.length, beforeFile.turns);
  assert.equal(await input().textContent(), fileDraft);
  await button("移除附件 粘贴的文本.txt").waitFor();
  const uploadedFiles = (await call("media", {
    projectId: pid, threadId: tid, operation: "list",
  })).uploads;
  const uploadedFile = uploadedFiles.find((file) =>
    !beforeFile.uploads.some((previous) => previous.uri === file.uri),
  );
  assert.equal(uploadedFiles.length, beforeFile.uploads.length + 1);
  assert.equal(uploadedFile.mimeType, "text/plain");
  assert.equal(uploadedFile.sizeBytes, Buffer.byteLength(uploadedText));
  const uploadedContent = await page.evaluate(async (params) => {
    const result = await window.arealDesktop.command("media", params);
    if (!result.ok) throw Error(result.error.message);
    return new TextDecoder().decode(result.value.bytes);
  }, { projectId: pid, threadId: tid, operation: "read", uri: uploadedFile.uri });
  assert.equal(uploadedContent, uploadedText);
  pasteEvidence.uploadedFile = { ...uploadedFile, text: uploadedText, refusedAs: "File" };
  await shot("03a-uploaded-text-file-refused");
  await button("移除附件 粘贴的文本.txt").click();
  checks.push("real text/plain picker file keeps File modality, uploaded bytes and draft on Core refusal");
  await sendAndWait();
  await until((s) => current(s).turns.at(-1)?.status === "completed" && !project(s).pending.length,
    "explicit text retry after removing the real file");
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-input"]')?.textContent === "");
  assert.equal(current(await state()).turns.at(-1).items.find(item => item.type === "userMessage").content[0].text, fileDraft);
  checks.push("removing the genuine file permits an explicit Text retry and clears the accepted draft");
  await checkComposition(`areal-gui:draft:${pid}:${tid}`, "chat");
  // Use native typing: fill() uses the editor bridge and repairs the selection itself.
  for (const theme of ["dark", "light"]) {
    await button("设置").click();
    await button("外观").click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: theme === "dark" ? "深色" : "浅色", exact: true }).click();
    await page.waitForFunction(
      (theme) => document.documentElement.classList.contains(`theme-areal-${theme}`) &&
        document.documentElement.classList.contains("dark") === (theme === "dark"),
      theme,
    );
    await button("返回应用").click();
    const requestCount = received.length;
    await input().focus();
    await page.keyboard.type(`Enter caret ${theme}`);
    await input().press("Enter");
    await until(
      (s) => received.length > requestCount &&
        current(s).turns.at(-1)?.status === "completed" && !project(s).pending.length,
      `${theme}: Enter send completed`,
    );
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="chat-input"]');
      return element?.getAttribute("contenteditable") === "true" && element.textContent === "";
    });
    const caret = await input().evaluate((element) => {
      const selection = getSelection();
      const paragraph = element.firstElementChild;
      return {
        focused: document.activeElement === element,
        collapsed: selection?.isCollapsed,
        inParagraph: !!paragraph && paragraph.contains(selection?.anchorNode),
      };
    });
    const frame = `enter-caret-${theme}.png`;
    await page.screenshot({ path: join(scratch, frame), caret: "initial", scale: "css" });
    frames.push(frame);
    assert.deepEqual(
      caret,
      { focused: true, collapsed: true, inParagraph: true },
      `${theme}: cleared editor caret stays in its text line`,
    );
    await page.keyboard.type("next draft");
    assert.equal(await input().textContent(), "next draft", `${theme}: typing continues after Enter`);
    await input().press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await input().press("Backspace");
  }
  checks.push(
    "native Enter clears accepted messages and restores a line-sized caret in light/dark; subsequent typing remains usable",
  );
  // 已有聊天发送前读取失败不丢标签或正文，不发缺失技能请求。
  await chooseFirst();
  await input().fill("技能失败保留草稿");
  await rename(join(skill, "SKILL.md"), join(skill, "SKILL.unavailable"));
  const requestCount = received.length;
  await button("发送").click();
  await page.getByRole("alert").filter({ hasText: "无法读取技能" }).waitFor();
  assert.equal(received.length, requestCount);
  assert.equal(await tags().count(), 1);
  assert.equal(await page.locator(".error-banner").count(), 0);
  assert.equal(await input().textContent(), "技能失败保留草稿");
  await rename(join(skill, "SKILL.unavailable"), join(skill, "SKILL.md"));
  await sendAndWait();
  await until(
    (s) => current(s).turns.at(-1)?.status === "completed" && !project(s).pending.length,
    "second send",
  );
  checks.push(
    "existing Composer Skill failure blocks send and retains draft; retry reads real resource",
  );
  await input().fill("已有聊天 /goal");
  await page.getByRole("option", { name: /设置目标/ }).waitFor();
  await input().press("Enter");
  await button("退出目标模式").waitFor();
  assert.equal(await input().textContent(), "已有聊天 ");
  assert.equal(await page.getByRole("dialog", { name: /目标/ }).count(), 0);
  await button("退出目标模式").click();
  await button("模型").click();
  await slider.fill("2");
  await slider.press("Escape");
  await until(
    (s) => project(s).configurations[tid]?.parameters.reasoningEffort === "low",
    "existing effort configured",
  );
  await input().fill("已有模型设置");
  await sendAndWait();
  assert.equal(received.at(-1).reasoning_effort, "low");
  checks.push("existing Composer inline Goal toggle; model effort configuration and request");
  // 新目标只消费目标正文；技能和文件留在新聊天。
  await button("新聊天").click();
  await selectFixtureProfile();
  await chooseFirst();
  await page.locator("input[type=file]").setInputFiles({
    name: "goal-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("目标之外的附件"),
  });
  await input().fill("/goal");
  await page.getByRole("option", { name: /设置目标/ }).waitFor();
  await input().press("Enter");
  const foldedGoal = "完成\nComposer\n检查\n保持\n折叠";
  await input().fill("");
  await input().evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, foldedGoal);
  await button("移除附件 完成").waitFor();
  assert.equal(await input().textContent(), "");
  await button("开始目标").click();
  await until(
    (s) => Object.values(project(s).state.threads).some((t) => t.goals?.goal),
    "goal created",
  );
  await page.getByRole("button", { name: "移除附件 goal-note.txt" }).waitFor();
  assert.equal(await tags().count(), 1);
  const goalTid = await page
    .locator("[data-testid=areal-workbench]")
    .getAttribute("data-thread-id");
  assert.equal(project(await state()).state.threads[goalTid].goals.goal.objective, foldedGoal);
  assert.equal(await button("移除附件 完成").count(), 0);
  await until(
    (s) => project(s).state.threads[goalTid]?.goals?.goal?.status !== "active",
    "goal settles without progress",
  );
  await shot("04-inline-goal");
  checks.push(
    "new draft inline Goal consumes folded Text as the exact objective while skills and genuine file remain unsent",
  );
  await resizeConversation(app, page, 720, 760);
  await openCatalog();
  await shot("05-narrow-catalog");
  const catalogBox = await page.getByTestId("composer-catalog").boundingBox();
  const viewport =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  assert.ok(
    catalogBox.x >= 0 && catalogBox.y >= 0 && catalogBox.x + catalogBox.width <= viewport.width,
  );
  await page.getByLabel("搜索功能与 Skills").press("Escape");
  const sendBox = await button("发送").boundingBox();
  assert.ok(
    sendBox &&
      sendBox.x + sendBox.width <= viewport.width &&
      sendBox.y + sendBox.height <= viewport.height,
  );
  await openCatalog();
  await page.locator(".composer-editor").click();
  assert.equal(await page.getByTestId("composer-catalog").count(), 0);
  checks.push(
    "narrow window catalog within viewport; send control reachable; outside-click dismissal",
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({ passed, scratch, checks }));
} catch (error) {
  console.error("renderer errors", errors);
  frames.push(
    ...(await captureSmokeFailure(page, scratch, error)).filter((file) => file.endsWith(".png")),
  );
  throw error;
} finally {
  const stoppingAdapter = await readFile(join(scratch, "core/service.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  await quit();
  try {
    await assertApplicationStopped(binary, env, stoppingAdapter);
    checks.push("application quit stops the isolated adapter and all Core generations, including projectless");
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
  await writeFile(join(scratch, "paste-evidence.json"), JSON.stringify(pasteEvidence, null, 2));
  const sourceFiles = {};
  for (const path of execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean)) {
    try {
      sourceFiles[path] = createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex");
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
      sourceFiles[path] = null; // Tracked deletions remain part of the source evidence.
    }
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
      },
      null,
      2,
    ),
  );
}
