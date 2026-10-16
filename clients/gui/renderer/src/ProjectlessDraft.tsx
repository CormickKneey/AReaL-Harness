import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.js";
import { DraftComposer } from "./DraftComposer.js";
import type { Action, Data, PlatformServices, Snapshot } from "./services.js";
import { call } from "./services.js";

const key = "areal-gui:draft:projectless:new";
export function ProjectlessDraft({ snapshot, services, action, readAction, onOpen, onPanel }: {
  snapshot: Snapshot; services: PlatformServices; action: Action; readAction?: Action; onOpen: (pid: string, tid: string) => Promise<void>;
  onPanel: (panel: string) => void;
}) {
  const [prepared, setPrepared] = useState<Data>();
  const [error, setError] = useState("");
  const [ownerId, setOwnerId] = useState(() => localStorage.getItem(`${key}:project`));
  const owner = snapshot.projects.find(p => p.id === ownerId) ?? prepared;
  const ready = snapshot.connection?.state === "ready";
  const prepare = async () => {
    let requestId = localStorage.getItem(`${key}:workspace-request`);
    if (!requestId) { requestId = crypto.randomUUID(); localStorage.setItem(`${key}:workspace-request`, requestId); }
    const result = await call(services, "projectless", { operation: "prepare", requestId });
    localStorage.setItem(`${key}:project`, result.projectId); setOwnerId(result.projectId);
    const project = (await services.snapshot()).projects.find(p => p.id === result.projectId);
    if (!project?.state?.connected) throw new Error("项目外任务目录尚未准备好，请重试");
    setPrepared(project); return project;
  };
  useEffect(() => {
    if (ownerId && ready && !owner?.state?.connected) void action("connect", { projectId: ownerId }).catch(cause => setError(cause.message));
  }, [ownerId, ready]);
  useEffect(() => {
    if (!ready || ownerId) return;
    let active = true;
    void prepare().catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [ready, ownerId]);
  const draftOwner = owner ?? { id: "projectless", root: "", profiles: [], models: [], pending: [], state: { connected: false }, outcomes: {} };
  return <>
    {error && <p role="alert">{error}<Button variant="ghost" onClick={() => { setError(""); void prepare().catch(cause => setError(cause.message)); }}>重试准备</Button></p>}
    {!owner && !error && <p role="status">正在准备新会话模型…</p>}
    <DraftComposer project={draftOwner} draftKey={key} prepareProject={prepare} action={action} readAction={readAction} onPanel={onPanel} onOpen={async (pid, tid) => {
      localStorage.removeItem(`${key}:project`); localStorage.removeItem(`${key}:workspace-request`);
      await onOpen(pid, tid);
    }} />
  </>;
}
