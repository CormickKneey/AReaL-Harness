import { useEffect, useRef, useState } from "react";
import type { Action, Snapshot } from "../services.js";
import type { BackendStatusAction } from "../BackendStatusNotice.js";

export function useBackendRecovery(
  snapshot: Snapshot,
  resourceAction: Action,
  reconnectService: () => Promise<void>,
  onStatus: () => void,
) {
  const backendActionInFlight = useRef(false);
  const [backendActionPending, setBackendActionPending] = useState(false);
  const [backendActionError, setBackendActionError] = useState("");
  useEffect(() => {
    setBackendActionError("");
  }, [
    snapshot.connection?.state,
    snapshot.connection?.message,
    snapshot.connection?.recovery,
    snapshot.backendUpdate?.state,
    snapshot.backendUpdate?.message,
    snapshot.desktopCapabilities?.currentCommands,
    snapshot.lifecycle?.phase,
    snapshot.lifecycle?.message,
  ]);
  const runBackendAction = async (kind: BackendStatusAction) => {
    if (backendActionInFlight.current) return;
    backendActionInFlight.current = true;
    setBackendActionPending(true);
    setBackendActionError("");
    try {
      if (kind === "status") {
        onStatus();
      } else if (kind === "update") {
        await resourceAction("serviceLifecycle", { operation: "update" });
      } else if (kind === "recover") {
        const result = await resourceAction("serviceLifecycle", { operation: "recover" });
        if ("recovered" in result && result.recovered) await reconnectService();
      } else if (kind === "check") {
        await resourceAction("serviceLifecycle", { operation: "check" });
      } else {
        await reconnectService();
      }
    } catch (cause) {
      setBackendActionError((cause as Error).message);
    } finally {
      backendActionInFlight.current = false;
      setBackendActionPending(false);
    }
  };
  const quitStartup = async () => {
    if (backendActionInFlight.current) return;
    backendActionInFlight.current = true;
    setBackendActionPending(true);
    try {
      await resourceAction("serviceLifecycle", { operation: "quitInterface" });
    } catch (cause) {
      setBackendActionError((cause as Error).message);
    } finally {
      backendActionInFlight.current = false;
      setBackendActionPending(false);
    }
  };
  return { backendActionPending, backendActionError, runBackendAction, quitStartup };
}
