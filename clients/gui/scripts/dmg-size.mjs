import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DMG_MAX_BYTES = 250 * 1024 * 1024;

export async function checkDmgSize(path) {
  const info = await stat(path);
  assert.ok(info.isFile() && info.size > 0, `DMG must be a nonempty file: ${path}`);
  assert.ok(info.size <= DMG_MAX_BYTES,
    `DMG exceeds 250 MiB (${DMG_MAX_BYTES} bytes): ${path} is ${info.size} bytes (${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
  return { path, bytes: info.size, maxBytes: DMG_MAX_BYTES };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length > 2, "Usage: node clients/gui/scripts/dmg-size.mjs file.dmg [...]");
    for (const path of process.argv.slice(2)) console.log(JSON.stringify(await checkDmgSize(path)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
