import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { IntlProvider } = require("react-intl");

const createTestServer = () =>
  createServer({
    root: fileURLToPath(new URL("../renderer/", import.meta.url)),
    configFile: false,
    plugins: [
      {
        name: "static-locale-preferences",
        enforce: "pre",
        resolveId(id, importer) {
          if (
            id.endsWith("/settings/applicationPreferences.js") &&
            importer?.endsWith("/i18n/IntlProvider.tsx")
          )
            return "\0static-locale-preferences";
        },
        load(id) {
          if (id === "\0static-locale-preferences")
            return 'export function useApplicationPreferences() { return { locale: "zh-CN" }; }';
        },
      },
    ],
    resolve: { alias: { "@": fileURLToPath(new URL("../renderer/src/", import.meta.url)) } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
    appType: "custom",
    oxc: { jsx: { runtime: "automatic" } },
  });

test("backend service settings keep lifecycle details and controls outside chat", async () => {
  const vite = await createTestServer();
  try {
    const { BackendServiceStatus } = await vite.ssrLoadModule("/src/BackendStatusNotice.tsx");
    const { catalogs } = await vite.ssrLoadModule("/src/i18n/messages.ts");
    const markup = (element) =>
      renderToStaticMarkup(
        React.createElement(
          IntlProvider,
          { locale: "zh-CN", messages: catalogs["zh-CN"] },
          element,
        ),
      );
    const render = (props) =>
      markup(
        React.createElement(BackendServiceStatus, {
          connection: { state: "ready" },
          currentCommands: true,
          pending: false,
          error: "",
          onAction() {},
          ...props,
        }),
      );
    for (const busy of [false, true]) {
      assert.equal(
        render({ summary: { state: "running", busy } }),
        "",
        "ready services need no extra status panel",
      );
    }
    for (const [props, message, action] of [
      [{ connection: { state: "unavailable" } }, "暂时无法连接后台", "重新连接"],
      [{ update: { state: "pending" } }, "更新可稍后应用", "更新后台…"],
      [{ update: { state: "applying" } }, "正在更新后台…"],
      [{ update: { state: "failed" } }, "后台更新失败", "更新后台…"],
      [{ currentCommands: false }, "更新后台后再发送", "更新后台…"],
      [{ lifecycle: { error: "生命周期操作失败" } }, "生命周期操作失败", "检查后台"],
      [{ lifecycle: { recovery: { message: "需要恢复原后台" } } }, "需要恢复原后台", "恢复后台…"],
      [{ connection: undefined, summary: { state: "stopped", busy: false } }, "后台已停止"],
      [{ connection: { state: "ready", recovery: "check" } }, "后台操作结果尚未确认", "检查后台"],
    ]) {
      const html = render(props);
      assert.ok(html.includes(message), message);
      assert.match(
        html,
        props.update?.state === "failed" || props.lifecycle?.error
          ? /role="alert"/
          : /role="status"/,
      );

      if (action) assert.ok(html.includes(action), action);
    }
  } finally {
    await vite.close();
  }
});

test("backend service settings keep inspection read-only and exposes a new explicit update only after target uncertainty settles", async () => {
  const vite = await createTestServer();
  try {
    const { BackendServiceStatus } = await vite.ssrLoadModule("/src/BackendStatusNotice.tsx");
    const { catalogs } = await vite.ssrLoadModule("/src/i18n/messages.ts");
    const markup = (element) =>
      renderToStaticMarkup(
        React.createElement(
          IntlProvider,
          { locale: "zh-CN", messages: catalogs["zh-CN"] },
          element,
        ),
      );
    const render = (phase, phases, desktopExit = "notRequested", kind = "updateDesktop") =>
      markup(
        React.createElement(BackendServiceStatus, {
          connection: { state: "ready" },
          update: { state: "pending" },
          lifecycle: {
            supported: true,
            operations: [],
            kind,
            phase,
            desktopExit,
            targets: phases.map((phase, index) => ({ projectId: String(index), phase })),
          },
          pending: false,
          error: "",
          onAction() {},
        }),
      );
    for (const [phase, phases] of [
      ["partial", ["completed", "blocked"]],
      ["settlementIncomplete", ["settlementIncomplete"]],
      ["acceptedPending", ["completed"]],
    ]) {
      const html = render(phase, phases);
      assert.match(html, /检查后台/);
      assert.match(html, /更新后台…/);
    }
    for (const html of [
      render("partial", ["completed", "admissionUnconfirmed"]),
      render("acceptedPending", ["acceptedPending"]),
      render("acceptedPending", ["completed"], "requested"),
    ]) {
      assert.match(html, /检查后台/);
      assert.doesNotMatch(html, /更新后台…/);
    }
    assert.doesNotMatch(
      render("settlementIncomplete", ["settlementIncomplete"], "notRequested", "stopDesktop"),
      /更新后台…/,
    );
  } finally {
    await vite.close();
  }
});
