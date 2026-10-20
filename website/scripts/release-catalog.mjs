import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import semver from "semver";

export const REPOSITORY = "areal-project/AReaL-Harness";
const github = `https://github.com/${REPOSITORY}`;
const targets = { "macos-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" };
const catalogPath = fileURLToPath(new URL("../src/generated/releases.json", import.meta.url));

function exactUrl(value, expected, label) {
  if (value !== expected) throw new Error(`Untrusted ${label}: ${value}`);
  return value;
}

function classify(release) {
  if (typeof release?.tag_name !== "string" || release.draft === true) return null;
  const match = /^(gui-)?v(.+)$/.exec(release.tag_name);
  if (!match || !semver.valid(match[2])) return null;
  return {
    client: match[1] ? "gui" : "tui",
    channel:
      release.prerelease === false && semver.prerelease(match[2]) === null ? "stable" : "preview",
    version: match[2],
  };
}

function normalizeRelease(wire, { client, version }) {
  if (wire.draft !== false || typeof wire.prerelease !== "boolean")
    throw new Error(`Invalid release flags for ${wire.tag_name}`);
  if (typeof wire.published_at !== "string" || !Number.isFinite(Date.parse(wire.published_at)))
    throw new Error(`Invalid publication date for ${wire.tag_name}`);
  if (!Array.isArray(wire.assets)) throw new Error(`Missing assets for ${wire.tag_name}`);
  const tag = wire.tag_name;
  const notesUrl = exactUrl(
    wire.html_url,
    `${github}/releases/tag/${encodeURIComponent(tag)}`,
    "release URL",
  );
  const names = new Map();
  for (const item of wire.assets) {
    if (typeof item?.name !== "string") throw new Error(`Invalid asset name in ${tag}`);
    if (names.has(item.name)) throw new Error(`Duplicate asset ${item.name} in ${tag}`);
    names.set(item.name, item);
  }
  const getAsset = (name, format) => {
    const item = names.get(name);
    if (!item) return null;
    if (item.state !== "uploaded" || !Number.isSafeInteger(item.size) || item.size <= 0)
      throw new Error(`Incomplete asset ${name} in ${tag}`);
    return {
      name,
      format,
      size: item.size,
      url: exactUrl(
        item.browser_download_url,
        `${github}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
        "asset URL",
      ),
    };
  };
  const assets = {};
  if (client === "gui") {
    const stem = `AReaLHarness-${version}-macos-arm64`;
    const dmg = getAsset(`${stem}.dmg`, "dmg");
    const zip = getAsset(`${stem}.zip`, "zip");
    if (dmg || zip) assets["macos-arm64"] = dmg || zip;
  } else {
    for (const [platform, target] of Object.entries(targets)) {
      const item = getAsset(`areal-harness-v${version}-${target}.tar.gz`, "tar.gz");
      if (item) assets[platform] = item;
    }
  }
  return {
    status: "release",
    tag,
    version,
    notesUrl,
    publishedAt: wire.published_at,
    checksumUrl: getAsset("SHA256SUMS", "sha256")?.url ?? null,
    installerUrl: client === "tui" ? (getAsset("install.py", "python")?.url ?? null) : null,
    assets,
  };
}

export function compileCatalog(releases, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(releases)) throw new Error("GitHub releases input must be an array");
  const clients = {
    gui: { stable: { status: "no-release" }, preview: { status: "no-release" } },
    tui: { stable: { status: "no-release" }, preview: { status: "no-release" } },
  };
  const selected = { gui: {}, tui: {} };
  for (const wire of releases) {
    const identity = classify(wire);
    if (!identity) continue;
    const current = selected[identity.client][identity.channel];
    if (!current || semver.gt(identity.version, current.identity.version))
      selected[identity.client][identity.channel] = { wire, identity };
  }
  for (const client of Object.keys(clients)) {
    for (const channel of Object.keys(clients[client])) {
      const chosen = selected[client][channel];
      if (chosen) clients[client][channel] = normalizeRelease(chosen.wire, chosen.identity);
    }
  }
  const catalog = { schemaVersion: 1, repository: REPOSITORY, generatedAt, clients };
  validateCatalog(catalog);
  return catalog;
}

export function validateCatalog(catalog) {
  if (
    catalog?.schemaVersion !== 1 ||
    catalog.repository !== REPOSITORY ||
    !Number.isFinite(Date.parse(catalog.generatedAt))
  )
    throw new Error("Invalid release catalog metadata");
  for (const client of ["gui", "tui"]) {
    for (const channel of ["stable", "preview"]) {
      const slot = catalog.clients?.[client]?.[channel];
      if (slot?.status === "no-release") continue;
      if (
        slot?.status !== "release" ||
        !semver.valid(slot.version) ||
        slot.tag !== `${client === "gui" ? "gui-" : ""}v${slot.version}`
      )
        throw new Error(`Invalid catalog slot ${client}/${channel}`);
      if (channel === "stable" && semver.prerelease(slot.version) !== null)
        throw new Error("Prerelease in stable slot");
      exactUrl(
        slot.notesUrl,
        `${github}/releases/tag/${encodeURIComponent(slot.tag)}`,
        "catalog release URL",
      );
      if (!Number.isFinite(Date.parse(slot.publishedAt)))
        throw new Error("Invalid catalog publication date");
      if (!slot.assets || typeof slot.assets !== "object")
        throw new Error("Missing catalog assets");
      for (const [platform, asset] of Object.entries(slot.assets)) {
        if (!Object.hasOwn(targets, platform) || (client === "gui" && platform !== "macos-arm64"))
          throw new Error("Unsupported catalog platform");
        const formats = client === "gui" ? ["dmg", "zip"] : ["tar.gz"];
        if (!formats.includes(asset.format) || !Number.isSafeInteger(asset.size) || asset.size <= 0)
          throw new Error("Invalid catalog asset");
        const expectedName =
          client === "gui"
            ? `AReaLHarness-${slot.version}-macos-arm64.${asset.format}`
            : `areal-harness-v${slot.version}-${targets[platform]}.tar.gz`;
        if (asset.name !== expectedName)
          throw new Error("Catalog asset version does not match release");
        exactUrl(
          asset.url,
          `${github}/releases/download/${encodeURIComponent(slot.tag)}/${encodeURIComponent(expectedName)}`,
          "catalog asset URL",
        );
      }
      if (slot.checksumUrl !== null)
        exactUrl(
          slot.checksumUrl,
          `${github}/releases/download/${encodeURIComponent(slot.tag)}/SHA256SUMS`,
          "checksum URL",
        );
      if (slot.installerUrl !== null)
        exactUrl(
          slot.installerUrl,
          `${github}/releases/download/${encodeURIComponent(slot.tag)}/install.py`,
          "installer URL",
        );
      if (client === "gui" && slot.installerUrl !== null)
        throw new Error("Unexpected GUI installer script");
    }
  }
}

async function fetchReleases() {
  const releases = [];
  for (let page = 1; page <= 100; page += 1) {
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetch(
      `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`,
      { headers, signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok) throw new Error(`GitHub release refresh failed with HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("Unexpected GitHub release response");
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error("GitHub release pagination exceeded the supported limit");
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--input", "--output"].includes(args[index]) || !args[index + 1])
      throw new Error(
        "Usage: node scripts/release-catalog.mjs [--input releases.json] [--output catalog.json]",
      );
    options[args[index].slice(2)] = args[index + 1];
  }
  const releases = options.input
    ? JSON.parse(await readFile(options.input, "utf8"))
    : await fetchReleases();
  const catalog = compileCatalog(releases);
  const output = options.output ? path.resolve(options.output) : catalogPath;
  const temporary = `${output}.${process.pid}.tmp`;
  await mkdir(path.dirname(output), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Refreshed official release catalog at ${catalog.generatedAt}`);
  for (const [client, channels] of Object.entries(catalog.clients)) {
    for (const [channel, release] of Object.entries(channels))
      console.log(`${client}/${channel}: ${release.version ?? "unavailable"}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
