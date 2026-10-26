import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const ts = require("typescript");
const temporaryPath = /^\/(?:private\/tmp|var\/folders)(?:\/|$)/;

export async function auditPlatformPaths(root) {
  const scriptsRoot = resolve(root, "scripts");
  const packageScripts = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).scripts;
  const pending = Object.entries(packageScripts)
    .filter(([name]) => name.startsWith("test:"))
    .flatMap(([, command]) =>
      [...command.matchAll(/(?:[\w.-]+\/)*scripts\/[\w./-]+\.(?:mjs|cjs|js)\b/g)].map((match) =>
        resolve(root, match[0]),
      ),
    );
  const visited = new Set();
  const violations = [];
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path) || !path.startsWith(`${scriptsRoot}${sep}`)) continue;
    visited.add(path);
    const text = await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT" || error.code === "EISDIR") return null;
      throw error;
    });
    if (text === null) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const value = ts.isStringLiteralLike(node)
        ? node.text
        : ts.isTemplateExpression(node)
          ? node.head.text
          : undefined;
      if (value && temporaryPath.test(value)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({ file: relative(root, path), line: position.line + 1, value });
      }
      const imported =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                node.expression.getText(source) === "require")
            ? node.arguments[0]
            : undefined;
      if (imported && ts.isStringLiteralLike(imported) && imported.text.startsWith("."))
        pending.push(resolve(dirname(path), imported.text));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}
