import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const { DesktopLifecycle } = require("../app/src/core/lifecycle.cjs");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const sourceCss = join(gui, "renderer/src/workbench.css");
const sourceCssSha256 = createHash("sha256")
  .update(await readFile(sourceCss))
  .digest("hex");
const scratch = await makeTempDir("areal-composer-focus-");
const home = join(scratch, "core"),
  workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user/.areal"), { recursive: true });
const requests = [],
  observations = [],
  errors = [],
  checks = [];
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push(JSON.parse(raw));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "FOCUS_OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const testApp = join(scratch, "app");
await mkdir(testApp);
await writeFile(
  join(testApp, "package.json"),
  JSON.stringify({ name: "composer-focus-fixture", main: "main.cjs" }),
);
await writeFile(
  join(testApp, "main.cjs"),
  `
const {ipcMain} = require('electron');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
  if (channel === 'areal-core:command' && globalThis.holdComposerSubmission && ['create', 'send'].includes(args[0])) {
    await new Promise(resolve => { globalThis.releaseComposerSubmission = resolve; });
    globalThis.holdComposerSubmission = false;
  }
  return listener(event, ...args);
});
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
);
const env = {
  ...process.env,
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: home,
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
};
for (const name of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_DESKTOP_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
])
  delete env[name];
let app,
  page,
  stylesheetSha256,
  passed = false;
async function waitState(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (predicate(await page.evaluate(() => window.arealDesktop.snapshot()))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Core snapshot did not reach the expected state");
}
console.log("GUI evidence: " + scratch);
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [testApp],
    env,
    timeout: 120000,
  });
  await writeFile(
    join(scratch, "run.json"),
    JSON.stringify({ guiPid: app.process().pid, home, testApp }),
  );
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  stylesheetSha256 = createHash("sha256")
    .update(
      await page.evaluate(() =>
        [...document.styleSheets]
          .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
          .join("\n"),
      ),
    )
    .digest("hex");
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await waitState((snapshot) => snapshot.projects.some((p) => p.state?.connected));
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page
      .getByRole("button", { name: theme === "light" ? "浅色" : "深色", exact: true })
      .click();
    await page.getByRole("button", { name: "返回应用", exact: true }).click();
    const input = page.getByTestId("chat-input");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="chat-input"]')?.contentEditable === "true",
    );
    await input.focus();
    await page.keyboard.type("222222222");
    await input.press("Shift+Enter");
    await page.keyboard.type("33333");
    await input.press("Shift+Enter");
    assert.equal(await input.textContent(), "22222222233333");
    await page.screenshot({
      path: join(scratch, `${theme}-newline.png`),
      caret: "initial",
      scale: "css",
    });
    const before = requests.length;
    await app.evaluate(() => {
      globalThis.holdComposerSubmission = true;
    });
    await input.press("Enter");
    try {
      await app.evaluate(async () => {
        const deadline = Date.now() + 30000;
        while (typeof globalThis.releaseComposerSubmission !== "function" && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        if (typeof globalThis.releaseComposerSubmission !== "function")
          throw new Error("Submission did not reach the IPC gate");
      });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="chat-input"]')?.contentEditable === "false",
      );
      const observed = await input.evaluate((element) => {
        const css = getComputedStyle(element),
          shell = element.closest(".composer-surface");
        return {
          text: element.textContent,
          focused: document.activeElement === element,
          outlineStyle: css.outlineStyle,
          outlineWidth: css.outlineWidth,
          outlineColor: css.outlineColor,
          shellFocused: shell.matches(":focus-within"),
          shellShadow: getComputedStyle(shell).boxShadow,
        };
      });
      observations.push({ theme, ...observed });
      await page.screenshot({
        path: join(scratch, `${theme}-submitting.png`),
        caret: "initial",
        scale: "css",
      });
      assert.equal(observed.focused, true);
      assert.equal(observed.text, "22222222233333");
      assert.equal(observed.shellFocused, true);
      assert.notEqual(observed.shellShadow, "none");
      if (observed.outlineStyle !== "none" && observed.outlineWidth !== "0px")
        errors.push(
          `${theme}: focused read-only editor draws ${observed.outlineWidth} ${observed.outlineColor} outline`,
        );
    } finally {
      await app.evaluate(() => {
        globalThis.releaseComposerSubmission?.();
        globalThis.releaseComposerSubmission = null;
      });
    }
    await waitState(
      (snapshot) =>
        requests.length === before + 1 &&
        snapshot.projects.some(
          (p) =>
            Object.values(p.state?.threads ?? {}).some(
              (t) => t.turns.at(-1)?.status === "completed",
            ) && !p.pending.length,
        ),
    );
    await page.waitForFunction(
      () => document.querySelector('[data-testid="chat-input"]')?.contentEditable === "true",
    );
    assert.equal(requests.length, before + 1);
    const submitted = requests
      .at(-1)
      .messages.find(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("222222222"),
      );
    assert.equal(submitted?.content, "222222222\n33333\n");
    assert.equal(await input.textContent(), "");
    await input.focus();
    await page.keyboard.type("next draft");
    assert.equal(await input.textContent(), "next draft");
    const caret = await input.evaluate((element) => ({
      color: getComputedStyle(element).caretColor,
      foreground: getComputedStyle(element).color,
      inside: element.firstElementChild.contains(getSelection()?.anchorNode),
    }));
    assert.equal(caret.inside, true);
    assert.equal(caret.color, caret.foreground);
    await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await input.press("Backspace");
    checks.push(
      `${theme}: native newline, Enter acceptance, retained submission text, shell focus and subsequent typing`,
    );
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(sourceCss))
      .digest("hex"),
    sourceCssSha256,
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.message);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.evaluate(() => globalThis.releaseComposerSubmission?.()).catch(() => {});
    await app.close();
  }
  const connection = new ServiceConnection();
  try {
    const metadata = JSON.parse(await readFile(join(home, "service.json"), "utf8"));
    await connection.connect(metadata);
    await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
    await new DesktopLifecycle({
      connection,
      metadata,
      home,
      notify: async () => ({ response: 1 }),
    }).stop({ mode: "cancel" });
  } catch (error) {
    if (error.code !== "ENOENT") {
      errors.push("cleanup: " + error.message);
      passed = false;
      process.exitCode = 1;
    }
  } finally {
    connection.close();
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        observations,
        source: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        sourceCssSha256,
        stylesheetSha256,
        scriptSha256: createHash("sha256")
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest("hex"),
        binary,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        boundary:
          "real Electron/Main/Core; native keyboard; local model; native picker injected; real submission IPC delayed until observation; no install/package",
      },
      null,
      2,
    ),
  );
  console.log(`${passed ? "PASS" : "FAIL"} composer focus during Enter submission`);
  console.log(JSON.stringify({ passed, evidence: scratch, errors }));
}
