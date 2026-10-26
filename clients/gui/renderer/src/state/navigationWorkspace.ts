import { useState, useSyncExternalStore } from "react";

export function createNavigationWorkspace() {
  let snapshot = { archived: false, searchOpen: false, query: "" };
  const listeners = new Set<() => void>();
  const update = (next: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    getArchived: () => snapshot.archived,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openSearch: () => update({ searchOpen: true }),
    hideSearch: () => update({ searchOpen: false }),
    toggleSearch: () => update({ searchOpen: !snapshot.searchOpen }),
    dismissSearch: () => update({ searchOpen: false, query: "" }),
    search: (query: string) => update({ query }),
    toggleArchive: () => update({ archived: !snapshot.archived }),
  };
}

export function useNavigationWorkspace() {
  const [workspace] = useState(createNavigationWorkspace);
  const archived = useSyncExternalStore(workspace.subscribe, workspace.getArchived);
  return { workspace, archived };
}
