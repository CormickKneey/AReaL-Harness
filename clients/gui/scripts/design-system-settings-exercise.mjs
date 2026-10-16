import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// A bounded exercise in the existing renderer runner, not a second evidence service.
export async function runSettingsExercise(page, scratch, gui, report) {
  const { steps, checks } = report;
  Object.assign(report, { id: "settings-reflow", questionId: "Q-SETTINGS-REFLOW-01", inputBaseSnapshot: "269ab4ecd5aac8c12c50ebecfd88986d3bd82804", candidateVersion: JSON.parse(await readFile(join(gui, "design-system/registry.json"), "utf8")).baseCandidate.version, briefSha256: createHash("sha256").update(await readFile(join(gui, "design-system/exercises/settings-reflow.md"))).digest("hex"), steps, checks, scope: "exploratory production renderer composition; local fixture actions", gaps: ["not a blind or formal Base-freeze exercise", "reference and implementation use different window shells; compare measured component regions", "no Core/native/provider/package acceptance", "pixel difference is not a design-quality verdict"] });
  const region = page.getByRole("region", { name: "设置迁移题", exact: true });
  const group = region.locator(".settings-group-card");
  let previous = null;
  const frame = async (id, action, predicate, target = group) => {
    await target.scrollIntoViewIfNeeded();
    await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    const observation = await target.evaluate(element => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const measure = el => { const css = getComputedStyle(el); return { box: box(el), text: el.textContent, font: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight, color: css.color, background: css.backgroundColor, padding: css.padding, gap: css.gap, radius: css.borderRadius, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }; };
      const probe = document.createElement("span");
      probe.style.cssText = "position:fixed;visibility:hidden;height:var(--spacing-control);border-radius:var(--radius-navigation)";
      element.append(probe);
      const roles = { controlHeight: parseFloat(getComputedStyle(probe).height), controlRadius: getComputedStyle(probe).borderRadius };
      probe.remove();
      const r = element.getBoundingClientRect();
      let fullyVisible = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), p = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX) && (r.left < p.left - 1 || r.right > p.right + 1)) fullyVisible = false;
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY) && (r.top < p.top - 1 || r.bottom > p.bottom + 1)) fullyVisible = false;
      }
      return { target: measure(element), roles, fullyVisible, formState: [...document.querySelector('[aria-label="设置迁移题"]').querySelectorAll('button[aria-label]')].map(control => ({ label: control.getAttribute("aria-label"), value: control.textContent, checked: control.getAttribute("aria-checked"), disabled: control.disabled, focused: control === document.activeElement })), rows: [...element.querySelectorAll(".settings-field-layout")].map(row => ({ row: measure(row), label: measure(row.firstElementChild), labelParts: [...row.firstElementChild.children].map(measure), control: measure(row.querySelector(".settings-field-control")), button: measure(row.querySelector(".settings-field-control button")) })), conditions: { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, theme: document.documentElement.classList.contains("dark") ? "dark" : "light", fontSize: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim(), reducedMotion: document.documentElement.dataset.reducedMotion, content: document.querySelector('[aria-label="设置迁移题"]').getAttribute("data-case") } };
    });
    const path = `${id}.png`;
    await target.screenshot({ path: join(scratch, path), animations: "disabled" });
    await writeFile(join(scratch, `${id}.json`), JSON.stringify(observation, null, 2));
    steps.push({ id, questionId: "Q-SETTINGS-REFLOW-01", from: previous, action, readiness: predicate, observedAt: new Date().toISOString(), observation: `${id}.json`, screenshot: { path, status: observation.fullyVisible ? "captured" : "partial", limitation: observation.fullyVisible ? null : "target exceeds viewport or a clipping ancestor; not accepted as a complete frame" }, network: { status: "not_requested", reason: "layout/fixture question has no service claim" } });
    await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
    previous = id;
    return observation;
  };
  for (const sample of [
    { id: "matched-wide", theme: "dark", font: "14", width: "wide", viewport: 1440, content: "reference", stacked: false, reduced: false },
    { id: "matched-compact", theme: "dark", font: "14", width: "wide", viewport: 656, content: "reference", stacked: true, reduced: false },
    { id: "stress-light", theme: "light", font: "18", width: "narrow", viewport: 1440, content: "stress", stacked: true, reduced: true },
    { id: "stress-dark", theme: "dark", font: "18", width: "narrow", viewport: 1440, content: "stress", stacked: true, reduced: true },
  ]) {
    await page.setViewportSize({ width: sample.viewport, height: 949 });
    await page.getByLabel("主题", { exact: true }).selectOption(sample.theme);
    await page.getByLabel("字号", { exact: true }).selectOption(sample.font);
    await page.getByLabel("面板宽度", { exact: true }).selectOption(sample.width);
    await page.getByLabel("题目内容", { exact: true }).selectOption(sample.content);
    await page.getByLabel("减少动态效果", { exact: true }).setChecked(sample.reduced);
    await page.waitForFunction(({ font, reduced, theme }) => getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() === `${font}px` && document.documentElement.dataset.reducedMotion === String(reduced) && document.documentElement.classList.contains("dark") === (theme === "dark"), sample);
    const measured = await frame(sample.id, `set theme=${sample.theme}, font=${sample.font}, panel=${sample.width}, content=${sample.content}, viewport=${sample.viewport}, reducedMotion=${sample.reduced}`, "five settings rows and requested appearance resolved");
    assert.equal(measured.rows.length, 5);
    for (const index of [0, 4]) {
      assert.equal(measured.rows[index].button.box.height, measured.roles.controlHeight, "settings single choice uses the public control size");
      assert.equal(measured.rows[index].button.radius, measured.roles.controlRadius, "settings single choice uses the navigation radius role");
    }
    for (const index of [1, 2, 3]) {
      assert.equal(measured.rows[index].button.box.width, 32, "settings use the observed/default switch width");
      assert.equal(measured.rows[index].button.box.height, 20, "settings use the observed/default switch height");
    }
    const edge = sample.stacked ? "x" : "right";
    const aligned = measured.rows.map(row => edge === "x" ? row.control.box.x : row.control.box.x + row.control.box.width);
    assert.ok(Math.max(...aligned) - Math.min(...aligned) <= 1, "shared settings control edge is aligned");
    for (const row of measured.rows) {
      assert.ok(row.label.scrollWidth <= row.label.clientWidth + 1, "full label and description wrap within their column");
      assert.ok(row.control.box.x >= measured.target.box.x && row.control.box.x + row.control.box.width <= measured.target.box.x + measured.target.box.width + 1, "controls stay inside the group");
      if (sample.stacked) assert.ok(row.control.box.y >= row.label.box.y + row.label.box.height, "narrow controls follow the complete description");
      else assert.ok(row.control.box.x >= row.label.box.x + row.label.box.width, "wide controls remain alongside labels");
    }
    if (!measured.fullyVisible) {
      // Preserve the partial original and capture every row separately.
      for (let index = 0; index < 5; index++) {
        const row = await frame(`${sample.id}-row-${index + 1}`, "scroll this existing row into view", "complete row inside viewport", region.locator(".settings-field-row").nth(index));
        assert.equal(row.fullyVisible, true, "row evidence must not be clipped");
      }
    }
    checks.push(`${sample.id}: public control roles, complete wrapping, reachability and ${sample.stacked ? "stacked left" : "inline right"} alignment`);
  }
  await page.getByLabel("题目内容", { exact: true }).selectOption("reference");
  await page.getByLabel("字号", { exact: true }).selectOption("14");
  await page.getByLabel("面板宽度", { exact: true }).selectOption("wide");
  const completion = region.getByLabel("Turn completion notifications", { exact: true });
  const permission = region.getByRole("switch", { name: "Enable permission notifications", exact: true });
  await frame("before-menu", "restore fixed reference content; initial values", "Only when unfocused; permissions enabled");
  assert.ok((await completion.innerText()).includes("Only when unfocused"));
  await completion.click();
  await page.getByRole("option", { name: "Always", exact: true }).waitFor();
  await frame("menu-open", "click completion choice", "Always option visible", page.getByRole("listbox"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Turn completion notifications");
  assert.ok((await completion.innerText()).includes("Only when unfocused"));
  await frame("menu-dismissed", "press Escape", "menu closed; original value and trigger focus retained");
  await completion.click();
  await page.getByRole("option", { name: "Always", exact: true }).click();
  assert.ok((await completion.innerText()).includes("Always"));
  await permission.focus(); await page.keyboard.press("Space");
  assert.equal(await permission.getAttribute("aria-checked"), "false");
  await frame("values-updated", "select Always; focus permission switch and press Space", "Always visible; permission aria-checked=false");
  await page.getByLabel("字号", { exact: true }).selectOption("18");
  await page.getByLabel("面板宽度", { exact: true }).selectOption("narrow");
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() === "18px" && !document.documentElement.classList.contains("dark"));
  assert.ok((await completion.innerText()).includes("Always"));
  assert.equal(await permission.getAttribute("aria-checked"), "false");
  await frame("values-retained-after-reflow", "change font to18, panel to narrow and theme to light", "Always and permission=false retained after layout changes");
  checks.push("explicit choice updates value; Escape retains value/focus; Space toggles switch; appearance reflow retains values");
  for (const state of ["busy", "failed", "unknown"]) {
    await page.getByLabel("状态", { exact: true }).selectOption(state);
    const feedback = region.getByRole(state === "failed" ? "alert" : "status");
    await feedback.waitFor();
    assert.equal(await completion.isDisabled(), state !== "failed");
    assert.equal(await permission.isDisabled(), state !== "failed");
    assert.ok((await completion.innerText()).includes("Always"));
    assert.equal(await permission.getAttribute("aria-checked"), "false");
    await frame(`state-${state}`, `set fixture state=${state}`, "feedback visible and selected values retained", feedback);
  }
  assert.equal(await region.getByRole("button", { name: "Unavailable preview action" }).isDisabled(), true);
  checks.push("busy/failed/unknown feedback and disabled action preserve local values");
  await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
  return report;
}

export async function runSettingsContrast(page, scratch, gui, report) {
  Object.assign(report, { id: "settings-contrast", questionId: "Q-SETTINGS-TEXT-CONTRAST-02", inputBaseSnapshot: "ad04a0c21df22a6336e09ba2e2fb0b116886b73f", candidateVersion: JSON.parse(await readFile(join(gui, "design-system/registry.json"), "utf8")).baseCandidate.version, briefSha256: createHash("sha256").update(await readFile(join(gui, "design-system/exercises/settings-contrast.md"))).digest("hex"), scope: "independent renderer palette samples through saved-preference normalization", errors: [], gaps: ["reference and implementation contrast mappings intentionally differ", "no universal contrast/readability claim for arbitrary palettes", "no native/Core/provider/package acceptance"] });
  const samples = [
    { id: "dark-default", dark: true, contrast: 60, background: "#181818", foreground: "#ffffff", expected: 65 },
    { id: "dark-low", dark: true, contrast: 0, background: "#181818", foreground: "#ffffff", expected: 56 },
    { id: "dark-high", dark: true, contrast: 100, background: "#181818", foreground: "#ffffff", expected: 71 },
    { id: "dark-custom", dark: true, contrast: 60, background: "#142030", foreground: "#dae5f5", expected: 65 },
    { id: "light-default", dark: false, contrast: 45, background: "#ffffff", foreground: "#1a1c1f", expected: 69.5 },
    { id: "light-low", dark: false, contrast: 0, background: "#ffffff", foreground: "#1a1c1f", expected: 62.75 },
    { id: "light-high", dark: false, contrast: 100, background: "#ffffff", foreground: "#1a1c1f", expected: 77.75 },
    { id: "light-custom", dark: false, contrast: 45, background: "#f2f6fb", foreground: "#203040", expected: 69.5 },
  ];
  for (const sample of samples) {
    const scenario = await page.context().newPage();
    scenario.on("pageerror", error => report.errors.push(error.message));
    try {
      const prefs = { [sample.dark ? "dark" : "light"]: { contrast: sample.contrast, background: sample.background, foreground: sample.foreground } };
      await scenario.addInitScript(settings => localStorage.setItem("areal-gui:application-preferences", JSON.stringify(settings)), prefs);
      await scenario.goto(page.url());
      await scenario.getByRole("heading", { name: "客户端设计系统", exact: true }).waitFor();
      await scenario.getByLabel("主题", { exact: true }).selectOption(sample.dark ? "dark" : "light");
      await scenario.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, sample.dark);
      const group = scenario.getByRole("region", { name: "设置迁移题", exact: true }).locator(".settings-group-card");
      await group.scrollIntoViewIfNeeded();
      const observed = await group.evaluate((element, input) => {
        const description = element.querySelector(".settings-field-description"), css = getComputedStyle(description);
        const probe = document.createElement("span");
        probe.style.color = `color-mix(in srgb, ${input.foreground} ${input.expected}%, ${input.dark ? "transparent" : input.background})`;
        element.append(probe); const expectedColor = getComputedStyle(probe).color; probe.remove();
        const r = element.getBoundingClientRect();
        let fullyVisible = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const p = parent.getBoundingClientRect(), c = getComputedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(c.overflowX) && (r.left < p.left - 1 || r.right > p.right + 1)) fullyVisible = false;
          if (/(auto|scroll|hidden|clip)/.test(c.overflowY) && (r.top < p.top - 1 || r.bottom > p.bottom + 1)) fullyVisible = false;
        }
        return { fullyVisible, actualColor: css.color, expectedColor, fontSize: css.fontSize, background: getComputedStyle(element).backgroundColor, role: getComputedStyle(document.documentElement).getPropertyValue("--color-settings-secondary").trim(), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, box: { x: r.x, y: r.y, width: r.width, height: r.height }, disabledOpacity: getComputedStyle(document.querySelector('[aria-label="设置迁移题"] button:disabled')).opacity, desktopBridgePresent: typeof window.arealDesktop !== "undefined" };
      }, sample);
      const path = `${sample.id}.png`;
      await group.screenshot({ path: join(scratch, path), animations: "disabled" });
      await writeFile(join(scratch, `${sample.id}.json`), JSON.stringify({ input: sample, prefs, observed }, null, 2));
      report.steps.push({ id: sample.id, questionId: report.questionId, independentSample: true, action: "new renderer page with explicit saved-preference fixture; select theme", readiness: "fixed settings rows mounted with selected theme", observedAt: new Date().toISOString(), observation: `${sample.id}.json`, screenshot: { path, status: observed.fullyVisible ? "captured" : "partial" }, network: { status: "not_requested", reason: "palette rendering has no service claim" } });
      await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
      assert.equal(observed.fullyVisible, true, "palette sample group must be completely visible");
      assert.equal(observed.actualColor, observed.expectedColor, `${sample.id}: settings explanation follows the agreed role and user palette`);
      // Mounted workbench baseline at ad04a0c2 is0.45 (workbench.css), not the bare Button utility0.5.
      assert.equal(observed.disabledOpacity, "0.45", "mounted disabled controls retain their separate appearance");
      assert.equal(observed.desktopBridgePresent, false);
      report.checks.push(`${sample.id}: normalized preference → rendered settings role; disabled state unchanged`);
    } catch (error) {
      await scenario.screenshot({ path: join(scratch, `${sample.id}-failure.png`) }).catch(() => {});
      throw error;
    } finally {
      await scenario.close();
    }
  }
  assert.deepEqual(report.errors, []);
  await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
}
