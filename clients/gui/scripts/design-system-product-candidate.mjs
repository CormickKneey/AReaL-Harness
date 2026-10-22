import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runProductCandidate(page, scratch, report) {
  const shell = page.getByTestId("product-candidate");
  const input = page.getByTestId("candidate-input");
  const execution = () => shell.getAttribute("data-execution");
  const waitForState = state => page.waitForFunction(value => document.querySelector('[data-testid="product-candidate"]')?.dataset.execution === value, state);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const frames = [];
  const tabTo = async target => {
    for (let index = 0; index < 35; index++) {
      await page.keyboard.press("Tab");
      if (await target.evaluate(el => el === document.activeElement)) return;
    }
    throw new Error("The named control was not reachable by Tab.");
  };
  const capture = async id => {
    await settle();
    const facts = await shell.evaluate(el => {
      const visible = node => node.getClientRects().length && !node.closest('[hidden], [inert]');
      const controls = [...el.querySelectorAll('button, [role="tab"], [contenteditable="true"]')].filter(visible).map(node => {
        const rect = node.getBoundingClientRect();
        return { label: node.getAttribute("aria-label") || node.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, disabled: node.disabled || false };
      });
      return {
        viewport: [innerWidth, innerHeight], execution: el.dataset.execution, runId: el.dataset.runId,
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        uiFont: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim(),
        contentFont: getComputedStyle(document.documentElement).getPropertyValue("--content-font-size").trim(),
        actualUI: getComputedStyle(el.querySelector(".candidate-heading h1")).fontSize,
        actualContent: el.querySelector(".assistant-message") ? getComputedStyle(el.querySelector(".assistant-message")).fontSize : null,
        reducedMotion: document.documentElement.dataset.reducedMotion,
        draft: el.querySelector('[data-testid="candidate-input"]').textContent,
        pageOverflow: Math.max(document.documentElement.scrollWidth, el.scrollWidth) - innerWidth,
        workspaceRight: el.querySelector('.candidate-workspace').getBoundingClientRect().right,
        navigationOpen: el.dataset.navigation === "true",
        controls,
      };
    });
    assert.ok(facts.pageOverflow <= 1, `${id} has no page overflow`);
    if (!facts.navigationOpen) assert.ok(Math.abs(facts.workspaceRight - facts.viewport[0]) <= 1, `${id} workspace fills the available width`);
    for (const control of facts.controls) {
      assert.ok(control.left >= -1 && control.right <= facts.viewport[0] + 1, `${id}: ${control.label} stays horizontally reachable`);
    }
    await page.screenshot({ path: join(scratch, `${id}.png`), fullPage: false, animations: "disabled" });
    await writeFile(join(scratch, `${id}.aria.txt`), await shell.ariaSnapshot());
    frames.push({ id, facts });
    await writeFile(join(scratch, "product-candidate-states.json"), JSON.stringify(frames, null, 2));
    return facts;
  };
  const draft = async text => { await input.click(); await input.press("Meta+A"); await page.keyboard.insertText(text); };
  const send = async text => { await draft(text); await page.getByRole("button", { name: "发送需求", exact: true }).click(); };
  const menu = async () => page.getByRole("button", { name: "本地演示", exact: true }).click();
  const scenario = async label => { await menu(); await page.getByRole("menuitemradio", { name: label, exact: true }).click(); };
  const reset = async () => { await menu(); await page.getByRole("menuitem", { name: "重置演示", exact: true }).click(); await waitForState("idle"); };
  const openSettings = async () => page.getByRole("button", { name: "打开设置", exact: true }).click();
  const setChoice = async (label, value) => page.getByRole("tablist", { name: label, exact: true }).getByRole("tab", { name: value, exact: true }).click();
  const backSettings = () => page.getByRole("button", { name: "返回上一工作区", exact: true }).click();
  assert.equal(await page.locator(".design-preview-header").count(), 0);
  assert.equal(await page.evaluate(() => typeof window.arealDesktop), "undefined");
  await page.setViewportSize({ width: 1440, height: 960 });
  await capture("candidate-01-empty");
  await page.getByRole("button", { name: "使用示例需求", exact: true }).click();
  assert.match(await input.innerText(), /快速开始/);
  const custom = "请为示例项目补充快速开始指南，说明安装、启动和第一个任务，并提醒读者检查运行结果。";
  await send(custom);
  await waitForState("running");
  assert.equal((await input.innerText()).trim(), "");
  const firstRun = await shell.getAttribute("data-run-id");
  const nextDraft = "下一条草稿：补充常见问题。\n保留这段尚未发送的想法。";
  await draft(nextDraft);
  assert.equal(await page.getByRole("button", { name: "发送需求", exact: true }).isDisabled(), true);
  await waitForState("awaiting-approval");
  assert.equal(await shell.locator('[data-latest-turn="true"]').getAttribute("data-turn-status"), "inProgress");
  assert.equal(await shell.getByTestId("candidate-deliverable").count(), 0);
  await page.getByText("查看拟写内容", { exact: true }).click();
  await shell.locator('.candidate-proposal-content').getByRole('heading', { name: '核对结果', exact: true }).waitFor();
  await capture("candidate-02a-proposal");
  await page.getByText("查看拟写内容", { exact: true }).click();
  await capture("candidate-02-approval");
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  await waitForState("acknowledged");
  await page.getByText("已提交，等待执行状态更新。", { exact: true }).waitFor();
  assert.equal(await shell.getByTestId("candidate-deliverable").count(), 0);
  await capture("candidate-03-acknowledged");
  await waitForState("completed");
  assert.equal(await input.innerText(), nextDraft);
  await capture("candidate-04-completed");
  const opener = page.getByTestId("candidate-deliverable");
  const chat = shell.locator(".messages");
  await page.setViewportSize({ width: 420, height: 620 });
  await chat.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight; });
  const beforeTargetIntoView = await chat.evaluate(el => el.scrollTop);
  await opener.scrollIntoViewIfNeeded();
  await settle();
  const chatScroll = await chat.evaluate(el => el.scrollTop);
  assert.ok(chatScroll > 0, "the actual conversation has a nonzero reading position before return");
  await opener.click();
  await page.getByRole("heading", { name: "快速开始.md", exact: true }).waitFor();
  const reader = page.getByTestId("candidate-reader");
  await reader.evaluate(el => { el.scrollTop = 110; });
  const resourceScroll = await reader.evaluate(el => el.scrollTop);
  await openSettings();
  await backSettings();
  await settle();
  assert.equal(await reader.evaluate(el => el.scrollTop), resourceScroll);
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await settle();
  assert.equal(await input.innerText(), nextDraft);
  assert.equal(await opener.evaluate(el => el === document.activeElement), true);
  assert.equal(await chat.evaluate(el => el.scrollTop), chatScroll);
  report.reading = { beforeTargetIntoView, departure: chatScroll, returned: await chat.evaluate(el => el.scrollTop) };
  await opener.click();
  await openSettings();
  await setChoice("外观", "深色");
  await setChoice("界面字号", "18");
  await setChoice("内容字号", "18");
  await page.getByRole("switch", { name: "减少动态效果", exact: true }).click();
  const changed = await capture("candidate-05-settings-dark18");
  assert.equal(changed.theme, "dark");
  assert.equal(changed.uiFont, "18px");
  assert.equal(changed.contentFont, "18px");
  assert.equal(changed.actualUI, "18px");
  assert.equal(changed.actualContent, "18px");
  assert.equal(changed.reducedMotion, "true");
  assert.equal(await shell.getByTestId("candidate-motion-sample").evaluate(el => getComputedStyle(el).transitionDuration), "0s");
  await backSettings();
  await settle();
  assert.ok(await reader.evaluate(el => el.scrollTop) > 0);
  assert.equal(await page.getByRole("button", { name: "打开设置", exact: true }).evaluate(el => el === document.activeElement), true);
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await settle();
  assert.equal(await input.innerText(), nextDraft);
  assert.equal(await opener.evaluate(el => el === document.activeElement), true);
  report.checks.push("Chinese submission, editable next draft, separate approval acknowledgement/result, nested resource/settings return, reading position and opener focus are preserved by the real mounted components.");
  for (const sample of [
    { width: 1440, height: 960, theme: "明亮", font: "14", id: "wide-light14" },
    { width: 1024, height: 900, theme: "深色", font: "14", id: "medium-dark14" },
    { width: 420, height: 900, theme: "明亮", font: "18", id: "narrow-light18" },
    { width: 420, height: 900, theme: "深色", font: "18", id: "narrow-dark18" },
  ]) {
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await openSettings(); await setChoice("外观", sample.theme); await setChoice("界面字号", sample.font); await setChoice("内容字号", sample.font);
    await capture(`candidate-settings-${sample.id}`); await backSettings();
    const chatFacts = await capture(`candidate-chat-${sample.id}`);
    const contrast = await page.getByRole('button', { name: '发送需求', exact: true }).evaluate(el => ({ background: getComputedStyle(el).backgroundColor, icon: getComputedStyle(el.querySelector('svg')).color }));
    assert.notEqual(contrast.background, contrast.icon, `${sample.id} send icon differs from its button background`);
    assert.equal(chatFacts.actualContent, `${sample.font}px`);
    assert.equal(chatFacts.actualUI, `${sample.font}px`);
    await opener.click(); await capture(`candidate-reader-${sample.id}`);
    if (sample.width === 420) {
      assert.equal(await input.isVisible(), false);
      assert.equal(await shell.locator('.candidate-conversation').getAttribute("inert"), "");
    }
    await page.getByRole("button", { name: "返回对话", exact: true }).click();
    if (sample.width === 420) {
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await page.getByRole("navigation", { name: "项目与任务", exact: true }).waitFor();
      await capture(`candidate-navigation-${sample.id}`);
      await page.getByRole("button", { name: "关闭导航", exact: true }).click();
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await reset();
  await send("这次不允许写入文件。"); await waitForState("awaiting-approval");
  await page.getByRole("button", { name: "拒绝", exact: true }).focus(); await page.keyboard.press("Escape");
  await waitForState("denied"); assert.equal(await shell.getByTestId("candidate-deliverable").count(), 0);
  await capture("candidate-06-denied-keyboard");
  await reset(); await send("用键盘批准这次演示。"); await waitForState("awaiting-approval");
  await input.click();
  await tabTo(page.getByRole("button", { name: "允许一次", exact: true }));
  await page.keyboard.press("Enter");
  await waitForState("completed");
  await reset(); await send("使用鼠标拒绝这次演示。"); await waitForState("awaiting-approval");
  await page.getByRole("button", { name: "拒绝", exact: true }).click(); await waitForState("denied");
  await scenario("明确失败"); await send("演示明确失败后安全开始新尝试。");
  await waitForState("failed");
  assert.equal(await shell.locator('[data-latest-turn="true"]').getAttribute("data-turn-status"), "failed");
  const failedRun = await shell.getAttribute("data-run-id");
  await page.getByText("示例目录为只读，写入尚未开始。可编辑需求，再开始一次新的演示。", { exact: true }).waitFor();
  await capture("candidate-07-known-failure");
  await scenario("正常路径"); await send("开始一次新的演示尝试。"); await waitForState("running");
  assert.notEqual(await shell.getAttribute("data-run-id"), failedRun);
  assert.notEqual(await shell.getAttribute("data-run-id"), firstRun);
  await reset(); await page.waitForTimeout(1700); assert.equal(await execution(), "idle");
  assert.equal(await shell.getByTestId("candidate-deliverable").count(), 0);
  await scenario("结果未知"); await send("演示结果待核对时不要重复写入。"); await waitForState("awaiting-approval");
  await page.getByRole("button", { name: "允许一次", exact: true }).click(); await waitForState("unknown");
  const unknownRun = await shell.getAttribute("data-run-id");
  assert.equal(await shell.locator('[data-latest-turn="true"]').getAttribute("data-turn-status"), "inProgress");
  await draft("未知结果期间仍然保留下一条草稿。");
  await page.waitForTimeout(1800); assert.equal(await execution(), "unknown");
  assert.equal(await shell.getAttribute("data-run-id"), unknownRun);
  assert.equal(await page.getByRole("button", { name: "发送需求", exact: true }).isDisabled(), true);
  assert.equal(await shell.getByTestId("candidate-deliverable").count(), 0);
  await capture("candidate-08-unknown");
  await page.getByRole("button", { name: "核对演示结果", exact: true }).click(); await waitForState("completed");
  assert.equal(await shell.getAttribute("data-run-id"), unknownRun);
  assert.equal(await input.innerText(), "未知结果期间仍然保留下一条草稿。");
  await capture("candidate-09-reconciled");
  report.steps.push(...frames);
  report.checks.push("Mouse and keyboard decisions terminate correctly; known failure allows a uniquely identified new attempt; unknown holds without replay until an explicit local result check; reset cancels stale progress.");
  report.checks.push("Full viewport evidence covers 1440×960 light14, 1024×900 dark14, and 420×900 light18/dark18 with real in-memory theme/type/motion settings and reachable navigation. This is a local candidate, not Core acceptance.");
}
