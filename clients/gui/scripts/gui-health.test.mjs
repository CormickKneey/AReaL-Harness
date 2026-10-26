import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./gui-health.mjs", import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "areal-health-test-"));
  const root = join(directory, "clients/gui");
  await mkdir(join(directory, "design"), { recursive: true });
  await writeFile(join(directory, "design/principles.md"), "# Principles\n");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (file, text) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  };
  await put("package.json", JSON.stringify({ scripts: { "test:one": "node one.mjs" } }));
  await put(
    "scripts/test-manifest.json",
    JSON.stringify([
      {
        script: "test:one",
        layer: "contract",
        platforms: ["darwin", "linux"],
        areas: ["health"],
        requires: [],
      },
    ]),
  );
  await put(
    "design-system/literal-baseline.json",
    JSON.stringify({ total: { color: 2, radius: 3, typography: 1 }, files: {} }),
  );
  await put("packages/ui/experimental-allowlist.json", "[]\n");
  await put(
    "design-system/accessibility-baseline.json",
    JSON.stringify({ moderateIssues: 0, contrastExceptions: [] }),
  );
  await put(
    "design-system/rule-registry.json",
    JSON.stringify({
      entryDocuments: [
        "clients/gui/packages/ui/README.md",
        "clients/gui/packages/ui/token-reference.md",
      ],
    }),
  );
  await put("packages/ui/README.md", "# UI\n");
  await put("packages/ui/token-reference.md", "# Tokens\n");
  await put("app/src/main.cjs", "module.exports = {};\n");
  await put("renderer/src/App.tsx", 'import { useState } from "react";\nuseState(1);\n');
  await put(
    "packages/ui/src/button.md",
    '---\nid: button\nlayer: core\nstatus: stable\nexports: ["Button"]\n---\n',
  );
  await put(
    "renderer/src/Consumer.tsx",
    'import { Button } from "@areal/ui";\nexport const view = <Button />;\n',
  );
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "--root", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, AREAL_DESIGN_BASE: "" },
    });
  return {
    root,
    put,
    run,
    baseline: async () => JSON.parse(await readFile(join(root, "health-baseline.json"), "utf8")),
  };
}

test("JSON report counts production code and keeps report-only counts separate", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/vendor/vendor.cjs", "x\n".repeat(1001));
  await f.put("renderer/src/generated/gen.tsx", "x\n".repeat(1001));
  await f.put("renderer/src/i18n/messages/en.ts", "x\n".repeat(1001));
  await f.put("renderer/src/design-system/preview.tsx", "x\n".repeat(1001));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.mainSourceLines, 1);
  assert.equal(report.metrics.appLines.value, 2);
  assert.equal(report.metrics.appHooks.value, 2);
  assert.equal(report.metrics.literalDebt.value, 6);
  assert.equal(report.metrics.uiAdoptionRatio.value, 0.5);
  assert.equal(report.counts.productionTsxFiles, 2);
  assert.deepEqual(report.largeFiles, {});
});

test("down and up metrics reject regression and write only improvements", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  await f.put("renderer/src/App.tsx", 'import { useState } from "react";\nuseState(1);\n\n');
  const failed = f.run("--check");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /appLines/);
  assert.match(failed.stderr, /down/);
  assert.notEqual(f.run("--write").status, 0);
  assert.equal((await f.baseline()).appLines.value, 2);
  assert.equal(f.run("--write", "--allow-regression=appLines").status, 0);
  await f.put("renderer/src/Consumer.tsx", "export const view = <div />;\n");
  const up = f.run("--check");
  assert.notEqual(up.status, 0);
  assert.match(up.stderr, /uiAdoptionRatio/);
  assert.match(up.stderr, /up/);
});

test("one explicit exception cannot authorize another metric", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  await f.put("renderer/src/App.tsx", "useState(1);\nuseState(2);\nuseState(3);\n");
  assert.notEqual(f.run("--write", "--allow-regression=appLines").status, 0);
  assert.equal((await f.baseline()).appLines.value, 2);
  assert.notEqual(f.run("--write", "--allow-regression=typo").status, 0);
});

test("new 801-line production source fails independently of aggregate improvement", async (t) => {
  const f = await fixture(t);
  await f.put("renderer/src/Legacy.tsx", "legacy\n".repeat(1001));
  assert.equal(f.run("--write").status, 0);
  await f.put("renderer/src/Legacy.tsx", "legacy\n");
  await f.put("renderer/src/New.tsx", "new\n".repeat(801));
  const failed = f.run("--check");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /New\.tsx/);
  assert.match(failed.stderr, /800/);
});

test("per-path caps reject growth, rename, and debt restored after deletion", async (t) => {
  const f = await fixture(t);
  await f.put("renderer/src/Legacy.tsx", "legacy\n".repeat(1001));
  assert.equal(f.run("--write").status, 0);
  await f.put("renderer/src/Legacy.tsx", "legacy\n".repeat(1002));
  assert.notEqual(f.run("--check").status, 0);
  await rename(join(f.root, "renderer/src/Legacy.tsx"), join(f.root, "renderer/src/Renamed.tsx"));
  assert.match(f.run("--check").stderr, /Renamed\.tsx/);
  await rm(join(f.root, "renderer/src/Renamed.tsx"));
  assert.equal(f.run("--write").status, 0);
  await f.put("renderer/src/Legacy.tsx", "legacy\n".repeat(1001));
  assert.notEqual(f.run("--check").status, 0);
});

test("an explicit base detects baseline relaxation in the same change", async (t) => {
  const f = await fixture(t);
  const git = (...args) => spawnSync("git", args, { cwd: f.root, encoding: "utf8" });
  assert.equal(f.run("--write").status, 0);
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "baseline",
    ).status,
    0,
  );
  const baseline = await f.baseline();
  baseline.appLines.value = 100;
  await f.put("health-baseline.json", JSON.stringify(baseline));
  const result = f.run("--check", "--base=HEAD");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /appLines/);
  assert.match(result.stderr, /baseline/i);
});

test("type suppression and experimental debt are counted by their existing owners", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/Boundary.cjs", "// @ts-ignore\n// @ts-expect-error\nmodule.exports = {};\n");
  await f.put(
    "packages/ui/experimental-allowlist.json",
    JSON.stringify([
      {
        file: "renderer/src/Consumer.tsx",
        symbol: "Pending",
        owner: "renderer/src/Consumer.tsx",
        exitCondition: "Remove after admission",
      },
    ]),
  );
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.metrics.tsIgnores.value, 1);
  assert.equal(report.metrics.tsExpectErrors.value, 1);
  assert.equal(report.metrics.experimentalImports.value, 1);
});

test("package root and client implementations share production caps while build tools do not", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  await f.put("packages/provider-config/connections.cjs", "module.exports = {};\n".repeat(801));
  await f.put("packages/workbench/client/model.js", "export {};\n".repeat(801));
  await f.put("packages/gen-ui/build.mjs", "build();\n".repeat(1001));
  await f.put("packages/runtime-client/core.d.ts", "export {};\n".repeat(1001));
  const report = JSON.parse(f.run().stdout);
  assert.equal(report.sourceLines["packages/provider-config/connections.cjs"], 801);
  assert.equal(report.sourceLines["packages/workbench/client/model.js"], 801);
  assert.equal(report.sourceLines["packages/gen-ui/build.mjs"], undefined);
  assert.equal(report.sourceLines["packages/runtime-client/core.d.ts"], undefined);
  const result = f.run("--check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /connections\.cjs/);
  assert.match(result.stderr, /client\/model\.js/);
});

test("Main coverage detects a new unchecked file even when checked file count is unchanged", async (t) => {
  const f = await fixture(t);
  await f.put("app/src/main.cjs", "// @ts-check\nmodule.exports = {};\n");
  assert.equal(f.run("--write").status, 0);
  const before = JSON.parse(f.run().stdout);
  assert.equal(before.metrics.mainTypeCoverage.value, 1);
  await f.put("app/src/new.cjs", "module.exports = {};\n");
  const after = JSON.parse(f.run().stdout);
  assert.equal(after.metrics.mainCheckedFiles.value, before.metrics.mainCheckedFiles.value);
  assert.equal(after.metrics.mainTypeCoverage.value, 0.5);
  assert.notEqual(f.run("--check").status, 0);
});

test("active design document growth is tracked while the user entry has a separate ceiling", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("--write").status, 0);
  const before = JSON.parse(f.run().stdout);
  assert.ok(before.metrics.activeDesignDocBytes.value > 0);
  assert.ok(before.counts.userEntryDocBytes > 0);
  await f.put("design-system/new-rule.md", "# New rule\n");
  const after = JSON.parse(f.run().stdout);
  assert.ok(after.metrics.activeDesignDocBytes.value > before.metrics.activeDesignDocBytes.value);
  assert.equal(after.counts.userEntryDocBytes, before.counts.userEntryDocBytes);
  assert.notEqual(f.run("--check").status, 0);
});
