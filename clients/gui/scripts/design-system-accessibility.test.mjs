import test from "node:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  summarizeAxe,
  assertAccessibleReport,
} from "./design-system-accessibility.mjs";

test("contrast uses resolved opaque pixels and rejects unreadable text", () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]), 1);
  assert.ok(contrastRatio([120, 120, 120], [255, 255, 255]) < 4.5);
});

test("axe reports group each affected target and block serious or critical rules", () => {
  const result = summarizeAxe({
    violations: [
      {
        id: "button-name",
        impact: "critical",
        help: "Name",
        nodes: [{ target: ["#button"], html: "<button>" }],
      },
      {
        id: "region",
        impact: "moderate",
        help: "Region",
        nodes: [{ target: ["main"], html: "<main>" }],
      },
    ],
    incomplete: [{ id: "color-contrast", nodes: [{ target: ["#alpha"] }] }],
  });
  assert.equal(result.blocking.length, 1);
  assert.equal(result.moderate, 1);
  assert.equal(result.incomplete[0].targets[0][0], "#alpha");
  assert.equal(result.violations[0].targets[0][0], "#button");
});

test("the accessibility gate rejects serious DOM and default contrast failures", () => {
  const report = { scans: [{ blocking: [], moderate: 0 }], contrast: { defaultFailures: 0 } };
  assert.doesNotThrow(() => assertAccessibleReport(report));
  assert.throws(
    () =>
      assertAccessibleReport({
        ...report,
        scans: [{ blocking: [{ targets: [["#send"]] }], moderate: 0 }],
      }),
    /serious or critical/,
  );
  assert.throws(
    () => assertAccessibleReport({ ...report, contrast: { defaultFailures: 1 } }),
    /default theme contrast/,
  );
  assert.throws(() => assertAccessibleReport({ ...report, scans: [] }), /mounted previews/);
  assert.throws(
    () => assertAccessibleReport({ ...report, scans: [{ blocking: [], moderate: 1 }] }),
    /moderate.*baseline/,
  );
});
