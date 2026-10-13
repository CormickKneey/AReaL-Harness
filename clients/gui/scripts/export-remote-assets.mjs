import { readFile, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// 从已构建清单复制闭包；不扫描 Desktop dist，也不合并进已有发布目录。
export async function exportRemoteAssets(source, destination) {
  const root = await realpath(source);
  const descriptorBytes = await readFile(join(root, "remote-assets.json"));
  const descriptor = JSON.parse(descriptorBytes);
  if (
    descriptor.schema !== 1 ||
    descriptor.entry !== "remote.html" ||
    !Array.isArray(descriptor.assets) ||
    descriptor.worker?.path !== "remote-sw.js"
  )
    throw new Error("Remote 静态清单无效");
  const files = new Map();
  for (const asset of [...descriptor.assets, descriptor.worker]) {
    if (
      !asset ||
      typeof asset.path !== "string" ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$/.test(asset.path) ||
      asset.path.split("/").some((part) => part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      files.has(asset.path) ||
      ["index.html", "remote-assets.json"].includes(asset.path)
    )
      throw new Error("Remote 静态资源无效");
    const path = await realpath(join(root, asset.path));
    if (!path.startsWith(root + sep)) throw new Error("Remote 静态资源越界");
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error("Remote 静态资源版本不一致");
    files.set(asset.path, bytes);
  }
  if (!files.has("remote.html")) throw new Error("Remote 静态入口缺失");
  files.set("remote-assets.json", descriptorBytes);
  await mkdir(destination);
  try {
    for (const [path, bytes] of files) {
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return { files: files.size, version: descriptor.version };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error("用法: export-remote-assets <GUI dist> <新的 Remote 输出目录>");
  console.log(JSON.stringify(await exportRemoteAssets(source, destination)));
}
