import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { preserveSignedPaths } from "./macos-signing-paths.mjs";

test("outer signing preserves Core bytes through main and background-service resource paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-sign-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, "Candidate.app/Contents");
  const shared = join(contents, "Resources");
  const service = join(contents, "Frameworks/Service.app/Contents");
  await mkdir(shared, { recursive: true });
  await mkdir(service, { recursive: true });
  await symlink("../../../Resources", join(service, "Resources"));
  const names = [
    "areal-core/bin/areal",
    "areal-core/libexec/areal/areal-runtime",
    "areal-core/libexec/areal/areal-runtime-fs",
  ];
  const paths = [];
  for (const name of names) {
    const path = join(shared, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "signed Core: " + name);
    paths.push(path);
  }
  const others = [
    join(contents, "MacOS/GUI"),
    join(service, "MacOS/Service"),
    join(contents, "Frameworks/Native.framework/Versions/A/Native"),
  ];
  for (const other of others) {
    await mkdir(join(other, ".."), { recursive: true });
    await writeFile(other, "unsigned nested executable");
  }
  const ignore = preserveSignedPaths(paths);
  for (const path of [
    ...paths,
    ...names.map((name) => join(service, "Resources", name)),
    ...others,
  ]) {
    if (!ignore(path)) await writeFile(path, "outer signature");
  }
  for (let i = 0; i < paths.length; i++)
    assert.equal(await readFile(paths[i], "utf8"), "signed Core: " + names[i]);
  for (const other of others) assert.equal(await readFile(other, "utf8"), "outer signature");
  assert.equal(ignore(join(contents, "Resources/areal-core/LICENSE")), false);
});

test("missing protected input fails closed rather than silently ignoring another path", () => {
  assert.throws(() => preserveSignedPaths([join(tmpdir(), "absent-areal-signing-core", "areal")]));
});
