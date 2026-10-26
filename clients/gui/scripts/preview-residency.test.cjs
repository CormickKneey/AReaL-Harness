"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isPinned, reserveDecision } = require("../app/src/core/preview-residency.cjs");
const page = () => ({
  view: {},
  control: "human",
  plans: new Map(),
  inputPending: new Set(),
  heldButtons: new Set(),
  heldKeys: new Set(),
});

test("residency refuses workspace overflow before considering eviction", () => {
  assert.deepEqual(reserveDecision([], { workspacePageCount: 4, replacing: false }), {
    kind: "workspaceFull",
  });
  assert.deepEqual(reserveDecision([], { workspacePageCount: 4, replacing: true }), {
    kind: "available",
  });
});

test("residency retains every page with active authority, work or user presentation", () => {
  for (const field of [
    "crashed",
    "requestedVisible",
    "annotationCaptureId",
    "styleTrial",
    "activeAction",
    "activeRead",
    "activeSelection",
    "activePrepare",
    "claiming",
    "dialogPending",
    "fileHandoff",
  ])
    assert.ok(isPinned({ ...page(), [field]: true }), field);
  for (const field of ["plans", "inputPending", "heldButtons", "heldKeys", "downloads"])
    assert.ok(isPinned({ ...page(), [field]: new Set(["pending"]) }), field);
  assert.ok(isPinned({ ...page(), control: "agent" }));
  assert.ok(isPinned({ ...page(), view: null }));
  assert.equal(isPinned(page()), false);
});

test("residency evicts first idle native page and excludes the replacement", () => {
  const pages = Array.from({ length: 8 }, page);
  pages[0].control = "agent";
  const decision = reserveDecision(pages, { workspacePageCount: 1, replacing: false });
  assert.equal(decision.kind, "evict");
  assert.equal(decision.page, pages[1]);
  assert.deepEqual(
    reserveDecision(pages, { workspacePageCount: 1, replacing: true, excluded: pages[1] }),
    { kind: "available" },
  );
  pages.forEach((item) => {
    item.control = "agent";
  });
  assert.deepEqual(reserveDecision(pages, { workspacePageCount: 1, replacing: false }), {
    kind: "allPinned",
  });
});
