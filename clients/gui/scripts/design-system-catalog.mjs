import assert from "node:assert/strict";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guiRoot = fileURLToPath(new URL("../", import.meta.url));
const text = value => typeof value === "string" && value.trim().length > 0;
const cells = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const list = (value, label) => assert.ok(Array.isArray(value) && value.length > 0, `${label}: expected nonempty array`);
function unique(items, label) {
  list(items, label);
  assert.equal(new Set(items).size, items.length, `${label}: duplicate entry`);
}
async function source(root, path) {
  assert.ok(text(path) && !path.startsWith("/") && !path.includes("\\"), `invalid source path: ${path}`);
  const absolute = resolve(root, path);
  assert.ok(!relative(root, absolute).startsWith(".."), `source escapes GUI: ${path}`);
  assert.ok((await stat(absolute)).isFile(), `source is not a file: ${path}`);
  return readFile(absolute, "utf8");
}
function block(document, name, body) {
  const start = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  assert.equal(document.split(start).length, 2, `missing/duplicate marker: ${start}`);
  assert.equal(document.split(end).length, 2, `missing/duplicate marker: ${end}`);
  const from = document.indexOf(start) + start.length, to = document.indexOf(end);
  assert.ok(to >= from, `reversed markers: ${name}`);
  return document.slice(0, from) + `\n\n${body}\n\n` + document.slice(to);
}

// 本目录是声明与派生输出的合同，不解析 JSX，也不把声明当作运行/视觉验收。
export async function verifyDesignCatalog({ write = false, root = guiRoot } = {}) {
  const dataRoot = join(root, "design-system");
  const registry = JSON.parse(await readFile(join(dataRoot, "registry.json"), "utf8"));
  assert.equal(registry.schemaVersion, 1, "registry.schemaVersion must be 1");
  unique(registry.tokenSources, "tokenSources");
  const tokenSources = await Promise.all(registry.tokenSources.map(path => source(root, path)));
  const definitions = new Set([...tokenSources.join("\n").matchAll(/(--[\w-]+)["']?\s*:/g)].map(match => match[1]));
  list(registry.tokenGroups, "tokenGroups");
  const tokenNames = [];
  for (const group of registry.tokenGroups) {
    assert.ok(text(group.title), "token group needs a title");
    list(group.tokens, group.title);
    for (const pair of group.tokens) {
      assert.ok(Array.isArray(pair) && pair.length === 2 && pair.every(text), `${group.title}: expected [name, role]`);
      assert.ok(definitions.has(pair[0]), `registry: undefined production token ${pair[0]}`);
      tokenNames.push(pair[0]);
    }
  }
  unique(tokenNames, "tokens");
  list(registry.components, "components");
  unique(registry.components.map(item => item.id), "component ids");
  const components = new Set(registry.components.map(item => item.id));
  for (const component of registry.components) {
    assert.ok(/^[A-Z]\w*$/.test(component.id) && text(component.purpose), `invalid component: ${component.id}`);
    await source(root, component.source);
  }
  list(registry.patterns, "patterns");
  unique(registry.patterns.map(item => item.id), "pattern ids");
  const patterns = new Map(registry.patterns.map(item => [item.id, item]));
  for (const pattern of registry.patterns) {
    assert.ok(/^P-[A-Z]+$/.test(pattern.id), `invalid pattern id: ${pattern.id}`);
    for (const key of ["intent", "variation", "acceptance"]) assert.ok(text(pattern[key]), `${pattern.id}: missing ${key}`);
    for (const key of ["components", "slots", "states"]) unique(pattern[key], `${pattern.id}.${key}`);
    for (const id of pattern.components) assert.ok(components.has(id), `${pattern.id}: unknown component ${id}`);
    await source(root, pattern.reference);
  }
  const surfaces = (await readdir(join(dataRoot, "surfaces"))).filter(name => name.endsWith(".json")).sort();
  list(surfaces, "surface contracts");
  const surfaceIds = [];
  for (const name of surfaces) {
    const path = `design-system/surfaces/${name}`;
    const surface = JSON.parse(await source(root, path));
    assert.equal(surface.schemaVersion, 1, `${path}: schemaVersion must be 1`);
    for (const key of ["id", "intent", "target", "runtime"]) assert.ok(text(surface[key]), `${path}: missing ${key}`);
    assert.ok(["component-preview", "desktop", "remote"].includes(surface.runtime), `${path}: unknown runtime`);
    surfaceIds.push(surface.id);
    const pattern = patterns.get(surface.pattern);
    assert.ok(pattern, `${path}: unknown pattern ${surface.pattern}`);
    await source(root, surface.target);
    assert.ok(["existing-code", "screenshot", "figma"].includes(surface.reference?.kind), `${path}: missing reference kind`);
    if (surface.reference.kind === "existing-code") await source(root, surface.reference.path);
    else assert.ok(text(surface.reference.visualTarget), `${path}: missing selected visual target`);
    assert.ok(surface.slots && typeof surface.slots === "object", `${path}: missing slots`);
    for (const slot of pattern.slots) list(surface.slots[slot], `${path}.${slot}`);
    for (const [slot, ids] of Object.entries(surface.slots)) {
      assert.ok(pattern.slots.includes(slot), `${path}: unknown slot ${slot}`);
      unique(ids, `${path}.${slot}`);
      for (const id of ids) assert.ok(components.has(id), `${path}: unknown component ${id}`);
    }
    list(surface.states, `${path}.states`);
    unique(surface.states.map(item => item.id), `${path}.state ids`);
    for (const state of pattern.states) assert.ok(surface.states.some(item => item.id === state), `${path}: missing required state ${state}`);
    for (const state of surface.states) assert.ok(text(state.condition) && text(state.expected), `${path}.${state.id}: missing condition/expected`);
    for (const key of ["themes", "fontSizes", "widthModes", "reducedMotion"]) list(surface.conditions?.[key], `${path}.conditions.${key}`);
    assert.ok(surface.conditions.themes.every(value => ["light", "dark"].includes(value)), `${path}: unknown theme condition`);
    assert.ok(surface.conditions.widthModes.every(value => ["wide", "narrow"].includes(value)), `${path}: unknown width mode`);
    assert.ok(surface.conditions.fontSizes.every(value => typeof value === "number" && Number.isFinite(value) && value > 0), `${path}: invalid font size condition`);
    assert.ok(surface.conditions.reducedMotion.every(value => typeof value === "boolean"), `${path}: invalid reduced motion condition`);
    list(surface.invariants, `${path}.invariants`);
    assert.ok(surface.invariants.every(text), `${path}: empty invariant`);
    assert.ok(["pending", "captured", "compared"].includes(surface.evidence?.status), `${path}: missing evidence status`);
    assert.ok(Array.isArray(surface.evidence.artifacts) && Array.isArray(surface.evidence.gaps), `${path}: missing artifacts/gaps`);
    if (surface.evidence.status === "pending") list(surface.evidence.gaps, `${path}: pending evidence needs explicit gaps`);
    if (surface.evidence.status !== "pending") {
      list(surface.evidence.artifacts, `${path}: non-pending evidence needs artifacts`);
      assert.ok(surface.evidence.artifacts.every(item => text(item.path) && /^[a-f0-9]{64}$/.test(item.sha256) && text(item.state)), `${path}: artifact needs path/sha256/state`);
    }
    if (surface.evidence.status === "compared") assert.ok(text(surface.reference.visualTarget), `${path}: compared needs a selected visual target`);
  }
  unique(surfaceIds, "surface ids");
  const componentTable = "## 生产组件（生成）\n\n| ID | 生产所有者 | 用途 |\n| --- | --- | --- |\n" + registry.components.map(item => `| ${item.id} | [${item.id}](../${item.source}) | ${cells(item.purpose)} |`).join("\n");
  const patternTable = "| ID / 用户任务 | 最小组合 / 生产参考 | 允许变化 | 验收重点 |\n| --- | --- | --- | --- |\n" + registry.patterns.map(item => `| ${item.id} ${cells(item.intent)} | ${item.components.join(" + ")}；[参考](../${item.reference}) | ${cells(item.variation)} | ${cells(item.acceptance)} |`).join("\n");
  const catalog = "// 由 design-system/registry.json 生成；运行 pnpm --dir clients/gui design:sync。\n// 只记录角色与定义名，数值始终从生产 CSS 读取。\nexport const tokenGroups = " + JSON.stringify(registry.tokenGroups, null, 2) + " as const;\n";
  const outputs = new Map([["renderer/src/design-system/catalog.ts", catalog]]);
  for (const [file, name, body] of [["inventory.md", "components", componentTable], ["patterns.md", "patterns", patternTable]]) {
    const path = `design-system/${file}`;
    outputs.set(path, block(await source(root, path), name, body));
  }
  const stale = [];
  for (const [path, content] of outputs) {
    let previous;
    try { previous = await readFile(join(root, path), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous === content) continue;
    if (write) await writeFile(join(root, path), content);
    else stale.push(path);
  }
  assert.equal(stale.length, 0, `Design catalog is stale: ${stale.join(", ")}. Run pnpm --dir clients/gui design:sync; do not edit generated blocks.`);
  return { components: components.size, patterns: patterns.size, tokens: tokenNames.length, surfaces: surfaces.length, outputs: outputs.size };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(2).every(arg => ["--write", "--check"].includes(arg)), "usage: design-system-catalog.mjs [--write|--check]");
  assert.ok(!(process.argv.includes("--write") && process.argv.includes("--check")), "choose --write or --check");
  console.log(JSON.stringify({ passed: true, mode: process.argv.includes("--write") ? "write" : "check", ...await verifyDesignCatalog({ write: process.argv.includes("--write") }) }));
}
