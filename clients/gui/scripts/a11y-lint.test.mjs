import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./support/temp.mjs";
import { runA11yLint } from "./a11y-lint.mjs";

test("native JSX accessibility checks reject unnamed images and pointer-only actions", async () => {
  const scratch = await makeTempDir("areal-a11y-lint-");
  const file = join(scratch, "fixture.tsx");
  try {
    await writeFile(
      file,
      'export const View = () => <div onClick={() => {}}><img src="icon.png"/><label>Name</label></div>;',
    );
    const failures = await runA11yLint([file]);
    for (const rule of [
      "alt-text",
      "click-events-have-key-events",
      "no-static-element-interactions",
      "label-has-associated-control",
    ])
      assert.ok(
        failures.some((finding) => finding.rule === `jsx-a11y(${rule})`),
        rule,
      );
    await writeFile(
      file,
      'export const View = () => <button type="button"><img alt="" src="icon.png"/>Open</button>;',
    );
    assert.deepEqual(await runA11yLint([file]), []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
