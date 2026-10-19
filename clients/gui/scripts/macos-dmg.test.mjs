import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { stageMacOSService } from "./stage-macos-service.mjs";
import { buildMacOSDmg } from "./macos-dmg.mjs";

const require = createRequire(import.meta.url);
const { serviceName } = require("../app/src/core/desktop-executables.cjs");
const frameworkRelative = "Contents/Frameworks/Electron Framework.framework";
const serviceRelative = `Contents/Frameworks/${serviceName}.app`;
const run = (bin, args) =>
  execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sign = (path) => run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
const verify = (path) => run("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);

async function fingerprint(directory) {
  const entries = [];
  async function scan(path, relative) {
    const info = await lstat(path);
    entries.push([
      relative,
      info.mode,
      info.ino,
      info.size,
      info.isFile()
        ? createHash("sha256")
            .update(await readFile(path))
            .digest("hex")
        : info.isSymbolicLink()
          ? await readlink(path)
          : "directory",
    ]);
    if (info.isDirectory())
      for (const name of (await readdir(path)).sort())
        await scan(join(path, name), `${relative}/${name}`);
  }
  await scan(directory, ".");
  return entries;
}

async function fixture(root) {
  const app = join(root, "Fixture with spaces.app");
  const framework = join(app, frameworkRelative);
  const version = join(framework, "Versions/A");
  await mkdir(join(version, "Resources"), { recursive: true });
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(join(app, "Contents/Resources"));
  await writeFile(join(root, "framework.c"), "int fixture(void) { return 42; }\n");
  run("/usr/bin/xcrun", [
    "clang",
    "-dynamiclib",
    join(root, "framework.c"),
    "-o",
    join(version, "Electron Framework"),
    "-Wl,-install_name,@rpath/Electron Framework.framework/Electron Framework",
  ]);
  const plist = async (path, info) => {
    await writeFile(path, JSON.stringify(info));
    run("/usr/bin/plutil", ["-convert", "xml1", path]);
  };
  await plist(join(version, "Resources/Info.plist"), {
    CFBundleIdentifier: "com.github.Electron.framework",
    CFBundleExecutable: "Electron Framework",
    CFBundlePackageType: "FMWK",
    CFBundleVersion: "1",
    CFBundleShortVersionString: "1.0",
  });
  await writeFile(join(version, "Resources/payload"), "framework payload\n");
  await symlink("A", join(framework, "Versions/Current"));
  for (const name of ["Electron Framework", "Resources"])
    await symlink(`Versions/Current/${name}`, join(framework, name));
  await copyFile("/usr/bin/true", join(app, "Contents/MacOS/Fixture"));
  await plist(join(app, "Contents/Info.plist"), {
    CFBundleIdentifier: "org.areal.fixture",
    CFBundleExecutable: "Fixture",
    CFBundleName: "Fixture",
    CFBundlePackageType: "APPL",
    CFBundleVersion: "1",
    CFBundleShortVersionString: "1.0",
  });
  await stageMacOSService(app);
  await seal(app);
  return app;
}

async function seal(app) {
  sign(join(app, frameworkRelative));
  sign(join(app, serviceRelative, frameworkRelative));
  sign(join(app, serviceRelative));
  sign(app);
  verify(app);
}

test(
  "DMG exports signed local framework files through private staging",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "areal-dmg-test-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = await fixture(root);
    const before = await fingerprint(app);
    const destination = join(root, "preview.dmg");
    const result = await buildMacOSDmg({ app, destination, volumeName: "AReaL fixture" });
    assert.equal(result.path, destination);
    assert.ok(result.bytes > 0);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.linkedFiles >= 3);
    assert.equal(result.verifiedInodePairs, result.linkedFiles);
    const mount = join(root, "independent-mount");
    await mkdir(mount);
    run("/usr/bin/hdiutil", [
      "attach",
      destination,
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
    ]);
    try {
      const inside = join(mount, basename(app));
      const binary = `${frameworkRelative}/Versions/A/Electron Framework`;
      const main = await lstat(join(inside, binary));
      const service = await lstat(join(inside, serviceRelative, binary));
      assert.ok(main.isFile() && service.isFile());
      assert.equal(main.dev, service.dev);
      assert.equal(
        main.ino,
        service.ino,
        "the DMG must physically share the main framework executable",
      );
      const info = (path) =>
        JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]));
      const mainInfo = info(join(inside, "Contents/Info.plist"));
      const serviceInfo = info(join(inside, serviceRelative, "Contents/Info.plist"));
      assert.notEqual(mainInfo.CFBundleIdentifier, serviceInfo.CFBundleIdentifier);
      assert.equal(serviceInfo.LSBackgroundOnly, true);
      verify(inside);
      const reexport = await buildMacOSDmg({
        app: inside,
        destination: join(root, "reexport.dmg"),
        volumeName: "AReaL reexport",
      });
      assert.ok(
        reexport.bytes > 0,
        "an already compact signed source must export without temporary link leaves",
      );
    } finally {
      run("/usr/bin/hdiutil", ["detach", mount]);
    }
    assert.deepEqual(
      await fingerprint(app),
      before,
      "export must leave source bytes, modes and inodes intact",
    );
    const output = await readFile(destination);
    await assert.rejects(
      buildMacOSDmg({ app, destination, volumeName: "AReaL fixture" }),
      /exist/i,
    );
    assert.deepEqual(
      await readFile(destination),
      output,
      "retry must never overwrite a published image",
    );
  },
);

test(
  "DMG rejects incompatible frameworks without changing source or publishing",
  { skip: process.platform !== "darwin", timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "areal-dmg-reject-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const variant of ["payload", "extra", "escaping-link", "signature-policy", "executable"]) {
      await t.test(variant, async () => {
        const directory = join(root, variant);
        await mkdir(directory);
        const app = await fixture(directory);
        const serviceFramework = join(app, serviceRelative, frameworkRelative);
        const version = join(serviceFramework, "Versions/A");
        if (variant === "payload")
          await writeFile(join(version, "Resources/payload"), "different payload\n");
        if (variant === "extra") await writeFile(join(version, "Resources/extra"), "extra\n");
        if (variant === "executable") {
          await writeFile(join(directory, "different.c"), "int fixture(void) { return 43; }\n");
          run("/usr/bin/xcrun", [
            "clang",
            "-dynamiclib",
            join(directory, "different.c"),
            "-o",
            join(version, "Electron Framework"),
            "-Wl,-install_name,@rpath/Electron Framework.framework/Electron Framework",
          ]);
        }
        if (variant === "escaping-link") {
          for (const base of [join(app, frameworkRelative), serviceFramework])
            await symlink("/System/Library/Frameworks", join(base, "Versions/A/escape"));
        }
        await seal(app);
        if (variant === "signature-policy") {
          run("/usr/bin/codesign", [
            "--force",
            "--sign",
            "-",
            "--identifier",
            "org.areal.incompatible",
            serviceFramework,
          ]);
          sign(join(app, serviceRelative));
          sign(app);
          verify(app);
        }
        const before = await fingerprint(app);
        const destination = join(directory, "rejected.dmg");
        await assert.rejects(
          buildMacOSDmg({ app, destination, volumeName: "Rejected fixture" }),
          /payload|layout|symlink|signature|policy|equivalent|framework/i,
        );
        await assert.rejects(lstat(destination), { code: "ENOENT" });
        assert.deepEqual(
          await fingerprint(app),
          before,
          "failure must leave the valid signed source unchanged",
        );
      });
    }
  },
);
