import { useCallback, useEffect, useRef, useState } from "react";
import { Messages } from "./Messages.js";
import type { Action, Data } from "./services.js";

// 旁路草稿和业务键只属于明确来源；关闭面板不会取消已受理的 Turn。
export function SideChatPane({ project, source, action, dark }: {
  project: Data; source: Data; action: Action; dark: boolean;
}) {
  const owner = `${project.id}:${source.id}:side`;
  const draftKey = `areal-gui:side:draft:${owner}`;
  const threadKey = `areal-gui:side:thread:${owner}`;
  const pendingKey = `areal-gui:side:pending:${owner}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [sideId, setSideId] = useState(() => localStorage.getItem(threadKey) ?? "");
  const [pendingId, setPendingId] = useState(() => localStorage.getItem(pendingKey) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  const side = sideId ? project.state?.threads?.[sideId] : undefined;
  const validSide = side?.conversation?.kind === "side" && side.conversation.origin?.sourceThreadId === source.id;
  const active = validSide && side.turns?.some((turn: Data) => turn.status === "inProgress");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string; text: string }>).detail;
      if (detail?.owner !== owner) return;
      const next = localStorage.getItem(draftKey) ?? detail.text;
      setText(next);
      document.querySelector<HTMLTextAreaElement>(`[data-side-owner="${CSS.escape(owner)}"]`)?.focus();
    };
    window.addEventListener("areal-side-draft", refresh);
    return () => window.removeEventListener("areal-side-draft", refresh);
  }, [owner, draftKey]);
  useEffect(() => {
    if (!sideId || validSide || side || loading || !project.state?.connected) return;
    setLoading(true);
    void action("open", { projectId: project.id, threadId: sideId })
      .catch((cause: Error) => { if (mounted.current) setError(cause.message); })
      .finally(() => { if (mounted.current) setLoading(false); });
  }, [sideId, validSide, side, loading, project.id, project.state?.connected, action]);
  const recover = useCallback(async () => {
    if (!pendingId || busy) return;
    setBusy(true); setError("");
    try {
      const result = await action("side", { projectId: project.id, operation: "recover", requestId: pendingId });
      if (!mounted.current) return;
      if (!result.confirmed) { setError("首问结果仍待核对；不会自动重复提交。"); return; }
      localStorage.setItem(threadKey, result.threadId);
      localStorage.removeItem(pendingKey);
      localStorage.removeItem(draftKey);
      setSideId(result.threadId); setPendingId(""); setText("");
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }, [pendingId, busy, action, project.id, threadKey, pendingKey, draftKey]);
  useEffect(() => { if (pendingId && project.state?.connected) void recover(); }, [project.state?.connected]);
  const submit = async () => {
    const question = text.trim();
    if (!question || busy || pendingId || active || !project.state?.connected || sideId && !validSide) return;
    setBusy(true); setError("");
    try {
      if (sideId) {
        await action("side", { projectId: project.id, operation: "send", threadId: sideId, text: question });
      } else {
        const requestId = crypto.randomUUID();
        localStorage.setItem(pendingKey, requestId); setPendingId(requestId);
        const result = await action("side", { projectId: project.id, operation: "start", sourceThreadId: source.id, text: question, requestId });
        if (!mounted.current) return;
        localStorage.setItem(threadKey, result.threadId);
        localStorage.removeItem(pendingKey);
        setSideId(result.threadId); setPendingId("");
      }
      localStorage.removeItem(draftKey); setText("");
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (!failure.submissionUnknown && !sideId) { localStorage.removeItem(pendingKey); setPendingId(""); }
      if (mounted.current) setError(failure.message);
    } finally { if (mounted.current) setBusy(false); }
  };
  const stop = () => {
    const turn = side?.turns?.find((item: Data) => item.status === "inProgress");
    if (validSide && turn) void action("stop", { projectId: project.id, threadId: sideId }).catch((cause: Error) => setError(cause.message));
  };
  return <section className="side-chat-pane" aria-label="旁路讨论">
    <div className="panel-header"><strong>旁路讨论</strong><span className="text-foreground-subtle">只读 · 独立会话</span></div>
    <div className="utility-content">
      <p className="text-foreground-subtle">来源：{source.preview || source.id}。{validSide ? "基于创建时快照。" : "首问发送时冻结已提交的会话证据。"}不会执行来源任务。</p>
      {sideId && !validSide && <p role="status">{side ? "旁路归属与当前来源不一致。" : loading ? "正在恢复旁路讨论…" : "正在核对旁路归属…"}</p>}
      {validSide && <Messages key={`${owner}:${sideId}`} project={project} thread={side} action={action} dark={dark}
        onLink={() => setError("旁路不提供链接预览；可复制链接后从主会话打开。")}
        onFile={() => setError("旁路尚未开放工作区文件读取。")}
        onReview={() => {}} readTurnReview={async () => ({})} />}
      {error && <p role="alert">{error}</p>}
      {pendingId && <button type="button" onClick={() => void recover()} disabled={busy}>核对首问结果</button>}
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <textarea data-side-owner={owner} aria-label="旁路问题" value={text} onChange={event => {
          setText(event.target.value); localStorage.setItem(draftKey, event.target.value);
        }} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
        }} placeholder="向旁路提问（仅会话证据）" disabled={!project.state?.connected || !!sideId && !validSide} />
        <div className="utility-actions">
          <button type="submit" disabled={!text.trim() || busy || !!pendingId || !!active || !!sideId && !validSide}>发送</button>
          {active && <button type="button" onClick={stop}>停止旁路</button>}
        </div>
      </form>
    </div>
  </section>;
}
