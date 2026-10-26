import assert from "node:assert/strict";
import { test } from "node:test";
import { areasForPaths, smokeMatrix } from "./test-manifest.mjs";

const manifest = [
  { script: "test:composer", layer: "e2e", areas: ["composer"], ciSmoke: "composer" },
  { script: "test:history", layer: "e2e", areas: ["history"], ciSmoke: "history" },
];

test("known source areas select existing smoke registrations", () => {
  const areas = areasForPaths(["clients/gui/renderer/src/composer/Composer.tsx"]);
  assert.deepEqual(smokeMatrix(manifest, areas), {
    include: [{ scenario: "composer", script: "test:composer" }],
  });
});

test("shared and unknown source paths preserve the complete smoke matrix", () => {
  for (const path of [
    "core/engine/src/lib.rs",
    "clients/gui/app/src/core/new-owner.cjs",
    "clients/gui/scripts/changed.mjs",
  ]) {
    assert.equal(smokeMatrix(manifest, areasForPaths([path])).include.length, 2);
  }
});

test("an unmatched registered area falls back to full smoke coverage", () => {
  assert.equal(smokeMatrix(manifest, ["design"]).include.length, 2);
});

test("partially covered areas retain every smoke instead of dropping the uncovered area", () => {
  assert.equal(smokeMatrix(manifest, ["composer", "desktop"]).include.length, 2);
});
