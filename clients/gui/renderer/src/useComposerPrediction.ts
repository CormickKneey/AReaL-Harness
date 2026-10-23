import { useEffect, useRef } from "react";
import type { Action, Data } from "./services.js";

export function useComposerPrediction({ project, thread, action, enabled, eligible }: {
  project: Data; thread?: Data; action: Action; enabled: boolean; eligible: boolean;
}): string | undefined {
  const attempted = useRef(new Set<string>());
  const turn = thread?.turns?.at(-1);
  const sourceTurnId = turn?.status === "completed" ? turn.id : undefined;
  const threadId = thread?.id;
  const revision = project.configurations?.[threadId]?.revision ?? thread?.desktop?.configuration?.revision;
  const slot = thread?.desktop?.promptPrediction;
  const current = slot?.sourceTurnId === sourceTurnId && slot?.configurationRevision === revision;
  const supported = project.core?.features?.promptPrediction === true && project.state?.connected === true;
  const key = `${project.core?.instanceId}:${project.id}:${threadId}:${sourceTurnId}:${revision}`;
  const request = useRef(action);
  request.current = action;
  useEffect(() => {
    if (!supported || !threadId || !sourceTurnId) return;
    if (!enabled) return;
    if (!eligible || current || attempted.current.has(key)) return;
    attempted.current.add(key);
    void request.current("prediction", { projectId: project.id, threadId, sourceTurnId, operation: "request" }).catch(() => {});
  }, [supported, enabled, eligible, current, slot?.status, key, project.id, threadId, sourceTurnId]);
  return enabled && supported && eligible && current && slot.status === "ready" ? slot.text : undefined;
}
