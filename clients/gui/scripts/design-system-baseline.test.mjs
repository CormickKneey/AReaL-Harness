import test from "node:test";
import assert from "node:assert/strict";
import { renderLiteralBaseline, validateLiteralExceptions } from "./design-system-baseline.mjs";

const findings = [
  { file: "renderer/src/chart.css", finding: "literal color: background: #123456", occurrence: 1 },
  { file: "renderer/src/chart.css", finding: "literal color: background: #123456", occurrence: 2 },
];
const exceptions = findings.map((finding) => ({
  ...finding,
  reason: "The heatmap encodes data intensity using a fixed series color.",
  exitCondition: "Move this series into the chart palette when its owner is centralized.",
}));

test("baseline refresh preserves reviewed reasons and existing metadata", () => {
  const baseline = {
    $description: "existing baseline",
    total: { color: 4 },
    files: { "renderer/src/chart.css": { color: 4 } },
    exceptions,
    source: { commit: "captured-source" },
  };
  const output = renderLiteralBaseline(findings, baseline);
  assert.deepEqual(output.exceptions, exceptions);
  assert.deepEqual(output.source, baseline.source);
  assert.equal(output.$description, baseline.$description);
  assert.deepEqual(output.total, { color: 2 });
  assert.deepEqual(output.files, { "renderer/src/chart.css": { color: 2 } });
  assert.equal(baseline.total.color, 4);
});

test("each retained literal occurrence needs its own reason", () => {
  assert.throws(
    () => validateLiteralExceptions(findings, undefined),
    /exceptions must be an array/,
  );
  assert.throws(
    () => validateLiteralExceptions(findings, exceptions.slice(0, 1)),
    /missing literal exception/,
  );
  assert.throws(
    () => renderLiteralBaseline(findings, { exceptions: exceptions.slice(0, 1) }),
    /missing literal exception/,
  );
});

test("stale and duplicate exception identities are rejected before a baseline write", () => {
  assert.throws(
    () => renderLiteralBaseline(findings.slice(0, 1), { exceptions }),
    /stale literal exception/,
  );
  assert.throws(
    () => validateLiteralExceptions(findings, [exceptions[0], exceptions[0]]),
    /duplicate literal exception/,
  );
  assert.throws(
    () =>
      validateLiteralExceptions(findings, [
        { ...exceptions[0], file: "renderer/src/moved.css" },
        exceptions[1],
      ]),
    /stale literal exception/,
  );
});

test("exception reasons and exit conditions cannot be blank", () => {
  for (const key of ["reason", "exitCondition"]) {
    assert.throws(
      () => validateLiteralExceptions(findings, [{ ...exceptions[0], [key]: " " }, exceptions[1]]),
      /nonempty/,
    );
  }
  assert.throws(
    () => validateLiteralExceptions(findings, [{ ...exceptions[0], occurrence: 0 }, exceptions[1]]),
    /positive integer/,
  );
});
