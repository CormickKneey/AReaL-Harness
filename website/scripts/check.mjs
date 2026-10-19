import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, readdir, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compileCatalog, validateCatalog, REPOSITORY } from "./release-catalog.mjs";
import {
  translations,
  platforms,
  resolveSelection,
  changeClient,
  readLocale,
  localeUrl,
} from "../src/site-model.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const time = "2026-10-19T00:00:00.000Z";
const asset = (tag, name, extra = {}) => ({
  name,
  state: "uploaded",
  size: 100,
  browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`,
  ...extra,
});
const release = (tag, extra = {}) => {
  const gui = tag.startsWith("gui-v");
  const version = tag.replace(/^(gui-)?v/, "");
  return {
    tag_name: tag,
    draft: false,
    prerelease: version.includes("-"),
    published_at: time,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    assets: [
      asset(tag, "SHA256SUMS"),
      ...(gui
        ? [asset(tag, `AReaLHarness-${version}-macos-arm64.dmg`)]
        : [
            asset(tag, "install.py"),
            asset(tag, `areal-harness-v${version}-aarch64-apple-darwin.tar.gz`),
            asset(tag, `areal-harness-v${version}-x86_64-unknown-linux-gnu.tar.gz`),
          ]),
    ],
    ...extra,
  };
};
const selection = { client: "gui", channel: "stable", platform: "macos-arm64" };
const catalog = compileCatalog(
  [
    release("gui-v1.9.0"),
    release("gui-v1.10.0"),
    release("gui-v1.11.0-beta.9"),
    release("gui-v1.11.0-beta.10"),
    release("v2.0.0"),
    release("v2.1.0-beta.1"),
    release("gui-update-channel"),
    release("gui-v9.0.0", { draft: true }),
  ],
  time,
);
assert.equal(catalog.clients.gui.stable.version, "1.10.0");
assert.equal(catalog.clients.gui.preview.version, "1.11.0-beta.10");
assert.equal(catalog.clients.tui.stable.version, "2.0.0");
assert.equal(catalog.clients.tui.preview.version, "2.1.0-beta.1");
assert.equal(resolveSelection(catalog, selection).status, "ready");
assert.equal("downloadCommand" in resolveSelection(catalog, selection), false);
for (const [channel, platform, expected] of [
  [
    "stable",
    "macos-arm64",
    "curl -fL 'https://github.com/areal-project/AReaL-Harness/releases/download/v2.0.0/areal-harness-v2.0.0-aarch64-apple-darwin.tar.gz' -o 'areal-harness-v2.0.0-aarch64-apple-darwin.tar.gz'",
  ],
  [
    "stable",
    "linux-x64",
    "curl -fL 'https://github.com/areal-project/AReaL-Harness/releases/download/v2.0.0/areal-harness-v2.0.0-x86_64-unknown-linux-gnu.tar.gz' -o 'areal-harness-v2.0.0-x86_64-unknown-linux-gnu.tar.gz'",
  ],
  [
    "preview",
    "macos-arm64",
    "curl -fL 'https://github.com/areal-project/AReaL-Harness/releases/download/v2.1.0-beta.1/areal-harness-v2.1.0-beta.1-aarch64-apple-darwin.tar.gz' -o 'areal-harness-v2.1.0-beta.1-aarch64-apple-darwin.tar.gz'",
  ],
  [
    "preview",
    "linux-x64",
    "curl -fL 'https://github.com/areal-project/AReaL-Harness/releases/download/v2.1.0-beta.1/areal-harness-v2.1.0-beta.1-x86_64-unknown-linux-gnu.tar.gz' -o 'areal-harness-v2.1.0-beta.1-x86_64-unknown-linux-gnu.tar.gz'",
  ],
]) {
  const resolved = resolveSelection(catalog, { client: "tui", channel, platform });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.downloadCommand, expected);
}
const noTuiRelease = resolveSelection(compileCatalog([], time), { ...selection, client: "tui" });
assert.equal(noTuiRelease.status, "no-release");
assert.equal("downloadCommand" in noTuiRelease, false);
const noTuiPackage = resolveSelection(
  compileCatalog([release("v2.0.0", { assets: [] })], time),
  { ...selection, client: "tui" },
);
assert.equal(noTuiPackage.status, "no-platform-package");
assert.equal("downloadCommand" in noTuiPackage, false);
for (const [locale, expected, file] of [
  ["en", "A modular framework for tool execution and multi-agent collaboration", "README.en.md"],
  ["zh", "面向工具执行与多 Agent 协作的模块化框架", "README.md"],
]) {
  const copy = translations[locale];
  assert.equal(copy.headline + copy.headlineAccent, expected);
  assert.equal(copy.title, `AReaL-Harness | ${expected}`);
  const readme = await readFile(path.join(root, "..", file), "utf8");
  assert.ok(readme.includes(`<strong>${expected}</strong>`));
}
assert.equal(
  resolveSelection(catalog, { client: "tui", channel: "stable", platform: "linux-x64" }).asset
    .format,
  "tar.gz",
);
assert.equal(
  compileCatalog([release("gui-v1.0.0-test.10"), release("gui-v1.0.0-test.9")], time).clients.gui
    .preview.version,
  "1.0.0-test.10",
);
assert.equal(
  compileCatalog([release("v1.0.0", { prerelease: true })], time).clients.tui.preview.version,
  "1.0.0",
);
assert.equal(resolveSelection(compileCatalog([], time), selection).status, "no-release");
const latestWithoutPackage = compileCatalog(
  [release("gui-v1.0.0"), release("gui-v2.0.0", { assets: [] })],
  time,
);
const missing = resolveSelection(latestWithoutPackage, selection);
assert.equal(missing.status, "no-platform-package");
assert.equal(missing.release.version, "2.0.0");
assert.equal(
  missing.release.notesUrl,
  "https://github.com/areal-project/AReaL-Harness/releases/tag/gui-v2.0.0",
);
assert.equal("asset" in missing, false);
const zip = release("gui-v1.0.0");
zip.assets[1] = asset(zip.tag_name, "AReaLHarness-1.0.0-macos-arm64.zip");
assert.equal(resolveSelection(compileCatalog([zip], time), selection).asset.format, "zip");
for (const invalid of [
  { state: "starter" },
  { size: 0 },
  { browser_download_url: "https://example.test/package.dmg" },
]) {
  const wire = release("gui-v1.0.0");
  Object.assign(wire.assets[1], invalid);
  assert.throws(() => compileCatalog([wire], time));
}
const oldInvalid = release("gui-v1.0.0");
oldInvalid.assets[1].state = "starter";
assert.equal(
  compileCatalog([oldInvalid, release("gui-v2.0.0")], time).clients.gui.stable.version,
  "2.0.0",
);
const noInstaller = release("v1.0.0");
noInstaller.assets = noInstaller.assets.filter((item) => item.name !== "install.py");
assert.equal(
  resolveSelection(compileCatalog([noInstaller], time), { ...selection, client: "tui" }).status,
  "no-platform-package",
);
assert.deepEqual(platforms.gui, ["macos-arm64"]);
assert.deepEqual(
  changeClient({ client: "tui", channel: "preview", platform: "linux-x64" }, "gui"),
  { client: "gui", channel: "preview", platform: "macos-arm64" },
);
assert.deepEqual(
  changeClient({ client: "gui", channel: "preview", platform: "macos-arm64" }, "tui"),
  { client: "tui", channel: "preview", platform: "macos-arm64" },
);
const keys = (value, prefix = "") =>
  Object.entries(value)
    .flatMap(([key, child]) =>
      typeof child === "object" && child !== null
        ? keys(child, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    )
    .sort();
assert.deepEqual(keys(translations.en), keys(translations.zh));
for (const dictionary of Object.values(translations)) {
  const leaves = (value) =>
    Object.values(value).flatMap((child) =>
      typeof child === "object" && child !== null ? leaves(child) : [child],
    );
  assert.ok(
    leaves(dictionary).every((value) => typeof value === "string" && value.trim().length > 0),
  );
}
assert.equal(readLocale("?lang=zh", "en"), "zh");
assert.equal(readLocale("?lang=unknown", "zh"), "zh");
assert.equal(readLocale("", null), "en");
assert.equal(
  localeUrl("https://example.test/repo/?client=tui#downloads", "zh"),
  "/repo/?client=tui&lang=zh#downloads",
);
const committed = JSON.parse(
  await readFile(path.join(root, "src/generated/releases.json"), "utf8"),
);
validateCatalog(committed);
for (const [client, channels] of Object.entries(committed.clients)) {
  for (const [channel, slot] of Object.entries(channels)) {
    for (const platform of platforms[client]) {
      const resolved = resolveSelection(committed, { client, channel, platform });
      assert.ok(["ready", "no-release", "no-platform-package"].includes(resolved.status));
      if (resolved.status === "ready")
        assert.ok(
          resolved.asset.url.startsWith(
            `https://github.com/${REPOSITORY}/releases/download/${slot.tag}/`,
          ),
        );
    }
  }
}
const temp = await mkdtemp(path.join(tmpdir(), "areal-website-check-"));
try {
  const input = path.join(temp, "invalid.json");
  const output = path.join(temp, "catalog.json");
  await writeFile(input, "{}");
  await writeFile(output, "preserve the valid snapshot");
  const refresh = spawnSync(
    process.execPath,
    [path.join(root, "scripts/release-catalog.mjs"), "--input", input, "--output", output],
    { encoding: "utf8" },
  );
  assert.notEqual(refresh.status, 0);
  assert.equal(await readFile(output, "utf8"), "preserve the valid snapshot");
} finally {
  await rm(temp, { recursive: true, force: true });
}
const html = await readFile(path.join(root, "dist/client/index.html"), "utf8");
assert.ok(html.includes(`<title>${translations.en.title}</title>`));
assert.ok(html.includes(`content="${translations.en.description}"`));
const references = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
  .map((match) => match[1])
  .filter((url) => !url.startsWith("https:"));
assert.ok(references.length >= 2);
for (const reference of references) {
  assert.ok(reference.startsWith("./"), `Project Pages requires relative assets: ${reference}`);
  await access(path.join(root, "dist/client", reference));
}
await access(path.join(root, "dist/client/.nojekyll"));
for (const font of ["instrument-serif", "dm-mono"]) {
  const license = await readFile(path.join(root, `dist/client/licenses/${font}-OFL.txt`), "utf8");
  assert.ok(license.includes("SIL OPEN FONT LICENSE Version 1.1"));
}
const builtAssets = await readdir(path.join(root, "dist/client/assets"));
assert.ok(builtAssets.some((name) => name.endsWith(".woff2")));
for (const name of builtAssets.filter((item) => /\.(js|css)$/.test(item))) {
  const text = await readFile(path.join(root, "dist/client/assets", name), "utf8");
  assert.ok(!text.includes("api.github.com"), "Visitors must not query the GitHub API");
  assert.ok(!text.includes("/Users/"), "Built files must not contain machine paths");
}
console.log(
  "Website contracts passed. Release ordering, availability, trust, language, atomic refresh and project Pages assets verified.",
);
