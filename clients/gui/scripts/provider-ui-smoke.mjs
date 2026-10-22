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
const apiKeyFeedbackOnly = process.argv.includes("--api-key-feedback");
const connectionFlowOnly = process.argv.includes("--connection-flow");
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
providerUiChecks: try {
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
    window.fixtureKey = "fixture-saved-key";
    window.fixtureReveals = [];
    window.fixtureWork = false;
    window.fixtureDiscoveryManual = false;
    window.fixtureDiscoveries = [];
    window.finishDiscovery = (index, result) => window.fixtureDiscoveries[index].resolve(result);
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
    let revision = 0,
      projectionSequence = 0,
      projectionListener;
    window.arealDesktop = {
      requestProjection: (requestId) => projectionListener({
        requestId,
        frame: {
          projection: 1,
          stream: "provider-ui-fixture",
          sequence: ++projectionSequence,
          kind: "full",
          snapshot: structuredClone(snapshot),
        },
      }),
      onProjection: (listener) => {
        projectionListener = listener;
        return () => {};
      },
      theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
      onTheme: () => () => {},
      onMcpAppEvent: () => () => {},
      presentReady: async () => {},
      preview: async () => ({}),
      command: async (name, params) => {
        window.calls.push({ name, params });
        if (name === "providers") {
          const store = window.fixtureProviders;
          if (params.operation === "revealKey") {
            if (window.fixtureRevealManual) return new Promise(resolve => window.fixtureReveals.push(resolve));
            if (window.fixtureRevealFailed) return { ok: false, error: { message: "无法显示 API Key，请解锁系统安全存储后重试。" } };
            return { ok: true, value: { apiKey: store.credentialSources[params.id] === "environment" ? "fixture-env-key" : window.fixtureKey } };
          }
          if (["save", "saveAndApply"].includes(params.operation)) {
            if (params.expectedRevision !== store.revision)
              return { ok: false, error: { message: "供应商配置已变化，请刷新后重新保存" } };
            if (window.fixtureWork && params.operation === "saveAndApply")
              return { ok: false, error: { message: "任务正在进行，完成后再保存；修改仍保留。" } };
            if (params.apiKey) window.fixtureKey = params.apiKey;
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
            store.pendingApply = window.fixtureWork;
            store.application = store.pendingApply
              ? { kind: "deferred", revision: store.revision, reason: "busy" }
              : { kind: "applied", revision: store.revision };
            store.projects = store.projects.map(project => ({ ...project, applied: !store.pendingApply }));
          }
          if (params.operation === "apply") {
            if (window.fixtureWork)
              return { ok: false, error: { message: "请等待任务完成后再应用模型配置" } };
            store.pendingApply = false;
          }
          if (params.operation === "discover" && window.fixtureDiscoveryManual)
            return new Promise(resolve => { window.fixtureDiscoveries.push({ params, resolve }); });
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
  if (connectionFlowOnly) {
    assert.equal(await page.getByRole("tab", { name: "连接配置", exact: true }).count(), 0, "Connection settings and models must be one page");
    assert.equal(await page.getByRole("tab", { name: "模型", exact: true }).count(), 0);
    const controls = [
      page.getByRole("tablist", { name: "API 格式", exact: true }),
      page.getByRole("textbox", { name: "供应商名称", exact: true }),
      page.getByTestId("provider-base-url"),
      page.getByTestId("provider-api-key"),
      page.getByRole("button", { name: "添加模型", exact: true }),
    ];
    const boxes = [];
    for (const control of controls) {
      assert.equal(await control.isVisible(), true);
      boxes.push(await control.boundingBox());
    }
    assert.ok(boxes.every((box, index) => index === 0 || boxes[index - 1].y < box.y), "Fields appear in protocol, name, Base URL, API Key, models order");
    assert.equal(await page.getByTestId("provider-api-key").getAttribute("placeholder"), "••••••••");
    assert.equal(await page.getByText("API Key 已安全保存。留空保留，输入新值替换。", { exact: true }).count(), 0);
    assert.equal(await page.getByTestId("provider-api-key").inputValue(), "");
    await page.screenshot({ path: join(evidence, "connection-single-page.png"), fullPage: true });
    await page.evaluate(() => { window.fixtureDiscoveryManual = true; window.calls = []; });
    await page.getByRole("button", { name: "添加供应商", exact: true }).click();
    await page.getByTestId("custom-provider").click();
    assert.equal(await page.getByRole("textbox", { name: "供应商名称", exact: true }).isVisible(), true, "Selecting a provider opens the ordered form directly");
    await page.getByTestId("provider-base-url").fill("https://old-draft.fixture.invalid/v1");
    await page.getByTestId("provider-api-key").fill("synthetic-unsaved-draft-key");
    await page.waitForFunction(() => window.fixtureDiscoveries.length === 1);
    assert.deepEqual(await page.evaluate(() => window.fixtureDiscoveries[0].params.connection), {
      protocol: "chatCompletions", baseUrl: "https://old-draft.fixture.invalid/v1",
      credential: { kind: "draft", value: "synthetic-unsaved-draft-key" },
    });
    assert.equal(await page.evaluate(() => window.calls.some(call => ["save", "saveAndApply"].includes(call.params.operation))), false);
    await page.getByTestId("provider-base-url").fill("https://current-draft.fixture.invalid/v1");
    await page.waitForFunction(() => window.fixtureDiscoveries.length === 2);
    await page.evaluate(() => window.finishDiscovery(1, { ok: true, value: { models: ["fresh-model"], modelParameters: { "fresh-model": { contextWindowTokens: 180000 } } } }));
    await page.getByRole("checkbox", { name: "fresh-model", exact: true }).waitFor();
    await page.evaluate(() => window.finishDiscovery(0, { ok: true, value: { models: ["obsolete-model"] } }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole("checkbox", { name: "obsolete-model", exact: true }).count(), 0, "Late old discovery cannot overwrite the current connection result");
    assert.equal(await page.getByRole("dialog").count(), 0, "Automatic discovery stays on the same page");
    await page.getByRole("checkbox", { name: "fresh-model", exact: true }).check();
    await page.getByRole("button", { name: "添加所选模型", exact: true }).click();
    await page.locator(".provider-model-row").filter({ hasText: "fresh-model" }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureProviders.data.length), 1, "Selecting discovered models only updates the unsaved draft");
    assert.equal(await page.evaluate(() => window.calls.some(call => ["save", "saveAndApply"].includes(call.params.operation))), false);
    await page.getByTestId("provider-base-url").fill("https://failed-draft.fixture.invalid/v1");
    await page.waitForFunction(() => window.fixtureDiscoveries.length === 3);
    await page.evaluate(() => window.finishDiscovery(2, { ok: false, error: { message: "合成服务模型列表失败" } }));
    await page.getByText("合成服务模型列表失败", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("provider-api-key").inputValue(), "synthetic-unsaved-draft-key");
    await page.getByRole("button", { name: "添加模型", exact: true }).click();
    await page.getByRole("textbox", { name: "模型 ID", exact: true }).fill("manual-fallback-model");
    await page.getByRole("button", { name: "保存模型", exact: true }).click();
    await page.evaluate(() => { window.fixtureWork = true; });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => window.fixtureProviders.data.length === 2);
    const saved = await page.evaluate(() => ({ revision: window.fixtureProviders.revision, provider: window.fixtureProviders.data.at(-1), pending: window.fixtureProviders.pendingApply, save: window.calls.findLast(call => call.params.operation === "save") }));
    assert.ok(saved.save, "Provider Save persists through the existing save operation");
    assert.equal(saved.pending, true);
    assert.deepEqual(saved.provider.models.map(model => model.id), ["fresh-model", "manual-fallback-model"]);
    assert.equal(saved.provider.models[0].parameters.contextWindowTokens, 180000);
    for (const model of saved.provider.models) assert.deepEqual(model.capabilities, { tools: true, vision: false, reasoning: true, reasoningEffortOptions: ["low", "medium", "high", "xhigh"] });
    assert.equal(await page.getByTestId("provider-api-key").inputValue(), "");
    assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
    await page.getByText(/已保存.*任务结束/).waitFor();
    assert.equal(await page.evaluate(() => window.calls.some(call => ["cancel", "restart", "configure"].includes(call.name))), false);
    await page.screenshot({ path: join(evidence, "connection-saved-pending.png"), fullPage: true });
    await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("Next unsaved provider name");
    await page.getByTestId("provider-api-key").fill("synthetic-next-unsaved-key");
    const listsBefore = await page.evaluate(() => window.calls.filter(call => call.params.operation === "list").length);
    await page.evaluate(() => {
      window.fixtureWork = false;
      window.fixtureProviders.revision = "fixture-external-revision";
      window.fixtureProviders.pendingApply = false;
      window.fixtureProviders.application = { kind: "applied", revision: window.fixtureProviders.revision };
      window.fixtureProviders.data.at(-1).name = "Externally updated provider";
      window.fixtureProviders.projects = window.fixtureProviders.projects.map(project => ({ ...project, applied: true }));
    });
    await page.waitForFunction(before => window.calls.filter(call => call.params.operation === "list").length > before, listsBefore);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText(/已保存.*任务结束/).count(), 0, "Pending feedback follows the latest applied projection");
    assert.equal(await page.getByRole("textbox", { name: "供应商名称", exact: true }).inputValue(), "Next unsaved provider name");
    assert.equal(await page.getByTestId("provider-api-key").inputValue(), "synthetic-next-unsaved-key");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("供应商配置已变化，请刷新后重新保存", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.findLast(call => call.params.operation === "save").params.expectedRevision), saved.revision, "Polling preserves the draft's original CAS baseline");
    assert.equal(await page.evaluate(() => window.fixtureProviders.data.at(-1).name), "Externally updated provider");
    assert.equal(await page.getByTestId("provider-api-key").inputValue(), "synthetic-next-unsaved-key");
    checks.push("Single page orders protocol, name, URL, key and models; stored keys show an input mask while the actual value remains empty; discovery uses the unsaved draft, ignores stale responses and never saves; manual models remain available after failure; active-work Save persists and reports pending application; status polling preserves the next unsaved draft and its CAS baseline");
    assert.deepEqual(errors, []);
    passed = true;
    break providerUiChecks;
  }
  const apiKey = page.getByTestId("provider-api-key");
  const savedKeyStatus = "API Key 已安全保存。留空保留，输入新值替换。";
  await page.screenshot({ path: join(evidence, "saved-api-key.png"), fullPage: true });
  assert.equal(
    await page.getByText(savedKeyStatus, { exact: true }).count(),
    0,
    "Saved credentials are represented inside the input without an explanatory line",
  );
  assert.equal(await apiKey.inputValue(), "");
  assert.equal(await apiKey.getAttribute("placeholder"), "••••••••");
  assert.equal(await apiKey.getAttribute("type"), "password");
  assert.equal(await apiKey.isEditable(), true);
  assert.equal(
    await page.getByRole("button", { name: "显示 API Key", exact: true }).isDisabled(),
    false,
  );
  await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
  await page.getByRole("button", { name: "隐藏 API Key", exact: true }).waitFor();
  assert.equal(await apiKey.inputValue(), "fixture-saved-key");
  assert.equal(await apiKey.getAttribute("type"), "text");
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true, "Viewing a saved key is not an edit");
  await page.getByRole("button", { name: "隐藏 API Key", exact: true }).click();
  assert.equal(await apiKey.inputValue(), "", "Hiding discards the revealed plaintext");
  await page.evaluate(() => { window.fixtureRevealManual = true; });
  await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
  await page.waitForFunction(() => window.fixtureReveals.length === 1);
  await page.locator(".provider-catalog-row").filter({ hasText: "ChatGPT" }).click();
  await page.locator(".provider-catalog-row").filter({ hasText: "API Fixture" }).click();
  await page.evaluate(() => { window.fixtureReveals[0]({ ok: true, value: { apiKey: "stale-fixture-key" } }); window.fixtureRevealManual = false; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await apiKey.inputValue(), "", "A late reveal cannot follow a provider switch");
  await page.evaluate(() => { window.fixtureRevealFailed = true; });
  await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
  await page.getByText("无法显示 API Key，请解锁系统安全存储后重试。", { exact: true }).waitFor();
  assert.equal(await apiKey.inputValue(), "");
  await page.evaluate(() => { window.fixtureRevealFailed = false; });
  await apiKey.fill("fixture-replacement-key");
  assert.equal(
    await page.getByRole("button", { name: "显示 API Key", exact: true }).isEnabled(),
    true,
  );
  await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
  assert.equal(await apiKey.getAttribute("type"), "text");
  assert.equal(await apiKey.inputValue(), "fixture-replacement-key");
  await page.getByRole("button", { name: "隐藏 API Key", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存并应用。", { exact: true }).waitFor();
  assert.equal(await apiKey.inputValue(), "");
  assert.equal(await apiKey.getAttribute("placeholder"), "••••••••");
  assert.equal(await apiKey.getAttribute("type"), "password");
  assert.equal(
    await page.getByRole("button", { name: "显示 API Key", exact: true }).isDisabled(),
    false,
  );
  assert.equal(await page.getByText(savedKeyStatus, { exact: true }).count(), 0);
  assert.deepEqual(
    await page.evaluate(() => {
      const saved = window.calls.findLast(
        (call) => call.name === "providers" && call.params.operation === "save",
      );
      return {
        authentication: saved.params.authentication,
        apiKey: saved.params.apiKey,
        source: window.fixtureProviders.credentialSources["fixture-api"],
        state: window.fixtureProviders.credentialStates["fixture-api"],
      };
    }),
    {
      authentication: "apiKey",
      apiKey: "fixture-replacement-key",
      source: "stored",
      state: "available",
    },
  );
  assert.equal(
    await page.evaluate(
      () => window.calls.filter((call) => call.params?.operation === "probe").length,
    ),
    0,
    "saving and applying a credential must not claim a connection probe succeeded",
  );
  assert.equal(await page.getByText(/连接成功/).count(), 0);
  await apiKey.fill("fixture-next-draft");
  assert.equal(await page.getByText("已保存并应用。", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await page.locator(".provider-catalog-row").filter({ hasText: "ChatGPT" }).click();
  await page.locator(".provider-catalog-row").filter({ hasText: "API Fixture" }).click();
  assert.equal(await page.getByText(savedKeyStatus, { exact: true }).count(), 0);
  assert.equal(await apiKey.inputValue(), "");
  assert.equal(await page.getByText("已保存并应用。", { exact: true }).count(), 1, "Reopening projects the confirmed applied revision");
  for (const [source, state, status] of [
    [
      "environment",
      "available",
      "正在使用环境变量中的 API Key。留空保留，输入新值替换。",
    ],
    ["none", "unavailable", "尚未配置可用的 API Key。"],
    ["stored", "available", savedKeyStatus],
  ]) {
    await page.evaluate(
      ({ source, state }) => {
        window.fixtureProviders.credentialSources["fixture-api"] = source;
        window.fixtureProviders.credentialStates["fixture-api"] = state;
      },
      { source, state },
    );
    await page.getByRole("button", { name: "刷新供应商", exact: true }).click();
    const placeholder = state === "available" ? "••••••••" : "输入 API Key";
    await page.getByPlaceholder(placeholder, { exact: true }).waitFor();
    await page.locator(".provider-catalog-row").filter({ hasText: "ChatGPT" }).click();
    await page.locator(".provider-catalog-row").filter({ hasText: "API Fixture" }).click();
    assert.equal(await page.getByText(status, { exact: true }).count(), 0);
    assert.equal(await apiKey.getAttribute("placeholder"), placeholder);
    assert.equal(await apiKey.inputValue(), "");
    assert.equal(
      await page.getByRole("button", { name: "显示 API Key", exact: true }).isDisabled(),
      state !== "available",
    );
  }
  await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
  await page.getByRole("button", { name: "隐藏 API Key", exact: true }).waitFor();
  assert.equal(await apiKey.inputValue(), "fixture-replacement-key");
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("API Fixture Renamed");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存并应用。", { exact: true }).waitFor();
  assert.equal(await apiKey.getAttribute("placeholder"), "••••••••");
  assert.equal(await page.evaluate(() => Object.hasOwn(window.calls.findLast(call => call.params?.operation === "save").params, "apiKey")), false, "A mask must never be submitted as a replacement credential");
  checks.push(
    "Available stored/environment keys show only an input mask; missing keys show the input prompt; replacement drafts clear after save; saved keys reveal only on click and clear on hide/switch; stale replies and locked storage remain masked; viewing is not an edit and plaintext is never resubmitted; save feedback never implies a connection probe",
  );
  if (apiKeyFeedbackOnly) {
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    passed = true;
    break providerUiChecks;
  }
  assert.equal(await page.getByText("帮助", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "模型 fixture-model 更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑模型 fixture-model", exact: true }).click();
  await page.getByRole("textbox", { name: "显示名称", exact: true }).fill("Renamed fixture");
  await page.getByRole("button", { name: "保存模型", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存并应用。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "应用模型配置", exact: true }).count(), 0);
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
    "one save confirms Core readiness, preserves GUI/CLI context parameters and leaves model choice in the conversation",
  );
  await page.evaluate(() => {
    window.fixtureWork = true;
  });
  await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("Busy save draft");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText(/已保存.*任务结束/).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureProviders.data[0].name), "Busy save draft");
  assert.equal(await page.evaluate(() => window.fixtureProviders.pendingApply), true);
  assert.equal(
    await page.getByRole("textbox", { name: "供应商名称", exact: true }).inputValue(),
    "Busy save draft",
  );
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
  await page
    .getByRole("textbox", { name: "供应商名称", exact: true })
    .fill("API Fixture Confirmed");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存并应用。", { exact: true }).waitFor();
  checks.push(
    "busy save persists without cancelling work, later edits remain protected by navigation, and an idle save reports applied",
  );
  await page.locator(".provider-catalog-row").filter({ hasText: "ChatGPT" }).click();
  await page.locator('[aria-label="ChatGPT 连接状态"]').filter({ hasText: "可用" }).waitFor();
  await page.getByRole("tablist", { name: "已保存 ChatGPT 账号", exact: true }).getByRole("tab", { name: /ChatGPT 2/ }).click();
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
  await page.getByRole("tablist", { name: "认证方式", exact: true }).getByRole("tab", { name: "无需认证", exact: true }).click();
  await page.getByTestId("provider-base-url").fill("https://custom.fixture.invalid/v1");
  assert.equal(await page.getByTestId("provider-api-key").count(), 0);
  await page.getByRole("checkbox", { name: "fixture-discovered", exact: true }).check();
  await page.getByRole("button", { name: "添加所选模型", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
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
    "custom gateway discovery uses the unsaved no-auth connection and selected models persist on Save",
  );
  await page.getByRole("button", { name: "添加供应商", exact: true }).click();
  await page.getByTestId("OpenAI").click();
  assert.equal(await page.getByTestId("provider-base-url").isVisible(), true);
  await page.getByTestId("provider-api-key").fill("fixture-key-only");
  await page.getByRole("checkbox", { name: "fixture-discovered", exact: true }).check();
  await page.getByRole("button", { name: "添加所选模型", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
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
    "API provider templates open visible connection fields directly and save the selected models with the draft key",
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
} catch (error) {
  errors.push(error.stack ?? String(error));
  const page = browser?.contexts()[0]?.pages()[0];
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
    await writeFile(join(evidence, "failure.txt"), await page.locator("body").innerText());
  }
  throw error;
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
        viewports: apiKeyFeedbackOnly || connectionFlowOnly ? ["1280x1000"] : ["1280x1000", "800x900"],
        scope: connectionFlowOnly ? "connection-flow" : apiKeyFeedbackOnly ? "api-key-feedback" : "provider-ui",
        fixtureOnly: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence, checks, errors }));
}
