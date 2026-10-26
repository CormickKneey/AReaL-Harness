import { useState, useSyncExternalStore } from "react";

type TaskTarget = {
  projectId: string;
  taskId: string;
  runId?: string;
  questionId?: string;
  eventId?: string;
};
type TaskView = {
  surface: "tasks" | "inbox" | null;
  scope: string | undefined;
  target: TaskTarget | undefined;
};

export function createTaskWorkspace() {
  let snapshot: TaskView = { surface: null, scope: undefined, target: undefined };
  let consumedReveal: string | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: TaskView) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    getSurface: () => snapshot.surface,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openCatalog: (scope?: string) => publish({ surface: "tasks", scope, target: undefined }),
    openTarget: (target: TaskTarget) => publish({ surface: "tasks", scope: undefined, target }),
    revealResource: (target: TaskTarget) => publish({ ...snapshot, surface: "tasks", target }),
    close: () => publish({ ...snapshot, surface: null }),
    returnToConversation: () => publish({ ...snapshot, surface: null, target: undefined }),
    consumeReveal: (key: string) => {
      consumedReveal = key;
    },
    pendingReveal: (key?: string) => (key !== consumedReveal ? key : undefined),
  };
}

export function useTaskWorkspace() {
  const [workspace] = useState(createTaskWorkspace);
  const surface = useSyncExternalStore(workspace.subscribe, workspace.getSurface);
  return { workspace, surface };
}
