// 纯字节签名/尺寸契约；浏览器实际解码属于独立验收。
import assert from "node:assert/strict";
import { rasterInfo, RASTER_MAX_BYTES } from "../packages/remote/src/raster.mjs";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
for (const [mime, bytes] of [
  ["image/png", png],
  ["image/gif", gif],
  ["image/webp", webp],
]) {
  assert.deepEqual(rasterInfo(bytes, mime), { mime, width: 1, height: 1 });
  assert.throws(() => rasterInfo(bytes, "image/svg+xml"));
  assert.throws(() => rasterInfo(bytes.subarray(0, -1), mime));
}
const noScan = Buffer.from("ffd8ffc0000b080001000101011100ffd9", "hex");
assert.throws(
  () => rasterInfo(noScan, "image/jpeg"),
  "JPEG without scan must be rejected before decode",
);
for (const [mime, bytes] of [
  ["image/png", Buffer.from(png)],
  ["image/gif", Buffer.from(gif)],
  ["image/webp", Buffer.from(webp)],
]) {
  if (mime === "image/png") {
    bytes.writeUInt32BE(8192, 16);
    bytes.writeUInt32BE(8192, 20);
  }
  if (mime === "image/gif") {
    bytes.writeUInt16LE(8192, 6);
    bytes.writeUInt16LE(8192, 8);
  }
  if (mime === "image/webp") {
    bytes.writeUInt16LE(8192, 26);
    bytes.writeUInt16LE(8192, 28);
  }
  assert.throws(() => rasterInfo(bytes, mime), mime);
}
assert.throws(() => rasterInfo(new Uint8Array(RASTER_MAX_BYTES + 1), "image/png"));
for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"])
  assert.throws(() => rasterInfo(Buffer.from("<html><svg>untrusted</svg></html>"), mime));
console.log(
  "PASS raster signatures, complete envelopes, format-specific dimensions and independent decoded-pixel budgets",
);
