import { expect, test } from "vite-plus/test";
import { createNavigationWorkspace } from "./navigationWorkspace.js";

test("hiding notification search preserves its query while dismissing clears it", () => {
  const workspace = createNavigationWorkspace();
  workspace.openSearch();
  workspace.search("draft");
  workspace.hideSearch();
  expect(workspace.getSnapshot()).toEqual({ archived: false, searchOpen: false, query: "draft" });
  workspace.toggleSearch();
  expect(workspace.getSnapshot().searchOpen).toBe(true);
  workspace.dismissSearch();
  expect(workspace.getSnapshot()).toEqual({ archived: false, searchOpen: false, query: "" });
});

test("archive selection is independent from search and is window scoped", () => {
  const workspace = createNavigationWorkspace();
  workspace.toggleArchive();
  workspace.search("draft");
  expect(workspace.getArchived()).toBe(true);
  expect(createNavigationWorkspace().getArchived()).toBe(false);
  expect(workspace.getSnapshot()).toBe(workspace.getSnapshot());
});
