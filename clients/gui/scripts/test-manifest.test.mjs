import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./test-manifest.mjs", import.meta.url));
async function fixture(t, entries) {
  const root = await mkdtemp(join(tmpdir(), "areal-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/one.mjs"), "export {};\n");
  await writeFile(join(root, "scripts/two.mjs"), "export {};\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        "test:one": "node scripts/one.mjs",
        "test:two": "node scripts/two.mjs",
        build: "build",
      },
    }),
  );
  await writeFile(join(root, "scripts/test-manifest.json"), JSON.stringify(entries));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8" });
  run.root = root;
  return run;
}
const one = {
  script: "test:one",
  layer: "contract",
  platforms: ["darwin", "linux"],
  areas: ["lifecycle"],
  requires: [],
};
const two = {
  script: "test:two",
  layer: "e2e",
  platforms: ["darwin"],
  platformReason: "Fixture requires macOS Electron.",
  areas: ["composer"],
  requires: ["electron"],
};

test("every package test script must have exactly one registration", async (t) => {
  assert.equal((await fixture(t, [one, two]))().status, 0);
  const missing = (await fixture(t, [one]))();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /test:two/);
  const duplicate = (await fixture(t, [one, two, one]))();
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate.*test:one/i);
  assert.notEqual((await fixture(t, [one, two, { ...one, script: "test:old" }]))().status, 0);
});

test("invalid metadata cannot enter the selector", async (t) => {
  for (const patch of [
    { layer: "fast" },
    { platforms: ["unknown"] },
    { areas: [] },
    { requires: "electron" },
    { platforms: ["darwin"] },
  ]) {
    assert.notEqual((await fixture(t, [{ ...one, ...patch }, two]))().status, 0);
  }
});

test("selection intersects layer, platform, area, and available requirements", async (t) => {
  const run = await fixture(t, [one, two]);
  const selected = run("--list", "--platform=linux", "--layer=contract", "--area=lifecycle");
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout).scripts, ["test:one"]);
  assert.deepEqual(
    JSON.parse(run("--list", "--platform=darwin", "--layer=e2e").stdout).scripts,
    [],
  );
  assert.deepEqual(
    JSON.parse(run("--list", "--platform=darwin", "--layer=e2e", "--available=electron").stdout)
      .scripts,
    ["test:two"],
  );
});

test("temporary directory helper resolves platform aliases", async (t) => {
  const { makeTempDir } = await import("./support/temp.mjs");
  const { realpath } = await import("node:fs/promises");
  const dir = await makeTempDir("areal-temp-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(dir, await realpath(dir));
  assert.equal(dir.startsWith(await realpath(tmpdir())), true);
});

test("registered tests reject macOS temporary literals in source and imported helpers", async (t) => {
  const run = await fixture(t, [one, two]);
  await writeFile(
    join(run.root, "scripts/one.mjs"),
    'export const location = "/private/tmp/case";\n',
  );
  const direct = run();
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /one\.mjs.*platform-specific temporary path/);
  await writeFile(join(run.root, "scripts/one.mjs"), 'import "./helper.mjs";\n');
  await writeFile(
    join(run.root, "scripts/helper.mjs"),
    "export const location = `/var/folders/case`;\n",
  );
  const imported = run();
  assert.notEqual(imported.status, 0);
  assert.match(imported.stderr, /helper\.mjs.*platform-specific temporary path/);
  await writeFile(
    join(run.root, "scripts/helper.mjs"),
    'export const text = "a diagnostic mentioning /private/tmp";\n',
  );
  assert.equal(run().status, 0);
});
