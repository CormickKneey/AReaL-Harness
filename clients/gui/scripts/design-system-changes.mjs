import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cssFindings, tsxFindings, nativeControlFindings } from "./design-system-rules.mjs";

const prefix = "clients/gui/renderer/src/";
const productionUI = file => file.startsWith(prefix) && /\.(?:css|tsx|jsx)$/.test(file) && !file.startsWith(`${prefix}design-system/`);
function findings(file, source) {
  const result = file.endsWith(".css") ? cssFindings(source, file === `${prefix}styles.css`) : tsxFindings(source, false);
  // 基础控件所有者可实现原生元素，颜色/字号仍受同一增量约束。
  if (!file.endsWith(".css") && !file.startsWith(`${prefix}components/ui/`)) result.push(...nativeControlFindings(source));
  return result;
}
const fingerprint = finding => finding.replace(/\s+/g, "");

export async function auditDesignChanges({ repoRoot, base = process.env.AREAL_DESIGN_BASE || (process.env.GITHUB_ACTIONS === "true" ? null : "HEAD") } = {}) {
  const git = args => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  repoRoot ??= git(["rev-parse", "--show-toplevel"]).trim();
  assert.ok(base, "GitHub Actions requires AREAL_DESIGN_BASE; HEAD would miss committed UI changes");
  let revision;
  try { revision = git(["rev-parse", "--verify", `${base}^{commit}`]).trim(); }
  catch { throw new Error(`Unavailable design audit base: ${base}. Fetch the base commit; do not skip the audit.`); }

  // 同时比较已提交分支、索引和工作树；保留 Git 能识别的重命名来源。
  const entries = git(["diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACMRT", revision, "--", prefix]).split("\0").filter(Boolean);
  const candidates = new Map();
  for (let i = 0; i < entries.length;) {
    const status = entries[i++], oldPath = entries[i++];
    const file = status.startsWith("R") ? entries[i++] : oldPath;
    if (productionUI(file)) candidates.set(file, status === "A" ? null : oldPath);
  }
  for (const file of git(["ls-files", "--others", "--exclude-standard", "-z", "--", prefix]).split("\0").filter(Boolean)) {
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
    for (const finding of findings(file, await readFile(join(repoRoot, file), "utf8"))) {
      const key = fingerprint(finding), count = remaining.get(key) || 0;
      if (count) { remaining.set(key, count - 1); existingFindings++; }
      else violations.push({ file, finding });
    }
  }
  return { base: revision, files: [...candidates.keys()].sort(), existingFindings, violations };
}
