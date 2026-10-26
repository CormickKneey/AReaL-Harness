import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../packages/ui/package.json", import.meta.url));
const ts = require("typescript");
const scripts = fileURLToPath(new URL("./", import.meta.url));
const changed = [];
for (const file of (await readdir(scripts)).filter((name) => /\.(?:mjs|cjs)$/.test(name))) {
  const path = resolve(scripts, file);
  const original = await readFile(path, "utf8");
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "mkdtemp" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith("/private/tmp/")
    ) {
      const outer =
        ts.isAwaitExpression(node.parent) &&
        ts.isCallExpression(node.parent.parent) &&
        ts.isIdentifier(node.parent.parent.expression) &&
        node.parent.parent.expression.text === "realpath"
          ? node.parent.parent
          : node;
      edits.push({
        start: outer.getStart(source),
        end: outer.end,
        text: `makeTempDir(${JSON.stringify(node.arguments[0].text.slice("/private/tmp/".length))})`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!edits.length && !original.includes("makeTempDir")) continue;
  const migrated = edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), original);
  const importLine = file.endsWith(".cjs")
    ? 'const { makeTempDir } = require("./support/temp.mjs");\n'
    : 'import { makeTempDir } from "./support/temp.mjs";\n';
  const header = migrated.match(/^(?:#![^\n]*\n)?(?:["']use strict["'];\s*\n)?/)?.[0] ?? "";
  const next = pruneTempImports(
    edits.length
      ? migrated.slice(0, header.length) + importLine + migrated.slice(header.length)
      : migrated,
    path,
  );
  if (next === original) continue;
  changed.push({ file, replacements: edits.length });
  if (process.argv.includes("--write")) await writeFile(path, next);
}
console.log(JSON.stringify({ written: process.argv.includes("--write"), files: changed }));
if (process.argv.includes("--check") && changed.length) process.exitCode = 1;

function pruneTempImports(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const used = new Set();
  const edits = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === "require"
    ) {
      visit(node.initializer);
      return;
    }
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const unused = new Set(["mkdtemp", "tmpdir", "realpath"].filter((name) => !used.has(name)));
  const prune = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      const bindings = node.importClause.namedBindings;
      const retained = bindings.elements.filter((item) => !unused.has(item.name.text));
      if (retained.length !== bindings.elements.length) {
        if (!retained.length && !node.importClause.name)
          edits.push({ start: node.getStart(source), end: node.end, text: "" });
        else
          edits.push({
            start: bindings.getStart(source),
            end: bindings.end,
            text: `{ ${retained.map((item) => item.getText(source)).join(", ")} }`,
          });
      }
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === "require"
    ) {
      const retained = node.name.elements.filter((item) => !unused.has(item.name.getText(source)));
      if (retained.length !== node.name.elements.length)
        edits.push({
          start: node.name.getStart(source),
          end: node.name.end,
          text: `{ ${retained.map((item) => item.getText(source)).join(", ")} }`,
        });
    }
    ts.forEachChild(node, prune);
  };
  prune(source);
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((value, edit) => value.slice(0, edit.start) + edit.text + value.slice(edit.end), text);
}
