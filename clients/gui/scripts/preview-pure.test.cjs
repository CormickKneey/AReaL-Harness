"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { webUrl, observationUrl } = require("../app/src/core/preview/urls.cjs");
const {
  bitmapPoint,
  coordinateTarget,
  boundsWithinWindow,
} = require("../app/src/core/preview/geometry.cjs");
const {
  safeText,
  diagnosticText,
  diagnosticUrl,
} = require("../app/src/core/preview/diagnostics.cjs");
const {
  captureGuardStartScript,
  captureGuardStopScript,
  captureGuardChangedScript,
  clearCaptureGuardScript,
  sensitiveCaptureScript,
} = require("../app/src/core/preview/capture-guard.cjs");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("preview URLs preserve navigation intent and redact observed secrets", () => {
  assert.equal(webUrl(" localhost:3000/path "), "http://localhost:3000/path");
  assert.equal(
    webUrl("example.com/search?q=hello#result"),
    "https://example.com/search?q=hello#result",
  );
  for (const value of [
    "javascript:alert(1)",
    "file:///tmp/private",
    "https://user:pass@example.com/",
  ])
    assert.throws(() => webUrl(value));
  assert.equal(
    observationUrl("https://user:pass@example.com/path?q=private#secret"),
    "https://example.com/path",
  );
});

test("bitmap targets use actual capture scale and preserve plan rounding", () => {
  const capture = { width: 801, height: 601, bitmapWidth: 1600, bitmapHeight: 1200 };
  assert.deepEqual(plain(bitmapPoint(capture, 100, 100)), { x: 50.0625, y: 50.078125 });
  assert.deepEqual(
    plain(
      coordinateTarget(capture, { kind: "drag", fromX: 0, fromY: 0, toX: 100, toY: 100, steps: 4 }),
    ),
    { from: { x: 0, y: 0 }, to: { x: 50.0625, y: 50.078125 }, steps: 4 },
  );
  assert.deepEqual(plain(coordinateTarget(capture, { kind: "clickAt", x: 100, y: 100 })), {
    point: { x: 50.0625, y: 50.078125 },
  });
  for (const point of [
    [-1, 0],
    [1600, 0],
    [0, 1200],
  ])
    assert.throws(() => bitmapPoint(capture, ...point), /target_unavailable/);
  for (const width of [0, -1, Infinity, NaN])
    assert.throws(() => bitmapPoint({ ...capture, width }, 1, 1), /target_unavailable/);
});

test("preview rectangles clip to content and reject invalid boundary input", () => {
  assert.deepEqual(
    plain(boundsWithinWindow({ x: -2, y: 50.6, width: 900, height: 900 }, [800, 600])),
    { x: 0, y: 51, width: 800, height: 549 },
  );
  assert.deepEqual(
    plain(boundsWithinWindow({ x: 900, y: 700, width: 100, height: 100 }, [800, 600])),
    { x: 800, y: 600, width: 0, height: 0 },
  );
  for (const value of [null, {}, { x: 0, y: 0, width: NaN, height: 10 }])
    assert.throws(() => boundsWithinWindow(value, [800, 600]));
});

test("preview diagnostics bound text and redact sensitive markers and private URLs", () => {
  assert.equal(safeText("ordinary title", 8), "ordinary");
  assert.equal(safeText("password value"), "[redacted]");
  assert.equal(diagnosticText("session-id=private"), "[redacted]");
  assert.equal(
    diagnosticText("failed https://example.com/path?q=private#fragment"),
    "failed https://example.com/path",
  );
  assert.equal(
    diagnosticUrl("https://example.com/path?q=private#fragment"),
    "https://example.com/path",
  );
  for (const value of ["https://user:pass@example.com/", "file:///tmp/private", "invalid"])
    assert.equal(diagnosticUrl(value), "[redacted URL]");
});

function guardPage() {
  const observers = [];
  const context = {
    document: { querySelectorAll: () => [] },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.records = [];
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
      takeRecords() {
        return this.records.splice(0);
      }
    },
  };
  return { observers, run: (script) => runInNewContext(script, context) };
}

test("capture guard refuses stale starts and token mismatch and notices queued mutations", () => {
  const page = guardPage();
  assert.equal(page.run(captureGuardStartScript("first", 1)), true);
  assert.equal(page.run(captureGuardStartScript("stale", 1)), false);
  assert.equal(page.run(captureGuardChangedScript("wrong")), true);
  assert.equal(page.run(captureGuardChangedScript("first")), false);
  page.observers[0].records.push({});
  assert.equal(page.run(captureGuardChangedScript("first")), true);
  assert.equal(page.run(captureGuardStopScript("wrong", 1)), true);
  assert.equal(page.run(captureGuardStopScript("first", 1)), true);
  assert.equal(page.observers[0].disconnected, true);
  assert.equal(page.run(captureGuardStartScript("next", 2)), true);
  assert.equal(page.run(captureGuardStopScript("next", 2)), false);
  assert.equal(page.run(captureGuardStartScript("late", 1)), false);
});

test("capture guard replacement disconnects prior observers and clear invalidates active guard", () => {
  const page = guardPage();
  assert.equal(page.run(captureGuardStartScript("first", 1, false)), true);
  assert.equal(page.run(captureGuardStartScript("second", 2, false)), true);
  assert.equal(page.observers[0].disconnected, true);
  page.observers[1].callback();
  assert.equal(page.run(captureGuardStopScript("second", 2)), true);
  assert.equal(page.run(captureGuardStartScript("third", 3)), true);
  assert.equal(page.run(clearCaptureGuardScript), true);
  assert.equal(page.observers[2].disconnected, true);
  assert.equal(page.run(captureGuardChangedScript("third")), true);
});

test("sensitive capture script fails closed when a frame cannot be inspected", () => {
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === "iframe,frame" ? [{ contentDocument: null }] : [],
  };
  assert.equal(runInNewContext(sensitiveCaptureScript(), { document }), true);
  assert.equal(runInNewContext(sensitiveCaptureScript(false), { document }), false);
});
