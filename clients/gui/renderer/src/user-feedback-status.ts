import { useEffect, useState } from "react";
import type { Action } from "./services.js";

export type FeedbackAvailability = { supported: boolean; enabled: boolean; connected: boolean; opted_in: boolean };
type Store = {
  value: FeedbackAvailability;
  listeners: Set<(value: FeedbackAvailability) => void>;
  epoch: number;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  tick?: () => void;
};
const stores = new WeakMap<Action, Store>();
const disabled: FeedbackAvailability = { supported: false, enabled: false, connected: false, opted_in: true };
export function refreshFeedbackAvailability(action: Action) {
  const store = stores.get(action);
  if (!store?.listeners.size) return Promise.resolve();
  if (!store.pending) {
    const epoch = store.epoch;
    const pending: Promise<void> = action("feedback", { operation: "status" })
      .then((value) => {
        if (epoch !== store.epoch) return;
        if (!value || typeof value.enabled !== "boolean" || typeof value.connected !== "boolean" || typeof value.opted_in !== "boolean")
          throw new Error("评价状态格式无效");
        store.value = { supported: true, enabled: value.enabled, connected: value.connected, opted_in: value.opted_in };
      })
      .catch(() => {
        if (epoch === store.epoch) store.value = disabled;
      })
      .then(() => {
        if (epoch !== store.epoch) return;
        for (const listener of store.listeners) listener(store.value);
      })
      .finally(() => {
        if (store.pending === pending) store.pending = undefined;
      });
    store.pending = pending;
  }
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
      store = { value: disabled, listeners: new Set(), epoch: 0 };
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
        store!.epoch++;
        store!.value = disabled;
        store!.pending = undefined;
        clearTimeout(store!.timer);
        store!.timer = undefined;
        document.removeEventListener("visibilitychange", store!.tick!);
      }
    };
  }, [action, connected]);
  return connected ? value : disabled;
}
