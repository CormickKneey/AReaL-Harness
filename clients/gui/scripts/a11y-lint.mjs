import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const rules = [
  "alt-text",
  "click-events-have-key-events",
  "no-static-element-interactions",
  "label-has-associated-control",
];

export async function runA11yLint(files = ["renderer/src", "packages/ui/src"]) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/vite-plus/bin/vp"),
      "lint",
      "--jsx-a11y-plugin",
      "-A",
      "all",
      ...rules.flatMap((rule) => ["-D", `jsx-a11y/${rule}`]),
      "--format=json",
      "--ignore-pattern=**/design-system/**",
      "--ignore-pattern=**/*.test.*",
      ...files,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `accessibility linter terminated: ${result.signal}`);
  assert.ok(
    [0, 1].includes(result.status),
    result.stderr || "accessibility linter failed to execute",
  );
  const report = JSON.parse(result.stdout);
  assert.ok(report.number_of_files > 0, "accessibility lint must examine source files");
  const occurrences = new Map();
  return Promise.all(
    report.diagnostics.map(async (finding) => {
      assert.ok(
        rules.some((rule) => finding.code === `jsx-a11y(${rule})`),
        `unexpected lint rule: ${finding.code}`,
      );
      const source = await readFile(resolve(root, finding.filename));
      const span = finding.labels[0].span;
      const snippet = source
        .subarray(span.offset, span.offset + span.length)
        .toString("utf8")
        .replace(/\s+/g, " ");
      const file = relative(root, resolve(root, finding.filename));
      const identity = `${file}\0${finding.code}\0${snippet}`;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      return {
        file,
        rule: finding.code,
        fingerprint: createHash("sha256").update(identity).update(String(occurrence)).digest("hex"),
        snippet,
      };
    }),
  );
}

export async function verifyA11yLint() {
  const findings = await runA11yLint();
  const baseline = JSON.parse(
    await readFile(resolve(root, "design-system/a11y-lint-baseline.json"), "utf8"),
  );
  assert.ok(
    baseline.every((finding) => finding.reason?.trim() && finding.exitCondition?.trim()),
    "legacy accessibility findings need a reason and exit condition",
  );
  assert.equal(
    new Set(baseline.map((finding) => finding.fingerprint)).size,
    baseline.length,
    "duplicate accessibility baseline identity",
  );
  const admitted = new Set(baseline.map((finding) => finding.fingerprint));
  const failures = findings.filter((finding) => !admitted.has(finding.fingerprint));
  assert.deepEqual(failures, [], "new JSX accessibility findings");
  return {
    findings: findings.length,
    resolved: baseline.length - findings.length,
    rules: rules.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await verifyA11yLint()));
