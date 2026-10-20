import { verifyDesignCatalog } from "./design-system-catalog.mjs";
import { cssFindings, tsxFindings } from "./design-system-rules.mjs";
import { auditDesignChanges } from "./design-system-changes.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const catalog = await verifyDesignCatalog();

const root = fileURLToPath(new URL("../renderer/src/", import.meta.url));
const files = ["DecisionCard.css", "prompt-editor/ComposerSurface.css", "SideChat.css", "components/ui/feedback.css", "settings/SettingsPageParts.css", "settings/SettingsPageParts.tsx"];

assert.equal(cssFindings(".x{font-size:12px;color:#fff;padding:12px}").length, 2);
assert.equal(cssFindings(".x{color:red;background:transparent}").length, 1);
assert.equal(cssFindings("/* color:#fff */ .x{font-size:var(--text-ui-sm);color:var(--color-foreground);padding:12px}").length, 0);
for (const [source, count] of [
  ['<div className="text-sm bg-red-500" />', 2],
  ['<div className={cn("px-4", active && "text-[12px]")} />', 1],
  ['<div className={active ? "text-white" : "bg-blue-600"} />', 2],
  ['<div className={`px-4 ${active ? "text-lg" : "text-xs"}`} />', 2],
  ['<div style={{ fontSize: 12, color: "#fff" }} />', 2],
  ['<div style={{ backgroundColor: "rgb(0 0 0)", fontSize: "1rem" }} />', 2],
  ['<div className="hover:text-sm data-[active]:bg-red-500 [&>p]:text-white" />', 3],
]) assert.equal(tsxFindings(source).length, count, source);
for (const source of [
  '<div className={cn("text-ui-sm bg-surface px-4", active && "text-foreground")} />',
  '<div className={`max-w-[280px] ${active ? "text-ui-base" : "text-ui-sm"}`} />',
  '<div style={{ fontSize: "var(--text-ui-sm)", color: "var(--color-foreground)", width: 280, padding: "12px" }} />',
  '<p>text-sm #fff is content</p>',
]) assert.deepEqual(tsxFindings(source), [], source);

const sources = await Promise.all(files.map(file => readFile(join(root, file), "utf8")));
const owners = await Promise.all(["styles.css", "settings/applicationSettings.ts", "settings/applicationPreferences.ts"].map(file => readFile(join(root, file), "utf8")));
const definitions = new Set([...(owners.join("\n") + sources.join("\n")).matchAll(/(--[\w-]+)["']?\s*:/g)].map(match => match[1]));
const violations = [];
sources.forEach((source, index) => {
  violations.push(...(files[index].endsWith(".css") ? cssFindings(source) : tsxFindings(source)).map(value => `${files[index]}: ${value}`));
  for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
    if (!definitions.has(match[1])) violations.push(`${files[index]}: undefined token ${match[1]}`);
  }
});
assert.deepEqual(violations, [], `设计系统新增硬编码：\n${violations.join("\n")}`);
const changes = await auditDesignChanges();
assert.deepEqual(changes.violations, [], `新增 UI 设计违规：\n${changes.violations.map(item => `${item.file}: ${item.finding}`).join("\n")}`);
console.log(JSON.stringify({ passed: true, catalog, files, changes, scope: "complete migrated CSS and static JSX className/style literals, including cn, conditionals and templates; dynamic indirect styles are not covered; layout numbers remain component-owned" }));
