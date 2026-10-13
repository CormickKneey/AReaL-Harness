import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { extname } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const mime = (path) =>
  ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
  })[extname(path)] ?? "application/octet-stream";

// 小图标在构建时确定性生成，不依赖平台字体或外部图片服务。
function icon(size) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = x / size,
        ny = y / size;
      const edge = 0.12 + (ny - 0.23) * 0.4;
      const mark =
        ny > 0.23 &&
        ny < 0.78 &&
        (Math.abs(Math.abs(nx - 0.5) - edge) < 0.045 ||
          (ny > 0.54 && ny < 0.62 && Math.abs(nx - 0.5) < edge));
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      pixels.set(mark ? [255, 255, 255] : [32, 32, 32], offset);
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function referencedPath(reference, from) {
  if (reference.startsWith("data:") || reference.startsWith("#")) return null;
  const url = new URL(reference, `https://remote.invalid/${from}`);
  if (
    url.origin !== "https://remote.invalid" ||
    url.search ||
    !/^\/[A-Za-z0-9_./-]+$/.test(url.pathname)
  )
    throw new Error(`Remote 静态依赖必须是无查询参数的本站路径：${reference}`);
  return url.pathname.slice(1);
}
function textDependencies(source, path) {
  const refs = [];
  if (path.endsWith(".html")) {
    for (const tag of source.matchAll(/<(?:script|link|img|source)\b[^>]*>/gi))
      for (const attr of tag[0].matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi))
        refs.push(attr[1]);
  }
  if (path.endsWith(".css") || path.endsWith(".html")) {
    for (const match of source.matchAll(
      /url\(\s*["']?([^"')\s]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi,
    ))
      refs.push(match[1] ?? match[2]);
  }
  return refs.map((ref) => referencedPath(ref, path)).filter(Boolean);
}

export function remoteStaticAssets(bundle) {
  if (!bundle["remote.html"]) throw new Error("缺少 Remote HTML 入口");
  const manifest = {
    id: "/remote.html",
    name: "AReaL Remote",
    short_name: "AReaL",
    lang: "zh",
    start_url: "/remote.html",
    scope: "/",
    display: "standalone",
    background_color: "#f7f7f7",
    theme_color: "#202020",
    icons: [192, 512].map((size) => ({
      src: `/remote-icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    })),
  };
  const extra = {
    "remote.webmanifest": { type: "asset", source: JSON.stringify(manifest) },
    "remote-icon-192.png": { type: "asset", source: icon(192) },
    "remote-icon-512.png": { type: "asset", source: icon(512) },
  };
  const html = String(bundle["remote.html"].source).replace(
    "</head>",
    '<link rel="manifest" href="./remote.webmanifest"><link rel="apple-touch-icon" href="./remote-icon-192.png"></head>',
  );
  const graph = { ...bundle, ...extra, "remote.html": { ...bundle["remote.html"], source: html } };
  const files = new Map();
  const visit = (path) => {
    if (files.has(path)) return;
    const item = graph[path];
    if (!item) throw new Error(`Remote 静态闭包缺少资源：${path}`);
    const content = Buffer.from(item.type === "chunk" ? item.code : item.source);
    files.set(path, content);
    const dependencies =
      item.type === "chunk"
        ? [
            ...(item.imports ?? []),
            ...(item.dynamicImports ?? []),
            ...(item.referencedFiles ?? []),
            ...(item.viteMetadata?.importedCss ?? []),
            ...(item.viteMetadata?.importedAssets ?? []),
          ]
        : textDependencies(content.toString(), path);
    for (const dependency of dependencies) visit(dependency);
  };
  visit("remote.html");
  for (const path of Object.keys(extra)) visit(path);
  const assets = [...files]
    .map(([path, content]) => ({ path, mime: mime(path), sha256: hash(content) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const version = hash(JSON.stringify(assets));
  const worker = Buffer.from(
    `(${remoteWorker.toString()})(${JSON.stringify({ version, assets })});\n`,
  );
  files.set("remote-sw.js", worker);
  const descriptor = {
    schema: 1,
    version,
    entry: "remote.html",
    assets,
    worker: { path: "remote-sw.js", mime: mime("remote-sw.js"), sha256: hash(worker) },
  };
  files.set("remote-assets.json", Buffer.from(JSON.stringify(descriptor, null, 2) + "\n"));
  return { files, descriptor };
}

// 此函数按构建产物序列化为独立 Worker；不读取页面身份或业务存储。
function remoteWorker({ version, assets }) {
  const prefix = "areal-remote-shell:";
  const name = prefix + version;
  const paths = new Map(assets.map((asset) => ["/" + asset.path, asset]));
  async function verified(asset) {
    const url = new URL("/" + asset.path, self.location.origin).href;
    const response = await fetch(url, { cache: "reload", credentials: "omit", redirect: "error" });
    if (
      response.status !== 200 ||
      response.type === "opaque" ||
      response.redirected ||
      response.url !== url
    )
      throw new Error("Remote static response is not an exact local asset");
    const bytes = await response.clone().arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== asset.sha256) throw new Error("Remote static version mismatch");
    return response;
  }
  self.addEventListener("install", (event) => {
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(name);
          for (const asset of assets) {
            const response = await verified(asset);
            await cache.put(new URL("/" + asset.path, self.location.origin).href, response);
          }
        } catch (error) {
          await caches.delete(name);
          throw error;
        }
      })(),
    );
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        for (const key of await caches.keys())
          if (key.startsWith(prefix) && key !== name) await caches.delete(key);
      })(),
    );
  });
  self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin || url.search) return;
    const path =
      url.pathname === "/" && request.mode === "navigate" ? "/remote.html" : url.pathname;
    const asset = paths.get(path);
    if (!asset) return;
    event.respondWith(
      (async () => {
        const cache = await caches.open(name);
        const key = new URL(path, self.location.origin).href;
        const cached = await cache.match(key);
        if (cached) return cached;
        const response = await verified(asset);
        await cache.put(key, response.clone());
        return response;
      })(),
    );
  });
}
