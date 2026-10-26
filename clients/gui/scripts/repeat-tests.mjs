import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTestManifest } from "./test-manifest.mjs";

const gui = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(gui, "../..");
const threshold = 0.95;

export function summarizeRepeats(entries, runs, repetitions, platform) {
  const keys = runs.map((run) => `${run.script}:${run.iteration}`);
  assert.equal(new Set(keys).size, keys.length, "Duplicate repeat attempt");
  assert.ok(
    runs.every(
      (run) =>
        entries.some((entry) => entry.script === run.script) &&
        Number.isInteger(run.iteration) &&
        run.iteration >= 1 &&
        run.iteration <= repetitions &&
        ["passed", "failed", "blocked"].includes(run.status),
    ),
    "Invalid repeat attempt",
  );
  const tests = entries.map((entry) => {
    const attempts = runs.filter((run) => run.script === entry.script);
    const passed = attempts.filter((run) => run.status === "passed").length;
    const failed = attempts.filter((run) => run.status === "failed").length;
    const blocked = attempts.filter((run) => run.status === "blocked").length;
    const complete = attempts.length === repetitions;
    const passRate = passed / repetitions;
    return {
      script: entry.script,
      journey: entry.qualificationJourney ?? null,
      planned: repetitions,
      attempted: attempts.length,
      passed,
      failed,
      blocked,
      passRate,
      flakyCandidate:
        platform === "darwin" &&
        complete &&
        repetitions >= 5 &&
        blocked === 0 &&
        failed > 0 &&
        passRate < threshold,
      eligibleForRequiredCi:
        platform === "linux" &&
        Boolean(entry.qualificationJourney) &&
        complete &&
        repetitions >= 10 &&
        blocked === 0 &&
        passRate >= threshold,
    };
  });
  return {
    threshold,
    passed: tests.every((test) => test.passed === repetitions),
    tests,
    flakyCandidates: tests.filter((test) => test.flakyCandidate).map((test) => test.script),
  };
}

async function sourceIdentity() {
  const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const paths = git("ls-files", "--modified", "--others", "--exclude-standard", "-z")
    .toString()
    .split("\0")
    .filter(Boolean);
  const changedFiles = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(join(root, path)).then(
          (bytes) => createHash("sha256").update(bytes).digest("hex"),
          (error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        ),
      ]),
    ),
  );
  const binary = process.env.AREAL_CORE_BIN;
  return {
    commit: git("rev-parse", "HEAD").toString().trim(),
    diffSha256: createHash("sha256")
      .update(git("diff", "--binary", "HEAD"))
      .digest("hex"),
    changedFiles,
    binary: binary
      ? {
          path: resolve(binary),
          sha256: createHash("sha256")
            .update(await readFile(binary))
            .digest("hex"),
        }
      : null,
  };
}

function linuxPrerequisites() {
  if (process.platform !== "linux") return [];
  const failures = [];
  if (!process.env.DISPLAY)
    failures.push("DISPLAY is missing; launch through xvfb-run on a native Linux runner.");
  if (process.getuid() === 0)
    failures.push("Electron qualification requires a non-root user with its sandbox enabled.");
  for (const [command, args] of [
    ["unshare", ["--user", "--map-root-user", "true"]],
    ["bwrap", ["--ro-bind", "/", "/", "--unshare-user", "--", "/bin/true"]],
  ]) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0)
      failures.push(
        `${command}: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`,
      );
  }
  return failures;
}

async function runAttempt(entry, iteration, output) {
  const directory = join(output, entry.script.replaceAll(":", "-"), String(iteration));
  await mkdir(join(directory, "tmp"), { recursive: true });
  const log = await open(join(directory, "output.log"), "w");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawn("pnpm", ["run", entry.script], {
    cwd: gui,
    detached: true,
    env: {
      ...process.env,
      TMPDIR: join(directory, "tmp"),
      TMP: join(directory, "tmp"),
      TEMP: join(directory, "tmp"),
    },
    stdio: ["ignore", log.fd, log.fd],
  });
  const terminate = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let timedOut = false;
  let wasInterrupted = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate("SIGINT");
    killTimer = setTimeout(() => terminate("SIGKILL"), 15000);
  }, 600000);
  const interrupted = () => {
    wasInterrupted = true;
    terminate("SIGINT");
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const result = await new Promise((done) => {
    child.once("error", (error) => done({ code: null, error: error.message }));
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  await log.close();
  return {
    script: entry.script,
    iteration,
    startedAt,
    elapsedMs: Math.round(performance.now() - started),
    status:
      !timedOut && result.code === 0
        ? "passed"
        : !timedOut && result.code === 2
          ? "blocked"
          : "failed",
    timedOut,
    interrupted: wasInterrupted,
    ...result,
    directory,
  };
}

async function main() {
  const value = (name) =>
    process.argv
      .slice(2)
      .find((arg) => arg.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const profile = value("--profile") ?? "linux-feasibility";
  assert.ok(["linux-feasibility", "macos-baseline"].includes(profile), "Unknown repeat profile");
  const platform = profile === "linux-feasibility" ? "linux" : "darwin";
  const repetitions = Number(value("--repetitions") ?? (platform === "linux" ? 10 : 5));
  assert.ok(
    Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 100,
    "Invalid repetitions",
  );
  const requested = value("--scripts")?.split(",");
  const manifest = await readTestManifest();
  const entries = manifest.filter(
    (entry) =>
      entry.layer === "e2e" &&
      entry.platforms.includes(platform) &&
      (requested
        ? requested.includes(entry.script)
        : platform === "linux"
          ? entry.qualificationJourney
          : !entry.requires.includes("desktop-input")),
  );
  assert.ok(entries.length > 0, "No repeat tests selected");
  if (requested)
    assert.deepEqual(
      [...new Set(requested)].sort(),
      entries.map((entry) => entry.script).sort(),
      "Requested scripts must be registered e2e tests on this platform",
    );
  const plan = {
    profile,
    platform,
    repetitions,
    scripts: entries.map((entry) => entry.script),
    scoped: Boolean(requested),
    retries: 0,
  };
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const output = resolve(
    value("--output") ??
      join(root, ".scratch/test-repeats", new Date().toISOString().replaceAll(":", "-")),
  );
  await mkdir(output, { recursive: true });
  const before = await sourceIdentity();
  const blockers =
    process.platform !== platform
      ? [`${profile} requires ${platform}; current host is ${process.platform}.`]
      : linuxPrerequisites();
  if (!before.binary)
    blockers.push("AREAL_CORE_BIN must name the frozen Core binary for this run.");
  const runs = [];
  const report = {
    ...plan,
    output,
    startedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    sourceBefore: before,
    blockers,
    runs,
  };
  const save = async () => {
    const summary = summarizeRepeats(entries, runs, repetitions, platform);
    const validSource = report.sourceUnchanged === true && blockers.length === 0;
    const result = {
      ...report,
      ...summary,
      passed: summary.passed && validSource,
      flakyCandidates: validSource ? summary.flakyCandidates : [],
      tests: summary.tests.map((test) => ({
        ...test,
        flakyCandidate: test.flakyCandidate && validSource,
        eligibleForRequiredCi: test.eligibleForRequiredCi && validSource,
      })),
    };
    await writeFile(join(output, "report.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  };
  await save();
  if (blockers.length) {
    console.error(
      JSON.stringify({ status: "blocked", blockers, report: join(output, "report.json") }),
    );
    process.exitCode = 2;
    return;
  }
  for (const entry of entries) {
    for (let iteration = 1; iteration <= repetitions; iteration++) {
      const attempt = await runAttempt(entry, iteration, output);
      runs.push(attempt);
      console.log(JSON.stringify(attempt));
      await save();
      if (attempt.interrupted) {
        process.exitCode = 130;
        return;
      }
    }
  }
  report.sourceAfter = await sourceIdentity();
  report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(report.sourceAfter);
  report.completedAt = new Date().toISOString();
  const result = await save();
  console.log(
    JSON.stringify({
      report: join(output, "report.json"),
      sourceUnchanged: report.sourceUnchanged,
      passed: result.passed,
      tests: result.tests,
    }),
  );
  if (!report.sourceUnchanged || !summarizeRepeats(entries, runs, repetitions, platform).passed)
    process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
