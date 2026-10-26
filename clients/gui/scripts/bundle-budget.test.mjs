import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectBundle, compareBudget } from "./bundle-budget.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "areal-bundle-budget-"));
  const chunks = {
    "assets/main-a.js": {
      name: "main",
      code: "import './shared-b.js';import('./editor-c.js');",
      imports: ["assets/shared-b.js"],
      dynamicImports: ["assets/editor-c.js"],
      modules: ["/src/main.tsx"],
    },
    "assets/shared-b.js": {
      name: "shared",
      code: "export const shared=1;",
      imports: [],
      dynamicImports: [],
      modules: ["/src/shared.ts"],
    },
    "assets/editor-c.js": {
      name: "editor",
      code: "export const editor=2;",
      imports: [],
      dynamicImports: [],
      modules: ["/node_modules/editor/index.js"],
    },
    "assets/preload-d.js": {
      name: "preload",
      code: "export const preload=3;",
      imports: [],
      dynamicImports: [],
      modules: ["/src/preload.ts"],
    },
  };
  await mkdir(join(root, "assets"));
  await Promise.all(
    Object.entries(chunks).map(([file, chunk]) => writeFile(join(root, file), chunk.code)),
  );
  await writeFile(
    join(root, "index.html"),
    '<script type="module" src="./assets/main-a.js"></script><link rel="modulepreload" href="./assets/preload-d.js">',
  );
  await writeFile(
    join(root, "remote.html"),
    '<script type="module" src="./assets/shared-b.js"></script>',
  );
  await writeFile(
    join(root, "bundle-analysis.json"),
    JSON.stringify({
      schemaVersion: 1,
      chunks: Object.fromEntries(
        Object.entries(chunks).map(([file, chunk]) => [
          file,
          {
            ...chunk,
            code: undefined,
            sha256: createHash("sha256").update(chunk.code).digest("hex"),
          },
        ]),
      ),
    }),
  );
  try {
    await run(root, chunks);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("initial bytes include shared imports and HTML preloads, excluding lazy chunks", async () => {
  await fixture(async (root, chunks) => {
    const report = await inspectBundle(root);
    assert.deepEqual(report.entries["index.html"].files, [
      "assets/main-a.js",
      "assets/preload-d.js",
      "assets/shared-b.js",
    ]);
    assert.equal(
      report.entries["index.html"].jsBytes,
      Buffer.byteLength(
        chunks["assets/main-a.js"].code +
          chunks["assets/shared-b.js"].code +
          chunks["assets/preload-d.js"].code,
      ),
    );
    assert.deepEqual(report.entries["remote.html"].modules, ["/src/shared.ts"]);
    assert.deepEqual(report.lazyChunks, {
      editor: Buffer.byteLength(chunks["assets/editor-c.js"].code),
    });
    assert.equal(
      report.totalJsBytes,
      Object.values(chunks).reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0),
    );
  });
});

test("budget reports total, entry, named lazy chunk and forbidden initial module violations", async () => {
  await fixture(async (root) => {
    const report = await inspectBundle(root);
    const failures = compareBudget(report, {
      totalJsBytes: 1,
      entries: { "index.html": 1 },
      lazyChunks: { editor: 1 },
      forbiddenInitialModules: ["/src/shared.ts"],
    });
    assert.ok(failures.some((value) => value.includes("totalJsBytes")));
    assert.ok(failures.some((value) => value.includes("index.html")));
    assert.ok(failures.some((value) => value.includes("editor")));
    assert.ok(failures.some((value) => value.includes("/src/shared.ts")));
    assert.deepEqual(
      compareBudget(report, {
        totalJsBytes: report.totalJsBytes,
        entries: Object.fromEntries(
          Object.entries(report.entries).map(([name, entry]) => [name, entry.jsBytes]),
        ),
        lazyChunks: report.lazyChunks,
        forbiddenInitialModules: [],
      }),
      [],
    );
  });
});

test("new HTML entries and lazy chunk names require an explicit reviewed budget", async () => {
  await fixture(async (root) => {
    const failures = compareBudget(await inspectBundle(root), {
      totalJsBytes: 1_000_000,
      entries: {},
      lazyChunks: {},
      forbiddenInitialModules: [],
    });
    assert.ok(failures.some((value) => value.includes("unbudgeted entry index.html")));
    assert.ok(failures.some((value) => value.includes("unbudgeted lazy chunk editor")));
  });
});

test("stale analysis and missing initial chunks fail instead of measuring incomplete work", async () => {
  await fixture(async (root) => {
    await writeFile(join(root, "assets/main-a.js"), "changed");
    await assert.rejects(inspectBundle(root), /stale.*main-a.js/);
  });
  await fixture(async (root) => {
    await writeFile(join(root, "index.html"), '<script type="module" src="./missing.js"></script>');
    await assert.rejects(inspectBundle(root), /missing.*missing.js/);
  });
});
