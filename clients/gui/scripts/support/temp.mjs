import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTempDir(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}
