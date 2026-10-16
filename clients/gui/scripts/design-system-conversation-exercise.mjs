import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export async function runConversationExercise(page, scratch, gui, report) {
  Object.assign(report, { id: "conversation-flow", questionId: "Q-CONVERSATION-DYNAMIC-05", inputSnapshot: "de0033be", candidateVersion: JSON.parse(await readFile(join(gui, "design-system/registry.json"), "utf8")).baseCandidate.version, briefSha256: createHash("sha256").update(await readFile(join(gui, "design-system/surfaces/conversation-flow.json"))).digest("hex"), gaps: ["synthetic projection, no Core or real commands", "not blind, no whole-window Codex fidelity", "no Electron/native/provider/package acceptance"], events: [] });
  const region = page.getByRole("region", { name: "动态信息流题", exact: true });
  const messages = region.locator(".messages");
  const latest = () => messages.locator('[data-latest-turn="true"]');
  const tool = () => latest().locator('[data-tool-id="flow-command"]');
  const next = () => region.getByRole("button", { name: "下一事件", exact: true }).click();
  const snapshot = async (id, action) => {
    const metrics = await messages.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, full: el.scrollHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop, width: el.clientWidth, contentFont: getComputedStyle(el.querySelector(".assistant-message")).fontSize, theme: document.documentElement.classList.contains("dark") ? "dark" : "light", reducedMotion: document.documentElement.dataset.reducedMotion, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, now: performance.now(), running: !!el.querySelector('[data-latest-turn=true][data-turn-status=inProgress]'), text: el.querySelector('[data-side-item-id="flow-final"]')?.textContent?.length ?? 0 }));
    await region.screenshot({ path: join(scratch, `${id}.png`), animations: "disabled" });
    report.events.push({ id, action, hostTime: Date.now(), metrics });
    const coverage = await region.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth ? "captured" : "partial"; });
    report.steps.push({ id, action, screenshot: { path: `${id}.png`, status: coverage }, metrics });
    await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
    return metrics;
  };
  const accepted = async () => {
    await region.getByTestId("flow-composer").fill("验证工具、长回复和历史阅读，不操作真实工作区。");
    await region.getByRole("button", { name: "发送", exact: true }).click();
    await latest().locator('[data-tool-id="flow-command"]').waitFor();
    assert.equal(await messages.locator('[data-turn-status=inProgress]').count(), 1);
  };
  const reset = async () => { await region.getByRole("button", { name: "重置题目", exact: true }).click(); await region.getByTestId("flow-composer").waitFor(); };
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await accepted();
  assert.ok(await messages.locator(".message-response-space").evaluate(el => el.clientHeight > 0), "accepted follow-up uses production response space");
  await snapshot("01-accepted", "submit via production composer; tool running");
  await tool().locator(".tool-summary-row").click();
  await tool().getByLabel("执行命令", { exact: true }).waitFor();
  await tool().getByRole("button", { name: "展开完整命令", exact: true }).click();
  await next();
  assert.equal(await tool().getByRole("button", { name: "收起完整命令", exact: true }).count(), 1, "same command keeps manual inner disclosure when activity grows");
  assert.ok((await tool().getByLabel("工具结果", { exact: true }).innerText()).includes("Apples: 16"));
  await next();
  await latest().locator('[data-side-item-id="flow-final"]').waitFor();
  await snapshot("02-streaming", "tool result + new activity + final text starts");
  const visibleOldParagraph = () => {
    const el = document.querySelector('#conversation-flow-exercise .messages'), box = el.getBoundingClientRect();
    return [...el.querySelectorAll('[data-side-item-id="flow-history"] p')].some(p => { const r = p.getBoundingClientRect(); return r.top > box.top + 10 && r.bottom < box.bottom - 10; });
  };
  await messages.hover({ position: { x: 40, y: 40 } });
  for (let i = 0; i < 8 && !await page.evaluate(visibleOldParagraph); i++) {
    const before = await messages.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(top => document.querySelector('#conversation-flow-exercise .messages').scrollTop < top - 1, before);
  }
  assert.equal(await page.evaluate(visibleOldParagraph), true, "wheel reaches a visible old paragraph");
  await region.getByRole("button", { name: "滚动到底部", exact: true }).waitFor();
  const anchor = await messages.evaluate(el => {
    const box = el.getBoundingClientRect();
    const p = [...el.querySelectorAll('[data-side-item-id="flow-history"] p')].find(p => { const r = p.getBoundingClientRect(); return r.top > box.top + 10 && r.bottom < box.bottom - 10; });
    if (!p) throw Error("no visible old paragraph");
    return { text: p.textContent, top: p.getBoundingClientRect().top - box.top };
  });
  const history = [];
  for (let i = 0; i < 2; i++) {
    await next();
    const sample = await snapshot(`03-history-${i}`, "append while reading history");
    const position = await messages.evaluate((el, text) => { const p = [...el.querySelectorAll('[data-side-item-id="flow-history"] p')].find(p => p.textContent === text); return p.getBoundingClientRect().top - el.getBoundingClientRect().top; }, anchor.text);
    assert.ok(Math.abs(position - anchor.top) <= 2, "visible old paragraph remains anchored while text grows");
    assert.equal(sample.running, true); history.push({ ...sample, anchorTop: position, anchorText: anchor.text });
  }
  assert.ok(history[1].text > history[0].text);
  report.events.push({ id: "history-anchor", samples: history });
  await region.getByRole("button", { name: "滚动到底部", exact: true }).click();
  await page.waitForFunction(() => { const e = document.querySelector('#conversation-flow-exercise .messages'); return e.scrollHeight - e.clientHeight - e.scrollTop <= 2; });
  const following = [];
  for (let i = 0; i < 2; i++) { await next(); await page.waitForFunction(() => { const e = document.querySelector('#conversation-flow-exercise .messages'); return e.scrollHeight - e.clientHeight - e.scrollTop <= 2; }); following.push(await snapshot(`04-following-${i}`, "append after actual bottom arrival")); }
  assert.ok(following[1].text > following[0].text); assert.ok(following.every(s => s.running && s.gap <= 2));
  await region.getByRole("button", { name: "投影完成", exact: true }).click();
  await latest().locator('.turn-progress-body[hidden]').waitFor({ state: "attached" });
  assert.equal(await latest().locator('.assistant-message-final').isVisible(), true);
  assert.equal(await latest().locator('.turn-progress-body .assistant-message-final').count(), 0);
  await latest().getByRole("button", { name: "用时 12秒", exact: true }).focus();
  await snapshot("05-completed-collapsed", "keyboard focus reaches completed aggregate; final remains outside");
  await latest().getByRole("button", { name: "用时 12秒", exact: true }).click();
  const activity = latest().getByRole("button", { name: "执行过程", exact: true });
  if (await activity.count() && await activity.getAttribute("aria-expanded") === "false") await activity.click();
  assert.equal(await tool().getByRole("button", { name: "收起完整命令", exact: true }).isVisible(), true, "completed parent reveals the same manually expanded command");
  await latest().getByRole("button", { name: "用时 12秒", exact: true }).click();
  await latest().getByRole("button", { name: "用时 12秒", exact: true }).click();
  assert.equal(await tool().getByRole("button", { name: "收起完整命令", exact: true }).isVisible(), true);
  await snapshot("05-completed-expanded", "complete; reopen parent twice; command selection retained");
  report.checks.push("accepted response reservation; actual streaming growth preserves visible history anchor; explicit latest resumes following; same command details survive parent completion and reopening");
  await reset(); await accepted(); await next(); await next();
  await region.getByRole("button", { name: "投影完成", exact: true }).click();
  await latest().locator('.turn-progress-body[hidden]').waitFor({ state: "attached" });
  await latest().getByRole("button", { name: "用时 12秒", exact: true }).click();
  assert.equal(await tool().locator('.tool-summary-row').first().getAttribute('aria-expanded'), 'false', "new run does not inherit a previous manual disclosure");
  await snapshot("06-default-completed", "independent run, untouched default disclosure");
  for (const scenario of ["失败", "未知", "未结算"]) {
    await region.getByRole("button", { name: `${scenario}反例`, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-tool-id="flow-command"]')?.dataset.toolStatus !== '已完成');
    assert.equal(await latest().locator('.turn-progress-body').isVisible(), true, "exception details remain discoverable");
    const expected = scenario === "失败" ? "失败" : "结果待确认";
    assert.equal(await tool().getAttribute("data-tool-status"), expected);
    await tool().locator(".tool-summary-row").first().scrollIntoViewIfNeeded();
    await snapshot(`07-${scenario}`, `independent ${scenario} terminal projection with final`);
  }
  await region.getByRole("button", { name: "未知反例", exact: true }).click();
  await region.getByRole("button", { name: "核查 UNKNOWN", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "刷新原记录", exact: true }).click();
  await page.getByText(/刷新失败，仍显示上次记录/).waitFor();
  await page.getByRole("button", { name: "取消核查", exact: true }).click();
  assert.equal(await region.getByLabel("本地调用记录", { exact: true }).innerText(), "open", "unknown refresh performs only the original read, never a new submission");
  assert.equal(await tool().getAttribute("data-tool-status"), "结果待确认");
  report.checks.push("independent defaults and failed/unknown/unsettled counterexamples; read failure preserves unknown without resubmission");
  for (const [theme, font, width, reduced] of [["light", "14", "wide", true], ["dark", "18", "narrow", true], ["dark", "14", "wide", false]]) {
    await reset(); await page.getByLabel("主题", { exact: true }).selectOption(theme); await page.getByLabel("字号", { exact: true }).selectOption(font); await page.getByLabel("面板宽度", { exact: true }).selectOption(width);
    await page.getByRole("checkbox", { name: "减少动态效果", exact: true }).setChecked(reduced);
    await page.waitForFunction(({ font, width, theme, reduced }) => {
      const e = document.querySelector('#conversation-flow-exercise .messages');
      return getComputedStyle(e.querySelector('.assistant-message')).fontSize === `${font}px` && (width === 'narrow' ? e.clientWidth < 400 : e.clientWidth > 700) && document.documentElement.classList.contains('dark') === (theme === 'dark') && document.documentElement.dataset.reducedMotion === String(reduced);
    }, { font, width, theme, reduced });
    await accepted(); await next(); await next(); await region.getByRole("button", { name: "投影完成", exact: true }).click();
    await latest().locator('.turn-progress-body[hidden]').waitFor({ state: "attached" });
    const overflow = await messages.evaluate(el => el.scrollWidth > el.clientWidth + 1); assert.equal(overflow, false);
    const parent = latest().getByRole("button", { name: "用时 12秒", exact: true }); await parent.focus(); await page.keyboard.press("Enter");
    assert.equal(await parent.getAttribute("aria-expanded"), "true");
    await snapshot(`08-${theme}-${font}-${width}-${reduced}`, "representative conditions, keyboard parent disclosure");
  }
  report.checks.push("light14 wide and dark18 narrow reduced-motion; dark14 wide motion; keyboard and no horizontal overflow");
  await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
}
