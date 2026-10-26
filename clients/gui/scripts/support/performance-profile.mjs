import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, readdir, cp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const profilerMarker = "AREAL_PERFORMANCE_COMMIT ";

export function instrumentRenderer(source, ts) {
  const tree = ts.createSourceFile(
    "main.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.equal(tree.parseDiagnostics.length, 0, "Renderer entry must parse before instrumentation");
  const renders = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "render" &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "createRoot"
    )
      renders.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(renders.length, 1, "Expected exactly one createRoot(...).render(...) entry");
  assert.equal(renders[0].arguments.length, 1, "Expected one React root tree");
  assert.ok(!source.includes("AREAL_PERFORMANCE_COMMIT"), "Refuse duplicate instrumentation");
  const argument = renders[0].arguments[0];
  const wrapped = `createElement(Profiler, { id: "workbench", onRender: (id, phase, actualDuration, baseDuration, startTime, commitTime) => console.info(${JSON.stringify(profilerMarker)} + JSON.stringify({ id, phase, actualDuration, baseDuration, startTime, commitTime })) }, ${source.slice(argument.getStart(tree), argument.end)})`;
  return `import { createElement, Profiler } from "react";\n${source.slice(0, argument.getStart(tree))}${wrapped}${source.slice(argument.end)}`;
}

export async function artifactHashes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(
    (
      await Promise.all(
        entries.map(async (entry) => {
          assert.ok(!entry.isSymbolicLink(), "Build artifacts must not contain symbolic links");
          if (entry.isDirectory())
            return Object.entries(await artifactHashes(join(directory, entry.name))).map(
              ([file, sha]) => [`${entry.name}/${file}`, sha],
            );
          return [
            [
              entry.name,
              createHash("sha256")
                .update(await readFile(join(directory, entry.name)))
                .digest("hex"),
            ],
          ];
        }),
      )
    )
      .flat()
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export async function buildProfile(gui, directory, profiling = true) {
  const require = createRequire(join(gui, "renderer/package.json"));
  const ts = require("typescript");
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  await mkdir(directory, { recursive: true });
  const source = await readFile(join(gui, "renderer/src/main.tsx"), "utf8");
  const instrumented = profiling ? instrumentRenderer(source, ts) : source;
  if (profiling) await writeFile(join(directory, "instrumented-main.tsx"), instrumented);
  const output = join(directory, "dist");
  const profile = require.resolve("react-dom/profiling");
  const plugin = {
    name: "areal-acceptance-public-react-profiler",
    enforce: "pre",
    resolveId(id) {
      if (id === "react-dom/client") return profile;
    },
    transform(code, id) {
      if (id.split("?")[0] !== join(gui, "renderer/src/main.tsx")) return;
      assert.equal(code, source, "Renderer entry changed while building the profile artifact");
      return { code: instrumented, map: null };
    },
  };
  const graph = {
    name: "areal-acceptance-module-graph",
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "performance-bundle.json",
        source: JSON.stringify(
          {
            chunks: Object.fromEntries(
              Object.entries(bundle)
                .filter(([, chunk]) => chunk.type === "chunk")
                .map(([file, chunk]) => [
                  file,
                  {
                    isEntry: chunk.isEntry,
                    imports: chunk.imports,
                    dynamicImports: chunk.dynamicImports,
                    modules: Object.keys(chunk.modules).map((id) =>
                      id.replaceAll("\\", "/").replace(/^.*\/clients\/gui\//, ""),
                    ),
                    bytes: Buffer.byteLength(chunk.code),
                  },
                ]),
            ),
          },
          null,
          2,
        ),
      });
    },
  };
  await build({
    root: join(gui, "renderer"),
    configFile: join(gui, "renderer/vite.config.ts"),
    plugins: [...(profiling ? [plugin] : []), graph],
    build: { outDir: output, emptyOutDir: true, manifest: true },
  });
  const hashes = await artifactHashes(output);
  const modules = Object.values(
    JSON.parse(await readFile(join(output, "performance-bundle.json"), "utf8")).chunks,
  ).flatMap((chunk) => chunk.modules);
  assert.equal(
    modules.some((module) => /react-dom.*profiling/.test(module)),
    profiling,
    "Resolve the actual public React DOM profiling implementation only for profiling builds",
  );
  const containsProfiler = (
    await Promise.all(
      Object.keys(hashes)
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFile(join(output, file), "utf8")),
    )
  ).some((code) => code.includes(profilerMarker));
  assert.equal(
    containsProfiler,
    profiling,
    "Only the profiling build contains the public Profiler callback",
  );
  await writeFile(
    join(directory, "build.json"),
    JSON.stringify(
      {
        profiling,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        transformedSha256: createHash("sha256").update(instrumented).digest("hex"),
        reactDomProfiling: profile,
        hashes,
      },
      null,
      2,
    ),
  );
  return output;
}

export async function snapshotApplication(gui, directory, renderer) {
  await mkdir(join(directory, "app"), { recursive: true });
  await mkdir(join(directory, "renderer"));
  await cp(join(gui, "app/src"), join(directory, "app/src"), { recursive: true });
  await cp(join(gui, "app/package.json"), join(directory, "app/package.json"));
  for (const path of ["app/node_modules", "app/assets", "packages", "native"])
    await symlink(join(gui, path), join(directory, path), "dir");
  await symlink(renderer, join(directory, "renderer/dist"), "dir");
  const hashes = await artifactHashes(join(gui, "app/src"));
  assert.deepEqual(
    await artifactHashes(join(directory, "app/src")),
    hashes,
    "Isolated application contains byte-identical product sources",
  );
  return { path: directory, hashes };
}

export async function moduleLoadEvidence(directory, initialResources, firstUse) {
  const graph = JSON.parse(await readFile(join(directory, "performance-bundle.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(directory, ".vite/manifest.json"), "utf8"));
  const entry = Object.values(manifest).find((entry) => entry.src === "index.html");
  assert.ok(entry?.file && graph.chunks[entry.file], "Identify the actual desktop HTML entry");
  const initial = new Set();
  const visit = (file) => {
    if (initial.has(file)) return;
    initial.add(file);
    graph.chunks[file]?.imports.forEach(visit);
  };
  visit(entry.file);
  const requested = (resources, file) =>
    resources.filter((resource) => new URL(resource.name).pathname.endsWith(`/${file}`));
  return {
    entry: entry.file,
    initialJavaScriptBytes: [...initial].reduce(
      (sum, file) => sum + (graph.chunks[file]?.bytes ?? 0),
      0,
    ),
    totalJavaScriptBytes: Object.values(graph.chunks).reduce((sum, chunk) => sum + chunk.bytes, 0),
    heavyChunks: Object.entries(graph.chunks).flatMap(([file, chunk]) => {
      const modules = chunk.modules.filter((module) =>
        /shiki|@streamdown\/mermaid|katex|@codemirror\/|@xterm\/|@pierre\/diffs|lexical|@modelcontextprotocol\//.test(
          module,
        ),
      );
      return modules.length
        ? [
            {
              file,
              bytes: chunk.bytes,
              modules,
              inInitialGraph: initial.has(file),
              initialRequests: requested(initialResources, file),
              firstUseRequests: firstUse.flatMap((observation) =>
                requested(observation.resources, file).map((request) => ({
                  id: observation.id,
                  ...request,
                })),
              ),
            },
          ]
        : [];
    }),
  };
}

export const mainPerformanceBootstrap = `
if (!process.argv.includes('--areal-core-service')) {
  const { app } = require('electron');
  const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let window;
  let inspector;
  app.on('areal-performance-start', (options, reply) => {
    if (window) throw new Error('Performance window already active');
    histogram.enable(); histogram.reset();
    window = { startedAt: Date.now(), started: performance.now(), cpu: process.cpuUsage(), memory: process.memoryUsage() };
    reply({ pid: process.pid, startedAt: window.startedAt });
  });
  app.on('areal-performance-stop', reply => {
    if (!window) throw new Error('Performance window missing');
    histogram.disable();
    reply({ pid: process.pid, startedAt: window.startedAt, finishedAt: Date.now(), durationMs: performance.now() - window.started,
      resolutionMs: 10, samples: histogram.count, p50Ms: histogram.percentile(50) / 1e6,
      p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6,
      cpuMicroseconds: process.cpuUsage(window.cpu), memoryBefore: window.memory, memoryAfter: process.memoryUsage() });
    window = undefined;
  });
  app.on('areal-performance-profile-start', reply => {
    const { Session } = require('node:inspector');
    inspector = new Session(); inspector.connect();
    inspector.post('Profiler.enable', error => {
      if (error) return reply({ error: error.message });
      inspector.post('Profiler.start', error => reply(error ? { error: error.message } : { pid: process.pid }));
    });
  });
  app.on('areal-performance-profile-stop', reply => {
    inspector.post('Profiler.stop', (error, result) => {
      inspector.disconnect(); inspector = undefined;
      reply(error ? { error: error.message } : result);
    });
  });
  app.once('will-quit', () => { histogram.disable(); inspector?.disconnect(); });
}
`;
