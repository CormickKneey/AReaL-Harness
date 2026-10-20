import { verifyDesignCatalog } from "./design-system-catalog.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const catalog = await verifyDesignCatalog();

const root = fileURLToPath(new URL("../renderer/src/", import.meta.url));
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts = require("typescript");
const files = ["DecisionCard.css", "prompt-editor/ComposerSurface.css", "SideChat.css", "components/ui/feedback.css", "settings/SettingsPageParts.css", "settings/SettingsPageParts.tsx"];
const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const literalSize = /\b\d+(?:\.\d+)?(?:px|rem|em)\b/;
function declarationFindings(property, value) {
  const out = [];
  if ((property === "font-size" || property === "font") && literalSize.test(value)) out.push(`literal typography: ${property}: ${value}`);
  if (!property.startsWith("--") && rawColor.test(value)) out.push(`literal color: ${property}: ${value}`);
  if (["color", "background", "background-color", "border-color"].includes(property) &&
    /^[a-z]+$/i.test(value.trim()) && !/^(inherit|initial|unset|revert|transparent|currentcolor|none)$/i.test(value.trim())) {
    out.push(`literal color: ${property}: ${value}`);
  }
  return out;
}
function cssFindings(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/(?<=[{;])\s*([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)]
    .flatMap(([, property, value]) => declarationFindings(property, value));
}
function classFindings(value) {
  return value.split(/\s+/).filter(Boolean).flatMap(token => {
    const utility = token.split(/:(?![^\[]*\])/).at(-1).replace(/^!/, "");
    if (/^text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:\/.*)?$/.test(utility) ||
      /^text-\[(?:length:)?\d/.test(utility) || /^\[font-size:/.test(utility)) return [`literal typography class: ${token}`];
    if (/^(?:text|bg|border|ring|outline|divide|decoration|shadow|fill|stroke|from|via|to)(?:-[a-z]+)?-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|black|white)(?:\/.*)?$/.test(utility) ||
      /^(?:text|bg|border|ring|outline|fill|stroke)-\[/.test(utility) && !utility.includes("var(--") && !utility.includes("--color-") ||
      /^\[(?:color|background(?:-color)?|border-color):/.test(utility) && !utility.includes("var(--")) return [`literal color class: ${token}`];
    return [];
  });
}
function tsxFindings(source) {
  const tree = ts.createSourceFile("settings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const strings = (node, visit) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) visit(node.text);
    ts.forEachChild(node, child => strings(child, visit));
  };
  const scan = node => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      if (node.name.text === "className") strings(node.initializer, value => out.push(...classFindings(value)));
      if (node.name.text === "style" && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)) {
        for (const property of node.initializer.expression.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = property.name.getText(tree).replace(/^["']|["']$/g, "").replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
          if (ts.isNumericLiteral(property.initializer) && ["font-size", "font"].includes(name)) out.push(`literal typography style: ${name}: ${property.initializer.text}`);
          strings(property.initializer, value => out.push(...declarationFindings(name, value)));
        }
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(tree);
  return out;
}

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
console.log(JSON.stringify({ passed: true, catalog, files, scope: "complete migrated CSS and static JSX className/style literals, including cn, conditionals and templates; dynamic indirect styles are not covered; layout numbers remain component-owned" }));
