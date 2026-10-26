import assert from "node:assert/strict";
import { appendFile, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

const root = await realpath(process.cwd());
const file = await realpath(resolve(root, process.argv[2]));
const path = relative(root, file);
assert.ok(
  !path.startsWith("..") && path.endsWith(".md"),
  "Read one Markdown document in this trial workspace",
);
assert.ok(process.env.AREAL_DESIGN_READ_LOG, "AREAL_DESIGN_READ_LOG is required");
const text = await readFile(file, "utf8");
const count = process.env.AREAL_DESIGN_TOKENIZER
  ? Number(
      execFileSync(process.env.AREAL_DESIGN_TOKENIZER, [], {
        input: text,
        encoding: "utf8",
      }).trim(),
    )
  : null;
assert.ok(
  count === null || (Number.isSafeInteger(count) && count >= 0),
  "Tokenizer must return one nonnegative integer",
);
await appendFile(
  process.env.AREAL_DESIGN_READ_LOG,
  JSON.stringify({
    path,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    tokens: count,
    tokenizer: process.env.AREAL_DESIGN_TOKENIZER_LABEL ?? null,
  }) + "\n",
);
process.stdout.write(text);
