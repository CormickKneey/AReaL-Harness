import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cssFindings,
  tsxFindings,
  nativeControlFindings,
  layoutFindings,
} from "./design-system-rules.mjs";

const prefix = "clients/gui/renderer/src/";
const productionUI = (file) =>
  file.startsWith(prefix) &&
  /\.(?:css|tsx|jsx)$/.test(file) &&
  !file.startsWith(`${prefix}design-system/`);
function findings(file, source) {
  const result = file.endsWith(".css")
    ? cssFindings(source, file === `${prefix}styles.css`)
    : tsxFindings(source, false);
  // 基础控件所有者可实现原生元素，颜色/字号仍受同一增量约束。
  if (!file.endsWith(".css") && !file.startsWith(`${prefix}components/ui/`))
    result.push(...nativeControlFindings(source));
  return result;
}
const fingerprint = (finding) => finding.replace(/\s+/g, "");

export async function auditDesignChanges({
  repoRoot,
  base = process.env.AREAL_DESIGN_BASE || (process.env.GITHUB_ACTIONS === "true" ? null : "HEAD"),
} = {}) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  repoRoot ??= git(["rev-parse", "--show-toplevel"]).trim();
  assert.ok(
    base,
    "GitHub Actions requires AREAL_DESIGN_BASE; HEAD would miss committed UI changes",
  );
  let revision;
  try {
    revision = git(["rev-parse", "--verify", `${base}^{commit}`]).trim();
  } catch {
    throw new Error(
      `Unavailable design audit base: ${base}. Fetch the base commit; do not skip the audit.`,
    );
  }

  // 同时比较已提交分支、索引和工作树；保留 Git 能识别的重命名来源。
  const entries = git([
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--diff-filter=ACMRT",
    revision,
    "--",
    prefix,
  ])
    .split("\0")
    .filter(Boolean);
  const candidates = new Map();
  for (let i = 0; i < entries.length;) {
    const status = entries[i++],
      oldPath = entries[i++];
    const file = status.startsWith("R") ? entries[i++] : oldPath;
    if (productionUI(file)) candidates.set(file, status === "A" ? null : oldPath);
  }
  for (const file of git(["ls-files", "--others", "--exclude-standard", "-z", "--", prefix])
    .split("\0")
    .filter(Boolean)) {
    if (productionUI(file)) candidates.set(file, null);
  }
  const violations = [];
  let existingFindings = 0;
  for (const [file, oldPath] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const previous = oldPath ? findings(oldPath, git(["show", `${revision}:${oldPath}`])) : [];
    const remaining = new Map();
    for (const finding of previous) {
      const key = fingerprint(finding);
      remaining.set(key, (remaining.get(key) || 0) + 1);
    }
    const current = await readFile(join(repoRoot, file), "utf8");
    if (file.endsWith(".css") && oldPath !== file && !file.endsWith(".layout.css"))
      violations.push({ file, finding: "new renderer CSS must use .layout.css" });
    if (file.endsWith(".layout.css"))
      violations.push(...layoutFindings(current).map((finding) => ({ file, finding })));
    for (const finding of findings(file, current)) {
      const key = fingerprint(finding),
        count = remaining.get(key) || 0;
      if (count) {
        remaining.set(key, count - 1);
        existingFindings++;
      } else violations.push({ file, finding });
    }
  }
  return { base: revision, files: [...candidates.keys()].sort(), existingFindings, violations };
}

export async function verifyStyleExceptions({
  root = fileURLToPath(new URL("../", import.meta.url)),
} = {}) {
  const policy = JSON.parse(
    await readFile(join(root, "design-system/style-exceptions.json"), "utf8"),
  );
  assert.equal(policy.schemaVersion, 1, "unsupported style exception schema");
  assert.ok(Array.isArray(policy.styles), "style exceptions must be an array");
  assert.ok(
    policy.styles.every(
      (style) =>
        style &&
        typeof style.file === "string" &&
        typeof style.reason === "string" &&
        style.reason.trim() &&
        typeof style.exitCondition === "string" &&
        style.exitCondition.trim() &&
        Array.isArray(style.consumers) &&
        style.consumers.length > 0,
    ),
    "style exception needs an owner reason, consumer and exit condition",
  );
  const declared = policy.styles.map((style) => style.file).sort();
  assert.equal(new Set(declared).size, declared.length, "duplicate style exception");
  const actual = (await readdir(join(root, "renderer/src"), { recursive: true }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter(
      (file) =>
        file.endsWith(".css") &&
        !file.endsWith(".layout.css") &&
        !file.startsWith("design-system/"),
    )
    .map((file) => `renderer/src/${file}`)
    .sort();
  assert.deepEqual(
    declared,
    actual,
    "retained style exceptions must exactly match current non-layout files",
  );
  return { retainedStyles: actual.length };
}
