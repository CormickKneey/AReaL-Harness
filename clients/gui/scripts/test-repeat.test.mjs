import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeRepeats } from "./repeat-tests.mjs";

const entries = [{ script: "test:journey", qualificationJourney: "startup-recovery" }];
const runs = (count, status = "passed") =>
  Array.from({ length: count }, (_, index) => ({
    script: "test:journey",
    iteration: index + 1,
    status,
    elapsedMs: 1,
  }));

test("qualification requires every planned first attempt and the minimum sample", () => {
  assert.equal(
    summarizeRepeats(entries, runs(10), 10, "linux").tests[0].eligibleForRequiredCi,
    true,
  );
  assert.equal(
    summarizeRepeats(entries, runs(9), 10, "linux").tests[0].eligibleForRequiredCi,
    false,
  );
  assert.equal(
    summarizeRepeats(entries, runs(5), 5, "linux").tests[0].eligibleForRequiredCi,
    false,
  );
});

test("failed and blocked attempts never become passing retries", () => {
  for (const status of ["failed", "blocked"]) {
    const report = summarizeRepeats(
      entries,
      [...runs(9), { script: "test:journey", iteration: 10, status }],
      10,
      "linux",
    );
    assert.equal(report.tests[0].passRate, 0.9);
    assert.equal(report.tests[0].eligibleForRequiredCi, false);
    assert.equal(report.passed, false);
  }
});

test("macOS flake reports preserve failures without marking blocked runs flaky", () => {
  const failed = summarizeRepeats(
    entries,
    [...runs(4), { script: "test:journey", iteration: 5, status: "failed" }],
    5,
    "darwin",
  );
  assert.deepEqual(failed.flakyCandidates, ["test:journey"]);
  assert.equal(
    summarizeRepeats(entries, runs(5, "blocked"), 5, "darwin").flakyCandidates.length,
    0,
  );
});

test("duplicate attempts are rejected rather than inflating the sample", () => {
  assert.throws(
    () => summarizeRepeats(entries, [...runs(10), ...runs(1)], 10, "linux"),
    /duplicate/i,
  );
});
