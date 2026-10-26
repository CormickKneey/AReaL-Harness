import { expect, test } from "vite-plus/test";
import { createTaskWorkspace } from "./taskWorkspace.js";

const target = { projectId: "project-a", taskId: "task-a", eventId: "event-a" };

test("global and project catalogs reset the previous reveal target", () => {
  const workspace = createTaskWorkspace();
  workspace.openTarget(target);
  workspace.openCatalog("project-b");
  expect(workspace.getSnapshot()).toEqual({
    surface: "tasks",
    scope: "project-b",
    target: undefined,
  });
  workspace.openTarget(target);
  workspace.openCatalog();
  expect(workspace.getSnapshot()).toEqual({
    surface: "tasks",
    scope: undefined,
    target: undefined,
  });
});

test("resource reveals retain catalog scope while notification targets clear it", () => {
  const workspace = createTaskWorkspace();
  workspace.openCatalog("project-b");
  workspace.revealResource(target);
  expect(workspace.getSnapshot()).toEqual({ surface: "tasks", scope: "project-b", target });
  workspace.openTarget({ ...target, eventId: "event-b" });
  expect(workspace.getSnapshot()).toEqual({
    surface: "tasks",
    scope: undefined,
    target: { ...target, eventId: "event-b" },
  });
});

test("ordinary close retains scope and target but returning to conversation clears target", () => {
  const workspace = createTaskWorkspace();
  workspace.openCatalog("project-b");
  workspace.revealResource(target);
  workspace.close();
  expect(workspace.getSnapshot()).toEqual({ surface: null, scope: "project-b", target });
  workspace.returnToConversation();
  expect(workspace.getSnapshot()).toEqual({ surface: null, scope: "project-b", target: undefined });
});

test("snapshots remain stable between commands and subscriptions are removable", () => {
  const workspace = createTaskWorkspace();
  const initial = workspace.getSnapshot();
  expect(workspace.getSnapshot()).toBe(initial);
  const surfaces: (string | null)[] = [];
  const unsubscribe = workspace.subscribe(() => surfaces.push(workspace.getSnapshot().surface));
  workspace.openCatalog();
  workspace.openTarget(target);
  workspace.close();
  expect(surfaces).toEqual(["tasks", "tasks", null]);
  unsubscribe();
  workspace.openCatalog();
  expect(surfaces).toHaveLength(3);
});

test("consumed resource reveal belongs to one workspace mount and survives closing", () => {
  const workspace = createTaskWorkspace();
  workspace.consumeReveal("one");
  workspace.close();
  expect(workspace.pendingReveal("one")).toBeUndefined();
  expect(workspace.pendingReveal("two")).toBe("two");
  const fresh = createTaskWorkspace();
  expect(fresh.pendingReveal("one")).toBe("one");
  expect(fresh.getSnapshot()).toEqual({ surface: null, scope: undefined, target: undefined });
});
