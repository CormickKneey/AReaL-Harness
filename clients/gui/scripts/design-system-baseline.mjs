// 存量字面量基线（ratchet）：统计生产 UI 中绕过 Token 的字号、颜色与圆角。
// 每个文件每类的数量只能减少；增加时审计失败，减少后需运行 --write 锁定新的上限。
// 增量审计（design-system-changes.mjs）只看本次改动；本基线让已提交的存量也可见、可收敛。
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { cssFindings, tsxFindings, radiusFindings } from "./design-system-rules.mjs";

const gui = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = resolve(gui, "design-system/literal-baseline.json");
const roots = [
  { dir: "renderer/src", skip: (file) => file.startsWith("design-system/") },
  { dir: "packages/ui/src", skip: (file) => file.startsWith("generated/") },
];
const category = (finding) =>
  finding.startsWith("literal typography")
    ? "typography"
    : finding.startsWith("literal color")
      ? "color"
      : finding.startsWith("literal radius")
        ? "radius"
        : null;

export async function collectLiteralFindings() {
  const result = [];
  for (const { dir, skip } of roots) {
    const entries = (await readdir(resolve(gui, dir), { recursive: true }))
      .filter((file) => /\.(?:css|tsx)$/.test(file) && !skip(file))
      .sort();
    for (const file of entries) {
      const source = await readFile(resolve(gui, dir, file), "utf8");
      // styles.css 是主题别名的所有者，允许在 --* 定义中写颜色；其他文件不允许。
      const findings = file.endsWith(".css")
        ? [
            ...cssFindings(source, `${dir}/${file}` === "renderer/src/styles.css"),
            ...radiusFindings(source),
          ]
        : tsxFindings(source, false);
      const occurrences = new Map();
      for (const finding of findings) {
        if (!category(finding)) continue;
        const occurrence = (occurrences.get(finding) ?? 0) + 1;
        occurrences.set(finding, occurrence);
        result.push({ file: `${dir}/${file}`, finding, occurrence });
      }
    }
  }
  return result;
}

function countsFromFindings(findings) {
  const counts = {};
  for (const { file, finding } of findings) {
    const key = category(finding);
    if (!key) continue;
    counts[file] ??= {};
    counts[file][key] = (counts[file][key] ?? 0) + 1;
  }
  return counts;
}

export async function collectLiterals() {
  return countsFromFindings(await collectLiteralFindings());
}

const total = (counts) =>
  Object.values(counts).reduce((sum, row) => {
    for (const [key, value] of Object.entries(row)) sum[key] = (sum[key] || 0) + value;
    return sum;
  }, {});

export function validateLiteralExceptions(findings, exceptions) {
  assert.ok(Array.isArray(exceptions), "literal exceptions must be an array");
  const identity = (entry) => JSON.stringify([entry.file, entry.finding, entry.occurrence]);
  const actual = new Set(findings.map(identity));
  const seen = new Set();
  for (const entry of exceptions) {
    assert.ok(
      entry && typeof entry === "object" && !Array.isArray(entry),
      "invalid literal exception",
    );
    for (const field of ["file", "finding", "reason", "exitCondition"]) {
      assert.ok(
        typeof entry[field] === "string" && entry[field].trim(),
        `literal exception ${field} must be nonempty`,
      );
    }
    assert.ok(
      Number.isInteger(entry.occurrence) && entry.occurrence > 0,
      "literal exception occurrence must be a positive integer",
    );
    const key = identity(entry);
    assert.ok(!seen.has(key), `duplicate literal exception: ${key}`);
    assert.ok(actual.has(key), `stale literal exception: ${key}`);
    seen.add(key);
  }
  for (const key of actual) assert.ok(seen.has(key), `missing literal exception: ${key}`);
}

export function renderLiteralBaseline(findings, baseline) {
  validateLiteralExceptions(findings, baseline.exceptions);
  const files = countsFromFindings(findings);
  return { ...baseline, total: total(files), files };
}

export async function verifyLiteralBaseline({ write = false } = {}) {
  const findings = await collectLiteralFindings();
  const previous = JSON.parse(await readFile(baselinePath, "utf8"));
  const next = renderLiteralBaseline(findings, previous);
  const actual = next.files;
  if (write) {
    await writeFile(baselinePath, JSON.stringify(next, null, 2) + "\n");
    return { written: true, total: next.total, exceptions: next.exceptions.length };
  }
  const baseline = previous.files;
  const increased = [],
    decreased = [];
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(actual)])) {
    for (const key of ["typography", "color", "radius"]) {
      const before = baseline[file]?.[key] || 0,
        after = actual[file]?.[key] || 0;
      if (after > before) increased.push(`${file} ${key}: ${before} → ${after}`);
      if (after < before) decreased.push(`${file} ${key}: ${before} → ${after}`);
    }
  }
  assert.deepEqual(
    increased,
    [],
    `字面量超过基线，请改用 Token（见 design/foundations/tokens.md）：\n${increased.join("\n")}`,
  );
  assert.deepEqual(
    decreased,
    [],
    `字面量已减少，请运行 node scripts/design-system-baseline.mjs --write 锁定新上限：\n${decreased.join("\n")}`,
  );
  return { passed: true, total: total(actual), exceptions: next.exceptions.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(
    JSON.stringify(await verifyLiteralBaseline({ write: process.argv.includes("--write") })),
  );
}
