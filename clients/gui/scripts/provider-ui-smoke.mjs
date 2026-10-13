import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 真实 renderer 使用隔离 IPC fixture；不启动 Core、不读取用户配置、不进行外部授权。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const dist = join(gui, "renderer/dist");
const evidence = await mkdtemp(join(tmpdir(), "areal-provider-ui-"));
const checks = [],
  errors = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://fixture").pathname);
    const path = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("invalid fixture asset");
    const body = await readFile(path);
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[extname(path)] ?? "application/octet-stream",
    );
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser,
  passed = false;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.AREAL_GUI_TEST_BROWSER ?? "/usr/bin/chromium",
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    serviceWorkers: "block",
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push("unexpected external request");
    return route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    const snapshot = {
      projects: [],
      connection: { state: "ready" },
      library: { projects: {}, threads: {}, projectOrder: [], settings: {} },
    };
    window.calls = [];
    window.fixtureWork = false;
    window.fixtureProviders = {
      revision: "fixture-0",
      data: [
        {
          id: "fixture-api",
          name: "API Fixture",
          enabled: true,
          endpoint: "https://fixture.invalid/v1/responses",
          baseUrl: "https://fixture.invalid/v1",
          protocol: "responses",
          apiKeyEnv: "FIXTURE_REFERENCE",
          models: [
            { id: "fixture-model", enabled: true, parameters: { contextWindowTokens: 131072 } },
          ],
          parameters: { contextWindowTokens: 200000 },
          connection: { billing: "api" },
        },
      ],
      credentialStates: { "fixture-api": "available" },
      credentialSources: { "fixture-api": "stored" },
      projects: [{ projectId: "fixture-project", connected: true, applied: true }],
      pendingApply: false,
    };
    window.fixtureSubscription = {
      authenticated: true,
      email: "same@fixture.invalid",
      state: "ready",
      activeAccountId: "primary",
      models: [{ id: "fixture-chatgpt", name: "Fixture ChatGPT" }],
      accounts: [
        {
          id: "primary",
          label: "ChatGPT 1",
          email: "same@fixture.invalid",
          active: true,
          state: "saved",
        },
        {
          id: "second",
          label: "ChatGPT 2",
          email: "same@fixture.invalid",
          active: false,
          state: "saved",
        },
      ],
    };
    let revision = 0;
    window.arealDesktop = {
      snapshot: async () => snapshot,
      onState: (listener) => {
        window.setTestState = listener;
        return () => {};
      },
      theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
      onTheme: () => () => {},
      presentReady: async () => {},
      preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === "providers") {
          const store = window.fixtureProviders;
          if (params.operation === "save") {
            const raw = params.provider;
            const id = raw.id || `fixture-new-${++revision}`;
            const item = {
              ...raw,
              id,
              endpoint:
                raw.baseUrl + (raw.protocol === "responses" ? "/responses" : "/chat/completions"),
              connection: {
                billing:
                  raw.kind === "api" || raw.connection?.billing === "api" ? "api" : "provider",
              },
            };
            delete item.basedOnRevision;
            store.data = raw.id
              ? store.data.map((previous) => (previous.id === id ? item : previous))
              : [...store.data, item];
            store.credentialSources[id] = params.authentication === "none" ? "none" : "stored";
            store.credentialStates[id] =
              params.authentication === "none" ? "notRequired" : "available";
            store.revision = `fixture-${++revision}`;
            store.pendingApply = true;
          }
          if (params.operation === "apply") {
            if (window.fixtureWork)
              return { ok: false, error: { message: "请等待任务完成后再应用模型配置" } };
            store.pendingApply = false;
          }
          if (params.operation === "discover")
            return { ok: true, value: { models: ["fixture-model", "fixture-discovered"] } };
          if (params.operation === "probe") return { ok: true, value: { state: "connected" } };
          return { ok: true, value: structuredClone(store) };
        }
        if (name === "chatgpt") {
          const value = window.fixtureSubscription;
          if (params.operation === "login") value.login = { loginId: "fixture-login" };
          if (params.operation === "cancel") value.login = null;
          if (params.operation === "selectAccount") {
            value.activeAccountId = params.accountId;
            for (const account of value.accounts) account.active = account.id === params.accountId;
          }
          if (params.operation === "probe") return { ok: true, value: { state: "connected" } };
          return { ok: true, value: structuredClone(value) };
        }
        if (name === "trajectory")
          return { ok: true, value: { enabled: false, state: "disabled", records: [] } };
        return { ok: true, value: { data: [], projects: [], pendingApply: false } };
      },
    };
  });
  await page.goto(origin);
  await page.locator('[data-testid="areal-workbench"]').waitFor();
  assert.equal(new URL(page.url()).origin, origin);
  assert.ok((await page.title()).length > 0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.locator(".provider-catalog-row").filter({ hasText: "API Fixture" }).click();
  await page.locator('[aria-label="供应商计费方式"]').filter({ hasText: "API 计费" }).waitFor();
  await page.getByRole("button", { name: "编辑模型 fixture-model", exact: true }).click();
  await page.getByRole("textbox", { name: "显示名称", exact: true }).fill("Renamed fixture");
  await page.getByRole("button", { name: "保存模型", exact: true }).click();
  await page.getByRole("button", { name: "保存供应商", exact: true }).click();
  await page.locator('[aria-label="配置应用状态"]').filter({ hasText: "待应用" }).waitFor();
  assert.equal(
    await page.evaluate(
      () => window.fixtureProviders.data[0].models[0].parameters.contextWindowTokens,
    ),
    131072,
  );
  assert.equal(
    await page.evaluate(() => window.fixtureProviders.data[0].parameters.contextWindowTokens),
    200000,
  );
  checks.push(
    "rendered model edit preserves GUI/CLI context parameters and distinguishes saved/pending application",
  );
  await page.evaluate(() => {
    window.fixtureWork = true;
  });
  await page.getByRole("button", { name: "应用模型配置", exact: true }).click();
  await page.getByText("请等待任务完成后再应用模型配置", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.calls.some((call) => ["cancel", "restart", "configure"].includes(call.name)),
    ),
    false,
  );
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("Unsaved retained");
  await page.getByRole("button", { name: "刷新供应商", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "供应商名称", exact: true }).inputValue(),
    "Unsaved retained",
  );
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await page.evaluate(() => {
    window.fixtureWork = false;
  });
  await page.getByRole("button", { name: "应用模型配置", exact: true }).click();
  await page.locator('[aria-label="配置应用状态"]').filter({ hasText: "已应用" }).waitFor();
  checks.push(
    "busy application is rejected without cancel/restart and guarded navigation retains the draft",
  );
  await page.locator(".provider-catalog-row").filter({ hasText: "ChatGPT" }).click();
  await page.locator('[aria-label="ChatGPT 连接状态"]').filter({ hasText: "可用" }).waitFor();
  await page.getByRole("combobox", { name: "已保存 ChatGPT 账号", exact: true }).click();
  await page.getByRole("option", { name: /ChatGPT 2/ }).click();
  assert.equal(await page.evaluate(() => window.fixtureSubscription.activeAccountId), "second");
  for (const [state, authenticated, label] of [
    ["refreshing", true, "正在刷新凭据"],
    ["temporarily_unavailable", true, "暂时不可用"],
    ["storage_locked", false, "安全存储需要解锁"],
  ]) {
    await page.evaluate(
      ({ state, authenticated }) => {
        Object.assign(window.fixtureSubscription, {
          state,
          authenticated,
          models: [],
          diagnostic: {
            code: state === "storage_locked" ? "storage_locked" : "network_error",
            phase: "catalog",
            httpStatus: null,
          },
        });
      },
      { state, authenticated },
    );
    await page.getByRole("button", { name: "刷新 ChatGPT 登录状态", exact: true }).click();
    await page.locator('[aria-label="ChatGPT 连接状态"]').filter({ hasText: label }).waitFor();
    assert.equal(await page.getByRole("button", { name: "重新登录", exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "使用 ChatGPT 登录", exact: true }).count(),
      0,
    );
    await page.getByText("Fixture ChatGPT", { exact: true }).waitFor();
    const test = page.getByRole("button", { name: "测试连接", exact: true });
    if (await test.count()) assert.equal(await test.isDisabled(), true);
  }
  await page.screenshot({ path: join(evidence, "storage-locked.png"), fullPage: true });
  await page.evaluate(() => {
    Object.assign(window.fixtureSubscription, {
      state: "ready",
      authenticated: true,
      models: [{ id: "fixture-chatgpt", name: "Fixture ChatGPT" }],
      diagnostic: null,
    });
  });
  await page.getByRole("button", { name: "重试状态", exact: true }).click();
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await page.getByText("连接成功，已收到模型的完整回复。", { exact: true }).waitFor();
  await page.evaluate(() => {
    Object.assign(window.fixtureSubscription, { state: "quota_exceeded", authenticated: true });
  });
  await page.getByRole("button", { name: "刷新 ChatGPT 登录状态", exact: true }).click();
  await page
    .locator('[aria-label="ChatGPT 连接状态"]')
    .filter({ hasText: "应用用量受限" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "测试连接", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "重新登录", exact: true }).count(), 0);
  await page.evaluate(() => {
    Object.assign(window.fixtureSubscription, {
      state: "reauth_required",
      authenticated: false,
      models: [],
    });
  });
  await page.getByRole("button", { name: "刷新 ChatGPT 登录状态", exact: true }).click();
  await page.getByRole("button", { name: "重新登录", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        window.calls.filter((call) => call.name === "chatgpt" && call.params.operation === "login")
          .length,
    ),
    0,
  );
  await page.evaluate(() => {
    Object.assign(window.fixtureSubscription, {
      state: "ready",
      authenticated: true,
      models: [{ id: "fixture-chatgpt", name: "Fixture ChatGPT" }],
    });
  });
  await page.getByRole("button", { name: "刷新 ChatGPT 登录状态", exact: true }).click();
  await page.locator('[aria-label="ChatGPT 连接状态"]').filter({ hasText: "可用" }).waitFor();
  await page.getByRole("button", { name: "添加 ChatGPT 账号", exact: true }).click();
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () =>
        window.calls.filter((call) => call.name === "chatgpt" && call.params.operation === "login")
          .length,
    ),
    1,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.calls.find((call) => call.name === "chatgpt" && call.params.operation === "login")
          .params.newAccount,
    ),
    true,
  );
  checks.push(
    "same-email account labels stay separate; temporary/locked states retain choices and retry without implicit login; pending login remains cancellable",
  );
  await page.getByRole("button", { name: "添加供应商", exact: true }).click();
  await page.getByTestId("custom-provider").click();
  await page.getByRole("button", { name: /^无需认证/ }).click();
  await page.getByTestId("provider-base-url").fill("https://custom.fixture.invalid/v1");
  assert.equal(await page.getByTestId("provider-api-key").count(), 0);
  await page.getByRole("button", { name: "保存并检测连接", exact: true }).click();
  await page.getByRole("checkbox", { name: "fixture-discovered", exact: true }).check();
  await page.getByRole("button", { name: "添加所选模型", exact: true }).click();
  await page.getByRole("button", { name: "保存供应商", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.fixtureProviders.data.at(-1).authentication),
    "none",
  );
  assert.equal(
    await page.evaluate(() => window.fixtureProviders.data.at(-1).models[0].id),
    "fixture-discovered",
  );
  await page.screenshot({ path: join(evidence, "gateway-models.png"), fullPage: true });
  checks.push(
    "service -> authentication -> saved connection detection -> model selection works for a custom gateway",
  );
  await page.getByRole("button", { name: "添加供应商", exact: true }).click();
  await page.getByTestId("OpenAI").click();
  await page.getByRole("button", { name: /^使用 API Key/ }).click();
  assert.equal(await page.getByTestId("provider-base-url").isVisible(), false);
  await page.getByTestId("provider-api-key").fill("fixture-key-only");
  await page.getByRole("button", { name: "保存并检测连接", exact: true }).click();
  await page.getByRole("checkbox", { name: "fixture-discovered", exact: true }).check();
  await page.getByRole("button", { name: "添加所选模型", exact: true }).click();
  await page.getByRole("button", { name: "保存供应商", exact: true }).click();
  assert.equal(
    await page.evaluate(() =>
      window.calls
        .filter((call) => call.name === "providers" && call.params.operation === "save")
        .some(
          (call) =>
            call.params.authentication === "apiKey" && call.params.apiKey === "fixture-key-only",
        ),
    ),
    true,
  );
  checks.push(
    "API Key method and independent API billing are visible; preset address/protocol stay progressively collapsed",
  );
  await page.setViewportSize({ width: 800, height: 900 });
  await page.screenshot({ path: join(evidence, "compact.png"), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(evidence, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        browserPath:
          "Browser plugin not available; existing local Chromium with Playwright automation",
        viewports: ["1280x1000", "800x900"],
        fixtureOnly: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence, checks, errors }));
}
