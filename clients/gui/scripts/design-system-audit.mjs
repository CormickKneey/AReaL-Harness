import { verifyDesignCatalog } from "./design-system-catalog.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const catalog = await verifyDesignCatalog();

const root = fileURLToPath(new URL("../renderer/src/", import.meta.url));
const files = ["DecisionCard.css", "prompt-editor/ComposerSurface.css", "SideChat.css", "components/ui/feedback.css"];
function findings(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const match of source.matchAll(/(?<=[{;])\s*([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const [, property, value] = match;
    if ((property === "font-size" || property === "font") && /\b\d+(?:\.\d+)?(?:px|rem|em)\b/.test(value)) out.push(`literal typography: ${property}: ${value}`);
    if (!property.startsWith("--") && /#[\da-f]{3,8}\b|\brgba?\(/i.test(value)) out.push(`literal color: ${property}: ${value}`);
    if (["color", "background", "background-color", "border-color"].includes(property) &&
      /^[a-z]+$/i.test(value.trim()) && !/^(inherit|initial|unset|revert|transparent|currentcolor|none)$/i.test(value.trim())) {
      out.push(`literal color: ${property}: ${value}`);
    }
  }
  return out;
}
// 验证门禁能抓住目标错误，并保留合法布局数字；范围只覆盖已迁移的 CSS。
assert.equal(findings(".x{font-size:12px;color:#fff;padding:12px}").length, 2);
assert.equal(findings(".x{color:red;background:transparent}").length, 1);
assert.equal(findings("/* color:#fff */ .x{font-size:var(--text-ui-sm);color:var(--color-foreground);padding:12px}").length, 0);
const sources = await Promise.all(files.map(file => readFile(join(root, file), "utf8")));
// 外观设置也会提供生产 Token；不能把合法运行时角色误报为缺失。
const owners = await Promise.all(["styles.css", "settings/applicationSettings.ts", "settings/applicationPreferences.ts"].map(file => readFile(join(root, file), "utf8")));
const definitions = new Set([...(owners.join("\n") + sources.join("\n")).matchAll(/(--[\w-]+)["']?\s*:/g)].map(match => match[1]));
const violations = [];
sources.forEach((css, index) => {
  violations.push(...findings(css).map(value => `${files[index]}: ${value}`));
  for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
    if (!definitions.has(match[1])) violations.push(`${files[index]}: undefined token ${match[1]}`);
  }
});
assert.deepEqual(violations, [], `设计系统新增硬编码：\n${violations.join("\n")}`);
console.log(JSON.stringify({ passed: true, catalog, files, scope: "migrated CSS typography/color literals; layout values remain component-owned" }));
