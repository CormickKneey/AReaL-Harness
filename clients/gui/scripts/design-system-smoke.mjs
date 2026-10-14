import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// 检查真实生产组件的渲染与局部交互；Core/原生行为由现有桌面 smoke 负责。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const dist = join(gui, "dist/design-system");
const scratch = await mkdtemp(join(tmpdir(), "areal-design-system-"));
const baseline = process.argv.includes("--baseline");
const html = await readFile(join(dist, "design-system.html"), "utf8");
const buildDigest = createHash("sha256").update(html);
for (const match of html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)) buildDigest.update(await readFile(join(dist, match[1])));
const buildSha256 = buildDigest.digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui }).toString().trim();
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    const path = resolve(dist, `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("invalid asset path");
    response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(path));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page, passed = false;
const errors = [], external = [], samples = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: "chrome" }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.route("**/*", route => {
    if (route.request().url().startsWith(origin + "/")) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/design-system.html`);
  await page.getByRole("heading", { name: "客户端设计系统", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.arealDesktop), "undefined");
  const input = page.getByTestId("preview-composer");
  await input.fill("保留这份草稿 Keep this draft");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: "预览收到输入" }).waitFor();
  assert.equal(await input.innerText(), "保留这份草稿 Keep this draft");
  checks.push("production editor submit=false retains draft without desktop bridge");
  const composer = page.getByRole("region", { name: "Composer 预览", exact: true });
  await composer.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("dialog", { name: "模型与思考强度" }).waitFor();
  await page.keyboard.press("Escape");
  await input.waitFor();
  assert.equal(await input.innerText(), "保留这份草稿 Keep this draft");
  checks.push("production model menu opens/closes with draft retained");
  for (const sample of [
    { theme: "light", font: "14", width: "wide" }, { theme: "dark", font: "14", width: "wide" },
    { theme: "light", font: "18", width: "narrow" }, { theme: "dark", font: "18", width: "narrow" },
  ]) {
    await page.getByLabel("主题", { exact: true }).selectOption(sample.theme);
    await page.getByLabel("字号", { exact: true }).selectOption(sample.font);
    await page.getByLabel("面板宽度", { exact: true }).selectOption(sample.width);
    await page.waitForFunction(({ font, theme }) => getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() === `${font}px` && document.documentElement.classList.contains("dark") === (theme === "dark"), sample);
    const measured = await page.evaluate(() => {
      const style = selector => { const el = document.querySelector(selector); const css = getComputedStyle(el); return { fontSize: css.fontSize, background: css.backgroundColor, color: css.color, radius: css.borderRadius, height: el.getBoundingClientRect().height }; };
      return { card: style(".decision-card"), feedback: style(".ui-feedback"), sideHeading: style(".side-chat-heading"), sideInfo: style(".side-chat-information"), composer: style(".composer-editor [contenteditable]"),
        overflow: [...document.querySelectorAll(".design-preview-panel")].some(el => el.scrollWidth > el.clientWidth + 1) };
    });
    assert.equal(measured.overflow, false, "preview panels must not overflow horizontally");
    assert.equal(measured.card.fontSize, `${sample.font}px`);
    assert.equal(measured.card.radius, "20px");
    assert.equal(measured.feedback.fontSize, `${sample.font}px`);
    if (!baseline) {
      assert.equal(measured.sideHeading.fontSize, `${Number(sample.font) - 2}px`);
      assert.equal(measured.sideInfo.fontSize, `${Number(sample.font) - 3}px`);
    }
    assert.equal(measured.composer.fontSize, `${Number(sample.font) + 2}px`);
    samples.push({ ...sample, measured });
    await page.locator(".design-preview").evaluate(element => element.scrollTo(0, 0));
    await page.screenshot({ path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}.png`), fullPage: true, animations: "disabled" });
    for (const name of ["Composer 预览", "审批预览", "Side 预览"]) {
      await page.getByRole("region", { name, exact: true }).screenshot({ path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}-${name}.png`), animations: "disabled" });
    }
  }
  checks.push("light/dark and wide/narrow production components; semantic typography and layout");
  await page.getByLabel("状态", { exact: true }).selectOption("busy");
  assert.equal(await input.getAttribute("contenteditable"), "false");
  await page.getByRole("region", { name: "工具审批", exact: true }).getByRole("button", { name: "允许一次", exact: true }).click();
  await page.getByText("提交中…", { exact: true }).waitFor();
  await page.getByLabel("状态", { exact: true }).selectOption("failed");
  const card = page.getByRole("region", { name: "工具审批", exact: true });
  await card.getByRole("button", { name: "允许一次", exact: true }).click();
  await card.getByRole("alert").waitFor();
  await page.getByLabel("状态", { exact: true }).selectOption("unknown");
  await card.getByRole("button", { name: "允许一次", exact: true }).click();
  await card.getByRole("button", { name: "核对待审批状态", exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "允许一次", exact: true }).count(), 0);
  checks.push("real approval component shows busy/failure/unknown and blocks duplicate decisions");
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await page.screenshot({ path: join(scratch, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(scratch, "manifest.json"), JSON.stringify({ passed, baseline, commit, buildSha256, checks, errors, external, samples, scope: "production renderer components with local fixture actions; no Electron/Core acceptance" }, null, 2));
  console.log(JSON.stringify({ passed, scratch, checks, errors }));
}
