import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("DMG CLI accepts the budget boundary and blocks excess or missing artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-dmg-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "candidate with spaces.dmg");
  const file = await open(path, "w");
  t.after(() => file.close());
  const run = (...paths) => spawnSync(process.execPath,
    [new URL("./dmg-size.mjs", import.meta.url).pathname, ...paths], { encoding: "utf8" });
  for (const bytes of [250 * 1024 * 1024 - 1, 250 * 1024 * 1024]) {
    await file.truncate(bytes);
    const result = run(path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).bytes, bytes);
  }
  await file.truncate(250 * 1024 * 1024 + 1);
  const excess = run(path);
  assert.equal(excess.status, 1);
  assert.match(excess.stderr, /exceeds 250 MiB/);
  assert.equal(run(join(root, "missing.dmg")).status, 1);
  assert.equal(run().status, 1);
});

test("package command rejects unsupported modes before creating output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-package-options-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = new URL("./package.mjs", import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: root });
  assert.equal(run("--help").status, 0);
  for (const args of [["--platform", "linux"], ["--arch", "x64"], ["--formats", "exe"],
    ["--signing", "unsigned"], ["--signing", "none", "--identity", "unexpected"],
    ["--signing", "developer-id", "--formats", "zip"]]) {
    const result = run(...args, "--output", join(root, "must-not-exist"));
    assert.notEqual(result.status, 0, result.stdout);
  }
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(root), []);
});
