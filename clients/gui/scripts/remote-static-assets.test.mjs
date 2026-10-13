import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteStaticAssets } from "./remote-static-assets.mjs";

function bundle() {
  return {
    "remote.html": {
      type: "asset",
      source:
        '<html><head><script type="module" src="./assets/remote.js"></script><link rel="modulepreload" href="./assets/shared.js"></head></html>',
    },
    "assets/remote.js": {
      type: "chunk",
      code: 'import("./lazy.js")',
      imports: ["assets/shared.js"],
      dynamicImports: ["assets/lazy.js"],
      referencedFiles: [],
      viteMetadata: { importedCss: new Set(["assets/remote.css"]), importedAssets: new Set() },
    },
    "assets/shared.js": {
      type: "chunk",
      code: "export const shared = 1",
      imports: [],
      dynamicImports: [],
    },
    "assets/lazy.js": {
      type: "chunk",
      code: "export const lazy = 1",
      imports: [],
      dynamicImports: [],
      viteMetadata: { importedAssets: new Set(["assets/image.png"]) },
    },
    "assets/remote.css": {
      type: "asset",
      source: '@import "./base.css"; body {background:url("./image.png")}',
    },
    "assets/base.css": { type: "asset", source: "body {margin:0}" },
    "assets/image.png": { type: "asset", source: new Uint8Array([1, 2, 3]) },
    "index.html": { type: "asset", source: '<script src="./assets/desktop.js"></script>' },
    "assets/desktop.js": {
      type: "chunk",
      code: "PRIVATE DESKTOP",
      imports: [],
      dynamicImports: [],
    },
  };
}
test("static descriptor closes only Remote transitive imports, CSS and images with deterministic content hashes", () => {
  const result = remoteStaticAssets(bundle());
  const paths = result.descriptor.assets.map((asset) => asset.path);
  for (const path of [
    "remote.html",
    "assets/remote.js",
    "assets/shared.js",
    "assets/lazy.js",
    "assets/remote.css",
    "assets/base.css",
    "assets/image.png",
    "remote.webmanifest",
  ])
    assert.ok(paths.includes(path), path);
  assert.ok(!paths.includes("index.html"));
  assert.ok(!paths.includes("assets/desktop.js"));
  assert.equal(result.descriptor.version, remoteStaticAssets(bundle()).descriptor.version);
  const changed = bundle();
  changed["assets/lazy.js"].code = "export const lazy = 2";
  assert.notEqual(result.descriptor.version, remoteStaticAssets(changed).descriptor.version);
  assert.throws(() => remoteStaticAssets({ ...bundle(), "assets/shared.js": undefined }), /缺少/);
});

import vm from "node:vm";
function workerRuntime(result, shared = new Map()) {
  const handlers = new Map(),
    fetched = [];
  const origin = "https://remote.test";
  const caches = {
    open: async (name) => {
      if (!shared.has(name)) shared.set(name, new Map());
      const values = shared.get(name);
      return {
        put: async (key, value) => values.set(key, value.clone()),
        match: async (key) => values.get(key)?.clone(),
      };
    },
    keys: async () => [...shared.keys()],
    delete: async (name) => shared.delete(name),
  };
  const self = {
    location: { origin },
    addEventListener: (event, handler) => handlers.set(event, handler),
  };
  vm.runInNewContext(result.files.get("remote-sw.js").toString(), {
    self,
    caches,
    URL,
    crypto,
    fetch: async (url) => {
      fetched.push(url);
      const path = new URL(url).pathname.slice(1);
      const response = new Response(result.files.get(path), { status: 200 });
      Object.defineProperty(response, "url", { value: url });
      return response;
    },
  });
  return {
    fetched,
    caches: shared,
    run: async (event) => {
      let work;
      handlers.get(event)({
        waitUntil: (value) => {
          work = value;
        },
      });
      await work;
    },
    request: async (path, method = "GET", mode = "cors") => {
      let work;
      handlers.get("fetch")({
        request: { url: new URL(path, origin).href, method, mode },
        respondWith: (value) => {
          work = value;
        },
      });
      return work ? await work : undefined;
    },
  };
}
test("worker caches only exact content-versioned static paths and waits for ordinary activation", async () => {
  const result = remoteStaticAssets(bundle());
  const runtime = workerRuntime(result);
  await runtime.run("install");
  assert.deepEqual(
    runtime.fetched.map((url) => new URL(url).pathname.slice(1)).sort(),
    result.descriptor.assets.map((item) => item.path).sort(),
  );
  for (const path of [
    "/remote.html?invite=secret",
    "/api/sessions",
    "/remote/socket",
    "/artifact/image.png",
    "https://other.test/remote.html",
    "/health",
    "/remote-sw.js",
  ])
    assert.equal(await runtime.request(path), undefined, path);
  assert.equal(await runtime.request("/remote.html", "POST"), undefined);
  assert.equal(
    await (await runtime.request("/", "GET", "navigate")).text(),
    result.files.get("remote.html").toString(),
  );
  assert.equal(runtime.fetched.length, result.descriptor.assets.length);
  assert.doesNotMatch(result.files.get("remote-sw.js").toString(), /skipWaiting|clients\.claim/);
  const caches = runtime.caches;
  caches.set("another-app-v1", new Map());
  caches.set("areal-remote-shell:old-version", new Map());
  await runtime.run("activate");
  assert.ok(caches.has("another-app-v1"));
  assert.ok(!caches.has("areal-remote-shell:old-version"));
});
