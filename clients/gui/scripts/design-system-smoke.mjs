import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
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
let browser, page, browserVersion, passed = false;
const errors = [], external = [], samples = [], checks = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AREAL_GUI_TEST_BROWSER ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER } : { channel: "chrome" }) });
  browserVersion = browser.version();
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.route("**/*", route => {
    if (route.request().url().startsWith(origin + "/")) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/design-system.html`);
  await page.getByRole("heading", { name: "客户端设计系统", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.arealDesktop), "undefined");
  const controls = page.getByRole("region", { name: "公共控件", exact: true });
  const toggle = controls.getByRole("switch", { name: "显示底部面板", exact: true });
  const checked = await toggle.getAttribute("aria-checked");
  await toggle.focus(); await page.keyboard.press("Space");
  assert.notEqual(await toggle.getAttribute("aria-checked"), checked, "Base switch supports keyboard state changes");
  await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-checked"), checked);
  const pair = controls.getByRole("tablist", { name: "默认终端位置", exact: true });
  await pair.getByRole("tab", { name: "右侧", exact: true }).click();
  assert.equal(await pair.getByRole("tab", { name: "右侧", exact: true }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await pair.getByRole("tab", { name: "底部", exact: true }).getAttribute("aria-selected"), "true");
  const choice = controls.getByLabel("关闭窗口前确认", { exact: true });
  await choice.click();
  await page.getByRole("option", { name: "始终", exact: true }).click();
  assert.ok((await choice.innerText()).includes("始终"), "Base select displays the confirmed choice");
  await choice.focus(); await page.keyboard.press("Space");
  await page.getByRole("option", { name: "从不", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "关闭窗口前确认", undefined, { timeout: 5000 });
  assert.equal(await choice.evaluate(element => element === document.activeElement), true, "Base select returns focus after dismissal");
  const details = controls.locator("summary");
  await details.focus(); await page.keyboard.press("Enter");
  await details.getByText("收起", { exact: true }).waitFor();
  assert.equal(await details.getAttribute("aria-expanded"), "true");
  assert.ok((await details.innerText()).includes("收起"));
  await page.keyboard.press("Enter");
  await details.getByText("展开", { exact: true }).waitFor();
  assert.equal(await details.getAttribute("aria-expanded"), "false");
  const refresh = controls.getByRole("button", { name: "刷新状态", exact: true });
  await page.getByLabel("状态", { exact: true }).selectOption("busy");
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await refresh.getAttribute("aria-busy"), "true");
  await page.getByLabel("状态", { exact: true }).selectOption("failed");
  assert.ok((await controls.getByRole("alert").innerText()).includes("操作未受理"));
  await page.getByLabel("状态", { exact: true }).selectOption("unknown");
  assert.ok((await controls.getByRole("status").innerText()).includes("结果待核对"));
  await page.getByLabel("状态", { exact: true }).selectOption("ready");
  assert.equal(await refresh.isDisabled(), false);
  assert.equal(await controls.getByRole("button", { name: "不可用", exact: true }).isDisabled(), true);
  checks.push("Base settings controls exercise keyboard switch, pair selection, menu choice/focus, disclosure and busy/failed/unknown feedback");
  const input = page.getByTestId("preview-composer");
  const timeline = page.getByRole("region", { name: "对话时间线预览", exact: true });
  const earlier = timeline.locator('[data-side-item-id="timeline-progress"]');
  assert.equal(await earlier.isVisible(), true, "short commentary remains visible after completion");
  assert.equal(await timeline.getByRole("button", { name: "用时 19秒", exact: true }).count(), 0, "phased history does not nest all progress behind a turn disclosure");
  const longProgress = timeline.locator('[data-side-item-id="timeline-long-progress"]');
  const progressSize = await longProgress.locator(".collapsible-text-viewport").evaluate(el => ({ height: el.clientHeight, full: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
  assert.ok(progressSize.full > progressSize.height && Math.abs(progressSize.height - progressSize.line * 6) <= 1);
  await longProgress.getByRole("button", { name: "展开全文", exact: true }).click();
  assert.equal(await longProgress.getByRole("button", { name: "收起", exact: true }).getAttribute("aria-expanded"), "true");
  assert.ok((await longProgress.innerText()).includes("检查记录 10"));
  await longProgress.getByRole("button", { name: "收起", exact: true }).click();
  const imageToggle = timeline.getByRole("button", { name: "已查看 1 张图片", exact: true });
  assert.equal(await imageToggle.isVisible(), true, "image results remain discoverable with the tools collapsed");
  await imageToggle.click();
  await timeline.getByRole("button", { name: "预览图片 工具图片", exact: true }).waitFor();
  await timeline.getByRole("button", { name: "预览图片 工具图片", exact: true }).click();
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await imageToggle.waitFor();
  const child = timeline.getByRole("button", { name: "打开 preview-child 子对话", exact: true });
  assert.ok((await child.innerText()).includes("检查消息投影"));
  assert.ok((await child.innerText()).includes("已完成"));
  await child.click();
  await timeline.getByRole("status").filter({ hasText: "预览打开：preview-child" }).waitFor();
  const activity = timeline.getByRole("button", { name: "执行过程", exact: true });
  if (await activity.getAttribute("aria-expanded") !== "true") await activity.click();
  const command = timeline.locator('[data-tool-id="timeline-command"]');
  await command.getByRole("button").click();
  await command.getByLabel("工具结果", { exact: true }).waitFor();
  assert.ok((await command.getByLabel("工具结果", { exact: true }).innerText()).includes("类型检查通过"));
  const scrollOwners = await command.locator(".command-card").evaluate(el => ({
    output: getComputedStyle(el.querySelector(".command-output")).overflowY,
    group: getComputedStyle(el.closest(".execution-details")).overflowY,
  }));
  assert.equal(scrollOwners.output, "auto");
  assert.equal(scrollOwners.group, "visible", "expanded tools use transcript scrolling rather than a second activity scrollbar");
  const fileSummary = timeline.getByRole("button", { name: "本轮文件变更", exact: true });
  assert.equal(await fileSummary.getAttribute("aria-expanded"), "false");
  assert.equal(await timeline.getByRole("region", { name: "本轮文件", exact: true }).isVisible(), false);
  await fileSummary.click();
  assert.equal(await timeline.getByRole("region", { name: "本轮文件", exact: true }).isVisible(), true);
  assert.equal(await timeline.getByLabel("合计新增 1 行，删除 1 行", { exact: true }).count(), 1);
  await timeline.getByRole("button", { name: "查看变更", exact: true }).click();
  await timeline.getByRole("status").filter({ hasText: "预览打开：本轮文件变更" }).waitFor();
  await fileSummary.click();
  await timeline.getByRole("button", { name: "显示执行中", exact: true }).click();
  assert.equal(await timeline.getByTestId("turn-file-summary").count(), 0, "running turns do not claim completed file totals");
  assert.equal(await timeline.locator('[data-side-item-id="timeline-stream"] .collapsible-text').count(), 0, "public reasoning after the current streamed reply does not fold that reply");
  await timeline.getByRole("button", { name: "显示已完成", exact: true }).click();
  assert.equal(await longProgress.getByRole("button", { name: "展开全文", exact: true }).getAttribute("aria-expanded"), "false");
  assert.ok((await timeline.locator('[data-side-item-id="timeline-final"]').innerText()).includes("最终回答保留完整内容"));
  checks.push("phased timeline retains short progress, bounds long commentary, and exposes images, named agents, command output and verified file totals without nested activity scrolling");
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
  const longText = page.getByRole("region", { name: "长文本预览", exact: true });
  const longBubble = longText.locator('[data-side-item-id="long"]');
  const shortBubble = longText.locator('[data-side-item-id="short"]');
  const expand = longBubble.getByRole("button", { name: "展开全文", exact: true });
  // Renderer-only acceptance: exercise production Messages, layout and keyboard behavior.
  await expand.waitFor({ timeout: 5000 });
  assert.equal(await expand.getAttribute("aria-expanded"), "false");
  assert.equal(await shortBubble.getByRole("button", { name: "展开全文", exact: true }).count(), 0);
  const collapsedHeight = await longBubble.locator(".collapsible-text-viewport").evaluate(el => el.clientHeight);
  assert.ok(collapsedHeight < 240, "long sent message must leave room for the conversation");
  await expand.focus();
  await page.keyboard.press("Enter");
  const collapse = longBubble.getByRole("button", { name: "收起", exact: true });
  await collapse.waitFor();
  assert.equal(await collapse.getAttribute("aria-expanded"), "true");
  const expanded = await longBubble.locator(".collapsible-text-viewport").evaluate(el => ({ height: el.clientHeight, fullHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY, text: el.textContent }));
  assert.ok(expanded.height > collapsedHeight * 2);
  assert.ok(expanded.fullHeight <= expanded.height + 1, "expanded content uses the conversation scroll");
  assert.ok(expanded.text.includes("END_OF_LONG_MESSAGE"));
  await page.keyboard.press("Space");
  await expand.waitFor();
  assert.equal(await expand.evaluate(el => el === document.activeElement), true, "toggle retains keyboard focus");
  const controlledId = await expand.getAttribute("aria-controls");
  assert.equal(await longBubble.locator(".collapsible-text-viewport").getAttribute("id"), controlledId);
  // Capture the browser clipboard boundary without replacing the user's OS clipboard.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async text => { window.previewCopiedText = text; },
    } });
  });
  await longBubble.getByRole("button", { name: "复制消息", exact: true }).click();
  const copied = await page.evaluate(() => window.previewCopiedText);
  assert.ok(copied.startsWith("# 长消息预览\n\n"));
  assert.ok(copied.includes("第 18 段"));
  assert.ok(copied.endsWith("END_OF_LONG_MESSAGE"), "copy includes text beyond the collapsed preview");
  await longBubble.getByRole("button", { name: "末尾链接", exact: true }).focus();
  await collapse.waitFor();
  assert.equal(await collapse.getAttribute("aria-expanded"), "true", "keyboard focus never remains in clipped content");
  await page.getByLabel("字号", { exact: true }).selectOption("18");
  assert.equal(await collapse.getAttribute("aria-expanded"), "true", "font reflow retains a manual expansion");
  await collapse.click();
  await page.getByLabel("字号", { exact: true }).selectOption("14");
  checks.push("production sent messages default to a bounded preview; short text stays open; keyboard expand/collapse retains full text and focus");
  checks.push("collapsed copy retains original Markdown and tail text; focusing clipped links expands; font changes preserve manual expansion");
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
    const settingStyles = await controls.evaluate(element => {
      // 独立测量语义角色的解析结果，避免从待测控件反推预期。
      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;visibility:hidden;border-radius:var(--radius-overlay);font-size:var(--text-ui-caption)";
      element.append(probe);
      const expected = { radius: getComputedStyle(probe).borderRadius, fontSize: getComputedStyle(probe).fontSize };
      probe.remove();
      const group = element.querySelector(".settings-group-card");
      const action = element.querySelector(".settings-field-control button");
      const rows = [...element.querySelectorAll(".settings-field-layout")].map(row => {
        const label = row.firstElementChild.getBoundingClientRect();
        const control = row.querySelector(".settings-field-control").getBoundingClientRect();
        return { labelTop: label.top, labelBottom: label.bottom, controlTop: control.top, left: control.left, right: control.right };
      });
      return { expected, radius: getComputedStyle(group).borderRadius, actionFont: getComputedStyle(action).fontSize,
        columns: getComputedStyle(element.querySelector(".settings-field-layout")).gridTemplateColumns.split(" ").length, rows };
    });
    // 超出预览滚动视口的整段截图会被祖先裁剪；按可完整观察的生产组合取证。
    for (const [part, target] of [["group", controls.locator(".settings-group-card")], ["states", controls.locator(".settings-section").last()]]) {
      await target.screenshot({ path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}-settings-${part}.png`), animations: "disabled" });
    }
    samples.push({ ...sample, settingStyles });
    assert.equal(settingStyles.radius, settingStyles.expected.radius, "Base settings pattern mounts the production settings surface role, not the library default");
    assert.equal(settingStyles.actionFont, settingStyles.expected.fontSize, "Base actions follow caption typography after font changes");
    assert.equal(settingStyles.columns, sample.width === "narrow" ? 1 : 2, "Base settings reflow uses shared container constraints");
    const alignedEdge = sample.width === "narrow" ? "left" : "right";
    assert.ok(settingStyles.rows.every(row => Math.abs(row[alignedEdge] - settingStyles.rows[0][alignedEdge]) <= 1), "Base settings controls share their content edge");
    if (sample.width === "narrow") assert.ok(settingStyles.rows.every(row => row.controlTop >= row.labelBottom), "narrow settings move controls below the full label/description");
    assert.equal(measured.overflow, false, "preview panels must not overflow horizontally");
    assert.equal(measured.card.fontSize, `${sample.font}px`);
    assert.equal(measured.card.radius, "20px");
    assert.equal(measured.feedback.fontSize, `${sample.font}px`);
    if (!baseline) {
      assert.equal(measured.sideHeading.fontSize, `${Number(sample.font) - 2}px`);
      assert.equal(measured.sideInfo.fontSize, `${Number(sample.font) - 3}px`);
    }
    assert.equal(measured.composer.fontSize, `${Number(sample.font) + 2}px`);
    assert.equal(await expand.getAttribute("aria-expanded"), "false", "theme/font/width changes retain collapsed state");
    const previewSize = await longBubble.locator(".collapsible-text-viewport").evaluate(el => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight), width: el.clientWidth, fullWidth: el.scrollWidth }));
    assert.ok(Math.abs(previewSize.height - previewSize.line * 8) <= 1, "preview follows eight rendered lines at the current font size");
    assert.ok(previewSize.fullWidth <= previewSize.width + 1, "long text wraps inside the bubble");
    const wrappedText = longText.locator('[data-side-item-id="wrapped"]');
    await page.waitForFunction(({ narrow }) => {
      const button = document.querySelector('[data-side-item-id="wrapped"] .collapsible-text-toggle');
      return Boolean(button) === narrow;
    }, { narrow: sample.width === "narrow" });
    assert.equal(await wrappedText.getByRole("button", { name: "展开全文", exact: true }).count(), sample.width === "narrow" ? 1 : 0, "unbroken paragraphs fold only when the rendered width requires it");
    await input.fill("第一行 First line");
    await input.press("Shift+Enter");
    const caret = await input.evaluate(element => {
      const style = getComputedStyle(element), paragraph = getComputedStyle(element.firstElementChild);
      return { color: style.color, caret: style.caretColor, font: style.fontSize, paragraphFont: paragraph.fontSize,
        line: style.lineHeight, paragraphLine: paragraph.lineHeight, text: element.innerText };
    });
    assert.equal(caret.caret, caret.color, "caret follows light/dark foreground after newline");
    assert.equal(caret.paragraphFont, caret.font, "empty line retains editor typography");
    assert.equal(caret.paragraphLine, caret.line);
    assert.ok(parseFloat(caret.line) <= parseFloat(caret.font) + 8, "caret line does not stretch to editor height");
    await input.fill("保留这份草稿 Keep this draft");
    samples.push({ ...sample, measured });
    await page.locator(".design-preview").evaluate(element => element.scrollTo(0, 0));
    await page.screenshot({ path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}.png`), fullPage: true, animations: "disabled" });
    for (const name of ["Composer 预览", "审批预览", "Side 预览"]) {
      await page.getByRole("region", { name, exact: true }).screenshot({ path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}-${name}.png`), animations: "disabled" });
    }
    await longText.locator(".messages").evaluate(el => el.scrollTo(0, 0));
    await longText.screenshot({ path: join(scratch, `${sample.theme}-${sample.font}-${sample.width}-long-text.png`), animations: "disabled" });
  }
  checks.push("Base settings surfaces, typography, control alignment and container reflow at both themes and font sizes");
  checks.push("light/dark and wide/narrow production components; semantic typography and layout");
  checks.push("newline caret follows theme and editor typography at both font sizes");
  const motion = page.getByRole("region", { name: "聊天动效预览", exact: true });
  const stream = page.getByTestId("preview-stream");
  const waiting = motion.locator(".turn-thinking");
  await page.getByRole("checkbox", { name: "减少动态效果", exact: true }).uncheck();
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "false");
    await motion.getByRole("button", { name: "追加片段", exact: true }).click();
    await stream.locator("[data-sd-animate]").first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="preview-stream"] [data-sd-animate]')].every(element => getComputedStyle(element).opacity === "1"));
    const priorText = await stream.innerText();
    await motion.getByRole("button", { name: "追加片段", exact: true }).click();
    assert.ok((await stream.innerText()).startsWith(priorText), "append retains earlier Chinese text");
    const animation = await stream.locator("[data-sd-animate]").evaluateAll(elements => ({
      priorVisible: getComputedStyle(elements[0]).opacity === "1",
      lastDuration: parseFloat(getComputedStyle(elements.at(-1)).animationDuration),
      maxDelay: Math.max(...elements.map(element => parseFloat(getComputedStyle(element).animationDelay))),
    }));
    assert.equal(animation.priorVisible, true, "new chunks must not fade previously read text again");
    assert.ok(animation.lastDuration > 0, "new Chinese text fades in");
    assert.ok(animation.maxDelay <= 0.08, "burst text does not create a long typing queue");
    // 对真实文字逐段截图，捕获高光离开文字后出现的视觉停顿。
    const duration = await waiting.evaluate(element => {
      const animation = element.getAnimations()[0];
      animation.pause();
      return Number(animation.effect.getTiming().duration);
    });
    const sweep = [], frames = [];
    for (const fraction of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999999, 1]) {
      await waiting.evaluate((element, time) => { element.getAnimations()[0].currentTime = time; }, duration * fraction);
      const frame = await waiting.screenshot({ animations: "allow" });
      frames.push(frame.toString("base64"));
      sweep.push({ fraction, sha256: createHash("sha256").update(frame).digest("hex") });
    }
    for (let index = 1; index < 6; index++) assert.notEqual(sweep[index].sha256, sweep[index - 1].sha256, "waiting highlight remains visibly moving throughout the cycle");
    const seamDifference = await page.evaluate(async ({ first, last }) => {
      const pixels = async source => {
        const image = new Image();
        image.src = `data:image/png;base64,${source}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const a = await pixels(first), b = await pixels(last);
      return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
    }, { first: frames[0], last: frames[6] });
    // 背景定位的小数舍入可影响抗锯齿，允许每通道不足一个色阶的平均差异。
    assert.ok(seamDifference < 1, `waiting sweep has no visible seam: ${seamDifference}`);
    assert.equal(sweep[0].sha256, sweep[7].sha256, "waiting highlight repeats at the same phase");
    await waiting.evaluate(element => element.getAnimations()[0].play());
    await motion.screenshot({ path: join(scratch, `${theme}-chat-motion.png`), animations: "disabled" });
    samples.push({ theme, animation, sweep, seamDifference });
  }
  checks.push("Chinese streaming append preserves earlier text, bounds fade delay, and uses a continuous themed waiting sweep");
  await motion.getByRole("button", { name: "完成输出", exact: true }).click();
  assert.equal(await stream.locator("[data-sd-animate]").count(), 0, "completed Markdown has no streaming animation wrappers");
  assert.ok((await stream.innerText()).includes("Streaming text stays readable"));
  assert.equal(await stream.locator("li").count(), 2);
  assert.equal(await stream.locator("strong").innerText(), "加粗");
  await page.getByRole("checkbox", { name: "减少动态效果", exact: true }).check();
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "true");
  assert.equal(await waiting.evaluate(element => element.getAnimations().length), 0);
  await motion.getByRole("button", { name: "播放流式输出", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-stream"]').textContent.includes("流式文字"));
  assert.equal(await stream.locator("[data-sd-animate]").count(), 0, "reduced motion shows streamed content immediately");
  checks.push("completed Markdown retains formatting; reduced motion disables streaming and waiting effects");
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
  const artifacts = await Promise.all((await readdir(scratch)).filter(name => name.endsWith(".png")).sort().map(async name => ({ path: name, sha256: createHash("sha256").update(await readFile(join(scratch, name))).digest("hex") })));
  const worktreeStatus = execFileSync("git", ["status", "--porcelain"], { cwd: gui }).toString();
  const diffSha256 = createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--"], { cwd: gui })).digest("hex");
  await writeFile(join(scratch, "manifest.json"), JSON.stringify({ passed, baseline, commit, buildSha256, worktreeStatus, diffSha256,
    environment: { platform: process.platform, arch: process.arch, browserVersion, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, artifacts, checks, errors, external, samples, scope: "production renderer components with local fixture actions; no Electron/Core acceptance" }, null, 2));
  console.log(JSON.stringify({ passed, scratch, checks, errors }));
}
