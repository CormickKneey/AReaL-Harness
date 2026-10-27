import { useEffect, useState } from "react";
import type { Data } from "./services.js";

/** Keep our configure request distinct until its confirmed projection arrives. */
export function useComposerConfiguration(project: Data, threadId: string, busy: boolean) {
  const [request, setRequest] = useState<{ id: string; revision: number } | null>(null);
  const revision = project.configurations?.[threadId]?.revision;
  useEffect(() => {
    // The RPC reply can precede the projection that removes its pending entry.
    if (
      request &&
      !busy &&
      revision > request.revision &&
      !project.pending.some((entry: Data) => entry.params?.requestId === request.id)
    )
      setRequest(null);
  }, [busy, revision, request, project.pending]);
  return {
    requestId: request?.id,
    begin(revision: number) {
      const id = crypto.randomUUID();
      setRequest({ id, revision });
      return id;
    },
    clear: () => setRequest(null),
  };
}
