import { createHash } from "node:crypto";

export function bundleAnalysis() {
  return {
    name: "areal-bundle-analysis",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const chunks = Object.fromEntries(
          Object.entries(bundle)
            .filter(([, output]) => output.type === "chunk")
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([file, chunk]) => [
              file,
              {
                name: chunk.name,
                imports: chunk.imports,
                dynamicImports: chunk.dynamicImports,
                modules: Object.keys(chunk.modules)
                  .map((module) => module.replaceAll("\\", "/").replace(/^.*\/clients\/gui\//, ""))
                  .sort(),
                sha256: createHash("sha256").update(chunk.code).digest("hex"),
              },
            ]),
        );
        this.emitFile({
          type: "asset",
          fileName: "bundle-analysis.json",
          source: JSON.stringify({ schemaVersion: 1, chunks }, null, 2) + "\n",
        });
      },
    },
  };
}
