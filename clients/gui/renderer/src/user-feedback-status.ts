import { useEffect, useState } from "react";
import type { Action } from "./services.js";

export type FeedbackAvailability = { enabled: boolean; connected: boolean; opted_in: boolean };
type Store = {
  value: FeedbackAvailability;
  listeners: Set<(value: FeedbackAvailability) => void>;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  tick?: () => void;
};
const stores = new WeakMap<Action, Store>();
const disabled = { enabled: false, connected: false, opted_in: true };
export function refreshFeedbackAvailability(action: Action) {
  const store = stores.get(action);
  if (!store) return Promise.resolve();
  if (!store.pending)
    store.pending = action("feedback", { operation: "status" })
      .then((value) => {
        store.value = value;
      })
      .catch(() => {
        store.value = disabled;
      })
      .then(() => {
        for (const listener of store.listeners) listener(store.value);
      })
      .finally(() => {
        store.pending = undefined;
      });
  return store.pending;
}
export function useFeedbackAvailability(action: Action, connected: boolean) {
  const [value, setValue] = useState<FeedbackAvailability>(disabled);
  useEffect(() => {
    if (!connected) {
      setValue(disabled);
      return;
    }
    let store = stores.get(action);
    if (!store) {
      store = { value: disabled, listeners: new Set() };
      stores.set(action, store);
    }
    store.listeners.add(setValue);
    setValue(store.value);
    store.tick ??= () => {
      if (store!.timer) clearTimeout(store!.timer);
      if (document.visibilityState === "visible") void refreshFeedbackAvailability(action);
      store!.timer = setTimeout(store!.tick!, 15000);
    };
    if (store.listeners.size === 1) {
      store.tick();
      document.addEventListener("visibilitychange", store.tick);
    }
    return () => {
      store!.listeners.delete(setValue);
      if (!store!.listeners.size) {
        clearTimeout(store!.timer);
        store!.timer = undefined;
        document.removeEventListener("visibilitychange", store!.tick!);
      }
    };
  }, [action, connected]);
  return value;
}
