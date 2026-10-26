import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTestManifest, selectTests } from "./test-manifest.mjs";

const gui = fileURLToPath(new URL("../", import.meta.url));
const manifest = await readTestManifest();
const coreContracts = process.argv.includes("--core-contracts");
const coreAvailable =
  !!process.env.AREAL_CORE_BIN &&
  spawnSync(process.env.AREAL_CORE_BIN, ["build-info"], { stdio: "ignore" }).status === 0;
if (coreContracts && !coreAvailable)
  throw new Error("Core contracts require AREAL_CORE_BIN pointing to the matching executable");
const available = [
  "gui-build",
  ...(coreAvailable ? ["core-binary"] : []),
  `node-${process.versions.node}`,
  ...["git", "python3", "openssl"].filter(
    (command) =>
      spawnSync(command, [command === "openssl" ? "version" : "--version"], { stdio: "ignore" })
        .status === 0,
  ),
];
const selected = selectTests(
  manifest.filter(
    (entry) => entry.layer !== "e2e" && (!coreContracts || entry.requires.includes("core-binary")),
  ),
  { platform: process.platform, available },
);
if (!selected.length) throw new Error(`No portable tests registered for ${process.platform}`);
const output = resolve(
  process.env.AREAL_PORTABLE_TEST_REPORT ?? resolve(gui, "../../target/ci/gui/portable-tests.json"),
);
await mkdir(dirname(output), { recursive: true });
const report = {
  mode: coreContracts ? "core-contracts" : "portable",
  platform: process.platform,
  node: process.version,
  startedAt: new Date().toISOString(),
  available,
  scripts: selected,
  excluded: manifest
    .filter((entry) => entry.layer !== "e2e" && !selected.includes(entry.script))
    .map((entry) => ({
      script: entry.script,
      platformSupported: entry.platforms.includes(process.platform),
      missingRequirements: entry.requires.filter((requirement) => !available.includes(requirement)),
    })),
  results: [],
};
const started = performance.now();
console.log(JSON.stringify(report));
for (const script of selected) {
  const began = performance.now();
  const result = spawnSync("pnpm", ["run", script], { cwd: gui, stdio: "inherit" });
  report.results.push({
    script,
    passed: result.status === 0 && !result.error,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    elapsedMs: Math.round(performance.now() - began),
  });
  report.elapsedMs = Math.round(performance.now() - started);
  report.passed =
    report.results.length === selected.length && report.results.every((result) => result.passed);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (result.status !== 0 || result.error) process.exitCode = 1;
}
console.log(JSON.stringify({ report: output, passed: report.passed, elapsedMs: report.elapsedMs }));
