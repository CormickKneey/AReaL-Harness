import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { root } from "./foundations.mjs";

async function files(path) {
  return (
    await Promise.all(
      (await readdir(path, { withFileTypes: true })).map((item) =>
        item.isDirectory() ? files(resolve(path, item.name)) : resolve(path, item.name),
      ),
    )
  ).flat();
}
const entries = new Map(
  (
    await Promise.all(
      ["index", "compositions", "experimental"].map(async (entry) => {
        const source = ts.createSourceFile(
          entry,
          await readFile(resolve(root, `src/${entry}.ts`), "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        return source.statements
          .filter(ts.isExportDeclaration)
          .flatMap((node) =>
            node.exportClause && ts.isNamedExports(node.exportClause)
              ? node.exportClause.elements.map((item) => [item.name.text, entry])
              : [],
          );
      }),
    )
  ).flat(),
);
for (const path of (await files(resolve(root, "../../renderer/src"))).filter((path) =>
  /\.[jt]sx?$/.test(path),
)) {
  const source = await readFile(path, "utf8");
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const edits = parsed.statements
    .filter(
      (node) =>
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier?.text === "@areal/ui/wip",
    )
    .map((node) => {
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      assert.ok(
        bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)),
        `named bindings required: ${path}`,
      );
      const groups = new Map();
      for (const item of bindings.elements) {
        const symbol = item.propertyName?.text ?? item.name.text;
        const entry = entries.get(symbol);
        assert.ok(entry, `unknown UI symbol ${symbol}: ${path}`);
        groups.set(entry, [...(groups.get(entry) ?? []), item.getText(parsed)]);
      }
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause.isTypeOnly
        : node.isTypeOnly;
      return {
        start: node.getStart(parsed),
        end: node.end,
        replacement: [...groups]
          .map(
            ([entry, symbols]) =>
              `${ts.isImportDeclaration(node) ? "import" : "export"}${typeOnly ? " type" : ""} { ${symbols.join(", ")} } from "@areal/ui${entry === "index" ? "" : `/${entry}`}";`,
          )
          .join("\n"),
      };
    });
  if (edits.length)
    await writeFile(
      path,
      edits
        .reverse()
        .reduce(
          (text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end),
          source,
        ),
    );
}
