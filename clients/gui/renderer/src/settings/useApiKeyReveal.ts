import { useEffect, useRef, useState } from "react";
import type { Action } from "../services.js";

type RevealState = { kind: "hidden" } | { kind: "loading"; identity: string }
  | { kind: "visible"; identity: string; value: string } | { kind: "failed"; identity: string; message: string };

export function useApiKeyReveal(action: Action, providerId?: string, revision?: string) {
  const identity = JSON.stringify([providerId, revision]);
  const epoch = useRef(0);
  const current = useRef(identity);
  current.current = identity;
  const [state, setState] = useState<RevealState>({ kind: "hidden" });
  const reset = () => { epoch.current++; setState({ kind: "hidden" }); };
  useEffect(() => { reset(); return () => { epoch.current++; }; }, [identity]);
  const active = state.kind !== "hidden" && state.identity === identity ? state : null;
  const toggle = async () => {
    if (active?.kind === "visible" || active?.kind === "loading") { reset(); return; }
    if (!providerId || !revision) return;
    const request = ++epoch.current;
    setState({ kind: "loading", identity });
    try {
      const result = await action("providers", { operation: "revealKey", id: providerId, expectedRevision: revision });
      if (request === epoch.current && current.current === identity) setState({ kind: "visible", identity, value: result.apiKey });
    } catch (error) {
      if (request === epoch.current && current.current === identity) setState({ kind: "failed", identity, message: (error as Error).message });
    }
  };
  return { value: active?.kind === "visible" ? active.value : "", loading: active?.kind === "loading",
    error: active?.kind === "failed" ? active.message : "", reset, toggle };
}
