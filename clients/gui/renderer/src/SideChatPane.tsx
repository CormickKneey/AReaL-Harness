import { useCallback, useEffect, useRef, useState } from "react";
import { Messages } from "./Messages.js";
import { RelatedSideChats } from "./RelatedSideChats.js";
import type { Action, Data } from "./services.js";

// 旁路草稿和业务键只属于明确来源；关闭面板不会取消已受理的 Turn。
export function SideChatPane({ project, source, action, dark }: {
  project: Data; source: Data; action: Action; dark: boolean;
}) {
  const owner = `${project.id}:${source.id}:side`;
  const draftKey = `areal-gui:side:draft:${owner}`;
  const threadKey = `areal-gui:side:thread:${owner}`;
  const pendingKey = `areal-gui:side:pending:${owner}`;
  const selectionKey = `areal-gui:side:selection:${owner}`;
  const anchorKey = `areal-gui:side:anchor:${owner}`;
  const previewKey = `areal-gui:side:selection-preview:${owner}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [sideId, setSideId] = useState(() => localStorage.getItem(threadKey) ?? "");
  const [pendingId, setPendingId] = useState(() => localStorage.getItem(pendingKey) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Data | null>(() => { try { return JSON.parse(localStorage.getItem(selectionKey) ?? "null"); } catch { return null; } });
  const [anchor, setAnchor] = useState<Data | null>(() => { try { return JSON.parse(localStorage.getItem(anchorKey) ?? "null"); } catch { return null; } });
  const [selectionPreview, setSelectionPreview] = useState(() => localStorage.getItem(previewKey) ?? "");
  const [evidence, setEvidence] = useState<Data[]>([]);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const mounted = useRef(true);
  const side = sideId ? project.state?.threads?.[sideId] : undefined;
  const validSide = side?.conversation?.kind === "side" && side.conversation.origin?.sourceThreadId === source.id;
  const active = validSide && side.turns?.some((turn: Data) => turn.status === "inProgress");
  const sourceStatus = !project.state?.connected || !source.updatedAt || !side?.createdAt ? "来源当前状态未知" :
    Date.parse(source.updatedAt) > Date.parse(side.createdAt) ? "来源已推进；此讨论仍依据创建时快照" : "依据创建时快照";
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
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string }>).detail;
      if (detail?.owner !== owner) return;
      try { setSelection(JSON.parse(localStorage.getItem(selectionKey) ?? "null")); } catch { setSelection(null); }
      try { setAnchor(JSON.parse(localStorage.getItem(anchorKey) ?? "null")); } catch { setAnchor(null); }
      setSelectionPreview(localStorage.getItem(previewKey) ?? "");
      setSideId(""); setEvidence([]); setEvidenceCursor(null); setEvidenceOpen(false);
    };
    window.addEventListener("areal-side-selection", receive);
    return () => window.removeEventListener("areal-side-selection", receive);
  }, [owner, selectionKey, anchorKey, previewKey]);
  const loadEvidence = async (cursor?: string) => {
    if (!validSide || evidenceBusy) return;
    setEvidenceBusy(true); setError("");
    try {
      const page = await action("side", { projectId: project.id, operation: "context", threadId: sideId, cursor, maxBytes: 4096 });
      if (!mounted.current || page.snapshotId !== side.conversation.referenceSnapshot?.snapshotId) return;
      setEvidence(rows => cursor ? [...rows, ...(page.evidence ?? [])] : page.evidence ?? []);
      setEvidenceCursor(page.nextCursor ?? null); setEvidenceOpen(true);
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { if (mounted.current) setEvidenceBusy(false); }
  };
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
      localStorage.removeItem(selectionKey); localStorage.removeItem(anchorKey); localStorage.removeItem(previewKey);
      setSelection(null); setAnchor(null); setSelectionPreview("");
      setSideId(result.threadId); setPendingId(""); setText("");
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }, [pendingId, busy, action, project.id, threadKey, pendingKey, draftKey, selectionKey, anchorKey, previewKey]);
  useEffect(() => { if (pendingId && project.state?.connected) void recover(); }, [project.state?.connected]);
  const submit = async () => {
    const question = text.trim();
    if (!question || busy || pendingId || active || !project.state?.connected || sideId && (!validSide || side.desktop?.archived)) return;
    setBusy(true); setError("");
    try {
      if (sideId) {
        await action("side", { projectId: project.id, operation: "send", threadId: sideId, text: question });
      } else {
        const requestId = crypto.randomUUID();
        localStorage.setItem(pendingKey, requestId); setPendingId(requestId);
        const result = await action("side", { projectId: project.id, operation: "start", sourceThreadId: source.id, text: question, requestId, selection, anchor });
        if (!mounted.current) return;
        localStorage.setItem(threadKey, result.threadId);
        localStorage.removeItem(pendingKey);
        setSideId(result.threadId); setPendingId("");
      }
      localStorage.removeItem(draftKey); localStorage.removeItem(selectionKey); localStorage.removeItem(anchorKey); localStorage.removeItem(previewKey);
      setSelection(null); setAnchor(null); setSelectionPreview(""); setText("");
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
      <RelatedSideChats project={project} sourceId={source.id} selectedId={sideId} action={action} onSelect={id => {
        if (id) localStorage.setItem(threadKey, id); else localStorage.removeItem(threadKey);
        setSideId(id); setError("");
      }} />
      <p className="text-foreground-subtle">来源：{source.preview || source.id}。{validSide ? "基于创建时快照。" : "首问发送时冻结已提交的会话证据。"}不会执行来源任务。</p>
      <p className="text-foreground-subtle">来源：{source.preview || source.id}。{validSide ? sourceStatus : anchor?.kind === "turn" ? `首问锚定轮次 ${anchor.turnId} 之后的持久证据` : "首问发送时冻结最新持久观察"}。仅会话证据；不会执行来源任务。</p>
      {selection && !sideId && <blockquote className="notice">{selection.kind === "itemRange" ? "已持久化选区；发送时验证原文位置。" : "用户引文，来源未确认。"}<br />{selectionPreview || selection.text}</blockquote>}
      {validSide && <p className="text-foreground-subtle">冻结锚点：{side.conversation.origin?.boundary} · {side.conversation.origin?.sourceTurnId || "空历史"}</p>}
      {validSide && side.conversation.selection && <blockquote className="notice">{side.conversation.selection.verified ? "已验证来源片段" : "用户引文，来源未确认"}：{side.conversation.selection.text}</blockquote>}
      {validSide && <div className="utility-actions"><button type="button" onClick={() => void loadEvidence()} disabled={evidenceBusy}>查看冻结证据</button></div>}
      {validSide && evidenceOpen && <section aria-label="冻结证据" className="side-evidence">
        <p>快照 {side.conversation.referenceSnapshot?.snapshotId}；仅显示已加载的证据。</p>
        {evidence.map((row, index) => <article key={`${row.evidenceRef}:${row.range?.startUtf8 ?? 0}:${index}`}>
          <small>轮次 {row.sourceTurnId} · 项 {row.sourceItemId} · {row.sourceTurnStatus}</small>
          <pre>{row.text}</pre>
          {row.range && row.range.endUtf8 < row.range.totalBytes && <small>片段 {row.range.startUtf8}–{row.range.endUtf8} / {row.range.totalBytes} 字节</small>}
          <button type="button" onClick={() => document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(row.sourceTurnId)}"]`)?.scrollIntoView({ block: "center" })}>在来源定位</button>
        </article>)}
        {evidenceCursor && <button type="button" disabled={evidenceBusy} onClick={() => void loadEvidence(evidenceCursor)}>继续加载证据</button>}
      </section>}
      {sideId && !validSide && <p role="status">{side ? "旁路归属与当前来源不一致。" : loading ? "正在恢复旁路讨论…" : "正在核对旁路归属…"}</p>}
      {validSide && side.desktop?.archived && <p role="status">这段讨论已归档；请在相关讨论中显式恢复后继续。</p>}
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
        }} placeholder="向旁路提问（仅会话证据）" disabled={!project.state?.connected || !!sideId && (!validSide || side.desktop?.archived)} />
        <div className="utility-actions">
          <button type="submit" disabled={!text.trim() || busy || !!pendingId || !!active || !!sideId && (!validSide || side.desktop?.archived)}>发送</button>
          {active && <button type="button" onClick={stop}>停止旁路</button>}
        </div>
      </form>
    </div>
  </section>;
}
