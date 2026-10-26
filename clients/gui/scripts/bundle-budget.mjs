import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const gui = fileURLToPath(new URL("../", import.meta.url));

export async function inspectBundle(directory) {
  const root = resolve(directory);
  const analysis = JSON.parse(await readFile(resolve(root, "bundle-analysis.json"), "utf8"));
  assert.equal(analysis.schemaVersion, 1, "unsupported bundle analysis schema");
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith(".js"))
    .sort();
  const sizes = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        const bytes = await readFile(resolve(root, file));
        if (analysis.chunks[file])
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            analysis.chunks[file].sha256,
            `stale bundle analysis for ${file}`,
          );
        return [file, { bytes: bytes.length, gzipBytes: gzipSync(bytes).length }];
      }),
    ),
  );
  for (const file of Object.keys(analysis.chunks))
    assert.ok(sizes[file], `missing emitted chunk ${file}`);
  const entries = {};
  for (const html of (await readdir(root)).filter((file) => file.endsWith(".html")).sort()) {
    const source = await readFile(resolve(root, html), "utf8");
    const roots = [...source.matchAll(/<(?:script|link)\b[^>]*>/gi)].flatMap(([tag]) => {
      if (!/\b(?:type\s*=\s*["']module["']|rel\s*=\s*["']modulepreload["'])/i.test(tag)) return [];
      const target = tag.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!target || /^(?:[a-z]+:|\/\/)/i.test(target)) return [];
      const file = relative(root, resolve(root, dirname(html), target.replace(/^\//, "")));
      assert.ok(!file.startsWith(".."), `entry escapes bundle directory ${target}`);
      return file.endsWith(".js") ? [file] : [];
    });
    assert.ok(roots.length, `missing module entry in ${html}`);
    const reachable = new Set();
    const pending = [...roots];
    while (pending.length) {
      const file = pending.pop();
      if (reachable.has(file)) continue;
      assert.ok(sizes[file], `missing initial chunk ${file}`);
      assert.ok(analysis.chunks[file], `missing module analysis for ${file}`);
      reachable.add(file);
      pending.push(...analysis.chunks[file].imports);
    }
    entries[html] = {
      files: [...reachable].sort(),
      jsBytes: [...reachable].reduce((sum, file) => sum + sizes[file].bytes, 0),
      gzipBytes: [...reachable].reduce((sum, file) => sum + sizes[file].gzipBytes, 0),
      modules: [...new Set([...reachable].flatMap((file) => analysis.chunks[file].modules))].sort(),
    };
  }
  assert.ok(Object.keys(entries).length, "bundle has no HTML entries");
  const initial = new Set(Object.values(entries).flatMap((entry) => entry.files));
  const lazyChunks = {};
  for (const [file, chunk] of Object.entries(analysis.chunks)) {
    if (!initial.has(file))
      lazyChunks[chunk.name] = Math.max(lazyChunks[chunk.name] ?? 0, sizes[file].bytes);
  }
  return {
    schemaVersion: 1,
    totalJsBytes: Object.values(sizes).reduce((sum, size) => sum + size.bytes, 0),
    totalGzipBytes: Object.values(sizes).reduce((sum, size) => sum + size.gzipBytes, 0),
    entries,
    lazyChunks: Object.fromEntries(
      Object.entries(lazyChunks).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function compareBudget(report, budget) {
  const failures = [];
  if (report.totalJsBytes > budget.totalJsBytes)
    failures.push(`totalJsBytes ${report.totalJsBytes} exceeds ${budget.totalJsBytes}`);
  for (const [name, entry] of Object.entries(report.entries)) {
    if (budget.entries[name] === undefined) failures.push(`unbudgeted entry ${name}`);
    else if (entry.jsBytes > budget.entries[name])
      failures.push(`${name} initial JS ${entry.jsBytes} exceeds ${budget.entries[name]}`);
    for (const module of budget.forbiddenInitialModules) {
      if (entry.modules.some((value) => value.includes(module)))
        failures.push(`${name} initially loads ${module}`);
    }
  }
  for (const [name, bytes] of Object.entries(report.lazyChunks)) {
    if (budget.lazyChunks[name] === undefined) failures.push(`unbudgeted lazy chunk ${name}`);
    else if (bytes > budget.lazyChunks[name])
      failures.push(`lazy chunk ${name} ${bytes} exceeds ${budget.lazyChunks[name]}`);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(
    args.every((arg) => ["--check", "--write"].includes(arg) || arg.startsWith("--dist=")),
    "unknown bundle-budget option",
  );
  assert.ok(!(args.includes("--check") && args.includes("--write")), "choose --check or --write");
  const report = await inspectBundle(
    resolve(gui, args.find((arg) => arg.startsWith("--dist="))?.slice(7) ?? "renderer/dist"),
  );
  const path = resolve(gui, "bundle-budget.json");
  if (args.includes("--write")) {
    const budget = {
      schemaVersion: 1,
      description:
        "Production build byte budgets with 5% headroom. HTML entries include static imports and modulepreloads. Review every budget change.",
      totalJsBytes: Math.ceil(report.totalJsBytes * 1.05),
      entries: Object.fromEntries(
        Object.entries(report.entries).map(([name, entry]) => [
          name,
          Math.ceil(entry.jsBytes * 1.05),
        ]),
      ),
      lazyChunks: Object.fromEntries(
        Object.entries(report.lazyChunks).map(([name, bytes]) => [name, Math.ceil(bytes * 1.05)]),
      ),
      forbiddenInitialModules: ["terminal/TerminalSession.tsx", "WorkspaceMarkdownView.tsx"],
    };
    const previous = await readFile(path, "utf8").then(JSON.parse, (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (previous) {
      budget.forbiddenInitialModules = previous.forbiddenInitialModules;
      assert.ok(
        budget.totalJsBytes <= previous.totalJsBytes,
        "--write cannot increase totalJsBytes",
      );
      for (const group of ["entries", "lazyChunks"]) {
        for (const [name, value] of Object.entries(budget[group])) {
          assert.ok(
            previous[group][name] !== undefined && value <= previous[group][name],
            `--write cannot increase ${group}.${name}`,
          );
        }
      }
    }
    await writeFile(path, JSON.stringify(budget, null, 2) + "\n");
  }
  if (args.includes("--check")) {
    const budget = JSON.parse(await readFile(path, "utf8"));
    assert.equal(budget.schemaVersion, 1, "unsupported bundle budget schema");
    const failures = compareBudget(report, budget);
    assert.deepEqual(failures, [], failures.join("\n"));
  }
  console.log(JSON.stringify(report, null, 2));
}
