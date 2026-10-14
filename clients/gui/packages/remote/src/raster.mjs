// Host 与浏览器各自校验收到的字节；尺寸预算先于任何浏览器解码。
export const RASTER_MAX_BYTES = 16 * 1024 * 1024;
export const RASTER_MAX_PIXELS = 16 * 1024 * 1024;
export function rasterInfo(bytes, mime) {
  const bad = () => {
    throw new Error("图片格式或解码预算不支持，请在桌面查看");
  };
  if (!(bytes instanceof Uint8Array) || bytes.length > RASTER_MAX_BYTES || bytes.length < 12) bad();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  let width, height;
  if (mime === "image/png") {
    if (
      bytes.length < 45 ||
      str(0, 8) !== "\x89PNG\r\n\x1a\n" ||
      v.getUint32(8) !== 13 ||
      str(12, 4) !== "IHDR"
    )
      bad();
    width = v.getUint32(16);
    height = v.getUint32(20);
    let offset = 8,
      data = false,
      ended = false;
    while (offset + 12 <= bytes.length) {
      const n = v.getUint32(offset),
        kind = str(offset + 4, 4);
      if (n > bytes.length - offset - 12 || kind === "acTL") bad();
      if (kind === "IDAT") data = true;
      offset += n + 12;
      if (kind === "IEND") {
        if (n || offset !== bytes.length) bad();
        ended = true;
        break;
      }
    }
    if (!data || !ended) bad();
  } else if (mime === "image/gif") {
    if (!["GIF87a", "GIF89a"].includes(str(0, 6)) || bytes.length < 14 || bytes.at(-1) !== 0x3b)
      bad();
    width = v.getUint16(6, true);
    height = v.getUint16(8, true);
    let at = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0),
      frames = 0;
    const blocks = () => {
      while (at < bytes.length) {
        const n = bytes[at++];
        if (!n) return;
        at += n;
        if (at > bytes.length) bad();
      }
      bad();
    };
    while (at < bytes.length - 1) {
      const kind = bytes[at++];
      if (kind === 0x21) {
        at++;
        blocks();
      } else if (kind === 0x2c) {
        if (++frames > 1 || at + 9 > bytes.length) bad();
        const w = v.getUint16(at + 4, true),
          h = v.getUint16(at + 6, true);
        if (!w || !h || v.getUint16(at, true) + w > width || v.getUint16(at + 2, true) + h > height)
          bad();
        const packed = bytes[at + 8];
        at += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
        at++;
        blocks();
      } else bad();
    }
    if (frames !== 1 || at !== bytes.length - 1) bad();
  } else if (mime === "image/webp") {
    if (str(0, 4) !== "RIFF" || str(8, 4) !== "WEBP" || v.getUint32(4, true) + 8 !== bytes.length)
      bad();
    let at = 12,
      found = false;
    while (at + 8 <= bytes.length) {
      const kind = str(at, 4),
        n = v.getUint32(at + 4, true),
        start = at + 8;
      if (n > bytes.length - start || ["ANIM", "ANMF"].includes(kind)) bad();
      if (kind === "VP8X") {
        if (at !== 12 || found || n !== 10 || bytes[start] & 2) bad();
        width = 1 + bytes[start + 4] + bytes[start + 5] * 256 + bytes[start + 6] * 65536;
        height = 1 + bytes[start + 7] + bytes[start + 8] * 256 + bytes[start + 9] * 65536;
      }
      if (kind === "VP8 " || kind === "VP8L") {
        if (found) bad();
        found = true;
        let w, h;
        if (kind === "VP8 ") {
          if (n < 10 || str(start + 3, 3) !== "\x9d\x01\x2a") bad();
          w = v.getUint16(start + 6, true) & 0x3fff;
          h = v.getUint16(start + 8, true) & 0x3fff;
        } else {
          if (n < 5 || bytes[start] !== 0x2f) bad();
          const bits = v.getUint32(start + 1, true);
          w = (bits & 0x3fff) + 1;
          h = ((bits >>> 14) & 0x3fff) + 1;
        }
        if (width !== undefined && (w !== width || h !== height)) bad();
        width = w;
        height = h;
      }
      at = start + n + (n & 1);
    }
    if (!found || at !== bytes.length) bad();
  } else if (mime === "image/jpeg") {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) bad();
    let at = 2,
      scan = false;
    while (at + 4 < bytes.length) {
      if (bytes[at++] !== 255) bad();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      const n = v.getUint16(at);
      if (n < 2 || at + n > bytes.length - 2) bad();
      if (marker === 0xda) {
        if (n < 6 || at + n >= bytes.length - 2) bad();
        scan = true;
        break;
      }
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (n < 8 || width !== undefined) bad();
        height = v.getUint16(at + 3);
        width = v.getUint16(at + 5);
      }
      at += n;
    }
    if (!scan) bad();
  } else bad();
  if (!width || !height || width > 16384 || height > 16384 || width * height > RASTER_MAX_PIXELS)
    bad();
  return { mime, width, height };
}
