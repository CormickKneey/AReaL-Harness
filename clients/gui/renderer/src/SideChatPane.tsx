import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Messages } from "./Messages.js";
import { RelatedSideChats } from "./RelatedSideChats.js";
import { SideDraftWorkspace } from "./side-draft-owner.js";
import { insertSideAnswer, makeBringBackPreview } from "./side-bring-back.js";
import type { Action, Data } from "./services.js";

// 编辑器按服务、来源和具体草稿或 Side 隔离；切换目标会卸载旧编辑器。
export function SideChatPane({ project, source, action, dark, onReturn }: {
  project: Data; source: Data; action: Action; dark: boolean; onReturn: () => void;
}) {
  const workspace = useMemo(() => new SideDraftWorkspace(localStorage, {
    instanceId: project.core?.instanceId ?? "unknown", projectId: project.id, sourceThreadId: source.id, randomId: () => crypto.randomUUID(),
  }), [project.core?.instanceId, project.id, source.id]);
  const [selected, setSelected] = useState(() => workspace.current());
  const [draftRevision, setDraftRevision] = useState(0);
  const choose = (next: { kind: string; id: string }) => { setSelected(next); setDraftRevision(value => value + 1); };
  useEffect(() => { choose(workspace.current()); }, [workspace]);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string }>).detail;
      if (detail?.owner?.startsWith(workspace.prefix + ":")) choose(workspace.current());
    };
    window.addEventListener("areal-side-draft", receive);
    window.addEventListener("areal-side-selection", receive);
    return () => { window.removeEventListener("areal-side-draft", receive); window.removeEventListener("areal-side-selection", receive); };
  }, [workspace]);
  return <section className="side-chat-pane" aria-label="旁路讨论">
    <div className="panel-header"><button type="button" onClick={onReturn}>返回主会话</button><strong>旁路讨论</strong><span className="text-foreground-subtle">只读 · 独立会话</span></div>
    <div className="utility-content">
      <RelatedSideChats project={project} sourceId={source.id} selectedId={selected.kind === "side" ? selected.id : ""} action={action}
        onSelect={id => choose(id ? workspace.selectSide(id) : workspace.newDraft())} />
      {workspace.availableDrafts().filter(draft => draft.id !== selected.id).map(draft => <button type="button" key={draft.id}
        onClick={() => choose(workspace.selectDraft(draft.id))}>{localStorage.getItem(workspace.pendingKey(draft)) ? "待核对的讨论" : "未发送的草稿"}</button>)}
      <SideChatEditor key={`${workspace.owner(selected)}:${project.core?.connectionGeneration ?? 0}`} project={project} source={source}
        action={action} dark={dark} workspace={workspace} selected={selected} onSelected={choose} />
    </div>
  </section>;
}

function SideChatEditor({ project, source, action, dark, workspace, selected, onSelected }: {
  project: Data; source: Data; action: Action; dark: boolean; workspace: SideDraftWorkspace;
  selected: { kind: string; id: string }; onSelected: (next: { kind: string; id: string }) => void;
}) {
  const owner = workspace.owner(selected);
  const draftKey = workspace.draftKey(selected);
  const pendingKey = workspace.pendingKey(selected);
  const selectionKey = `${owner}:selection`;
  const anchorKey = `${owner}:anchor`;
  const previewKey = `${owner}:selection-preview`;
  const sideId = selected.kind === "side" ? selected.id : "";
  const generation = project.core?.connectionGeneration ?? 0;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const workspaceReadAvailable = project.core?.features?.sideWorkspaceRead === true;
  const [workspaceAccess, setWorkspaceAccess] = useState<"none" | "readOnly">(() => workspaceReadAvailable ? "readOnly" : "none");
  const [pendingId, setPendingId] = useState(() => localStorage.getItem(pendingKey) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => localStorage.getItem(`${owner}:error`) ?? "");
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<Data | null>(() => { try { return JSON.parse(localStorage.getItem(selectionKey) ?? "null"); } catch { return null; } });
  const [anchor, setAnchor] = useState<Data | null>(() => { try { return JSON.parse(localStorage.getItem(anchorKey) ?? "null"); } catch { return null; } });
  const [selectionPreview, setSelectionPreview] = useState(() => localStorage.getItem(previewKey) ?? "");
  const [evidence, setEvidence] = useState<Data[]>([]);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [bringPreview, updateBringPreview] = useState<ReturnType<typeof makeBringBackPreview> | null>(() => workspace.bringBack(selected));
  const setBringPreview = (preview: ReturnType<typeof makeBringBackPreview> | null) => {
    workspace.saveBringBack(selected, preview); updateBringPreview(preview);
  };
  useEffect(() => { localStorage.setItem(`${owner}:error`, error); }, [owner, error]);
  const [bringResult, setBringResult] = useState("");
  const mounted = useRef(true);
  const side = sideId ? project.state?.threads?.[sideId] : undefined;
  const validSide = side?.conversation?.kind === "side" && side.conversation.origin?.sourceThreadId === source.id;
  const active = validSide && side.turns?.some((turn: Data) => turn.status === "inProgress");
  const sourceStatus = !project.state?.connected || !source.updatedAt || !side?.createdAt ? "来源当前状态未知" :
    Date.parse(source.updatedAt) > Date.parse(side.createdAt) ? "来源已推进；此讨论仍依据创建时快照" : "依据创建时快照";
  const answers = validSide ? (side.turns ?? []).flatMap((turn: Data) => {
    const final = (turn.items ?? []).filter((item: Data) => item.type === "agentMessage" && item.text?.trim() && item.phase === "final_answer");
    if (final.length) return final;
    if (turn.status !== "completed") return [];
    const legacy = (turn.items ?? []).filter((item: Data) => item.type === "agentMessage" && item.text?.trim() && !item.phase);
    return legacy.length ? [legacy.at(-1)] : [];
  }) : [];
  const prepareBringBack = (answer: string, whole: boolean) => {
    const selectedText = window.getSelection()?.toString().trim() ?? "";
    const selectionNode = window.getSelection()?.anchorNode;
    const pane = document.querySelector<HTMLElement>(`[data-side-owner="${CSS.escape(owner)}"]`)?.closest(".side-chat-pane");
    const withinPane = !!selectionNode && !!pane?.contains(selectionNode);
    const text = whole ? answer : withinPane && selectedText && answer.includes(selectedText) ? selectedText : "";
    if (!text) { setBringResult("请先选中这条回复中的文字，或明确选择整条回复。"); return; }
    setBringPreview(makeBringBackPreview({ storage: localStorage, owner: {
      instanceId: project.core?.instanceId ?? "unknown", projectId: project.id, sourceThreadId: source.id,
      sideThreadId: sideId, paneOwner: owner,
    }, source, side, answer: text, insertionId: crypto.randomUUID() }));
    setBringResult("");
  };
  const confirmBringBack = () => {
    if (!bringPreview) return;
    const result = insertSideAnswer({ storage: localStorage, preview: bringPreview,
      current: { owner: { instanceId: project.core?.instanceId ?? "unknown", projectId: project.id,
        sourceThreadId: source.id, sideThreadId: sideId, paneOwner: workspace.owner(workspace.current()) },
      source, side, connected: !!project.state?.connected },
      dispatch: (key: string) => { window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key })); } });
    if (result.status === "inserted") { setBringResult(result.changed ? "已追加到更新后的主会话草稿；请检查再发送。" : "已插入主会话草稿；请检查再发送。"); setBringPreview(null); }
    else if (result.status === "duplicate") setBringResult("这次内容已插入过主会话草稿。");
    else setBringResult("来源或目标已变化，未写入草稿。可复制预览文字。");
  };
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
      setEvidence([]); setEvidenceCursor(null); setEvidenceOpen(false);
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
    const token = workspace.capture(generation);
    setBusy(true); setError("");
    try {
      const result = await action("side", { projectId: project.id, operation: "recover", requestId: pendingId });
      if (!mounted.current || !workspace.isCurrent(token, generation)) return;
      if (!result.confirmed) { setError("首问结果仍待核对；不会自动重复提交。"); return; }
      workspace.acceptCreated(token, result.threadId, generation);
      localStorage.removeItem(selectionKey); localStorage.removeItem(anchorKey); localStorage.removeItem(previewKey);
      setSelection(null); setAnchor(null); setSelectionPreview("");
      onSelected({ kind: "side", id: result.threadId });
    } catch (cause) { if (mounted.current && workspace.isCurrent(token, generation)) setError((cause as Error).message); }
    finally { if (mounted.current && workspace.isCurrent(token, generation)) setBusy(false); }
  }, [pendingId, busy, action, project.id, pendingKey, draftKey, selectionKey, anchorKey, previewKey, workspace, generation, onSelected]);
  useEffect(() => { if (pendingId && project.state?.connected) void recover(); }, [project.state?.connected]);
  const submit = async () => {
    const question = text.trim();
    if (!question || busy || pendingId || active || !project.state?.connected || sideId && (!validSide || side.desktop?.archived)) return;
    const token = workspace.capture(generation);
    setBusy(true); setError("");
    try {
      if (sideId) {
        await action("side", { projectId: project.id, operation: "send", threadId: sideId, text: question });
      } else {
        const requestId = crypto.randomUUID();
        localStorage.setItem(pendingKey, requestId); setPendingId(requestId);
        const result = await action("side", { projectId: project.id, operation: "start", sourceThreadId: source.id, workspaceAccess, text: question, requestId, selection, anchor });
        if (!mounted.current || !workspace.isCurrent(token, generation)) return;
        workspace.acceptCreated(token, result.threadId, generation);
        onSelected({ kind: "side", id: result.threadId });
      }
      if (!mounted.current || !workspace.isCurrent(token, generation)) return;
      workspace.clearAfterSend(token, generation); localStorage.removeItem(selectionKey); localStorage.removeItem(anchorKey); localStorage.removeItem(previewKey);
      setSelection(null); setAnchor(null); setSelectionPreview(""); setText("");
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (!mounted.current || !workspace.isCurrent(token, generation)) return;
      if (!failure.submissionUnknown && !sideId) { localStorage.removeItem(pendingKey); setPendingId(""); }
      setError(failure.message);
    } finally { if (mounted.current && workspace.isCurrent(token, generation)) setBusy(false); }
  };
  const stop = () => {
    const turn = side?.turns?.find((item: Data) => item.status === "inProgress");
    if (validSide && turn) void action("stop", { projectId: project.id, threadId: sideId }).catch((cause: Error) => setError(cause.message));
  };
  return <>
      <p className="text-foreground-subtle">来源：{source.preview || source.id}。{validSide ? sourceStatus : anchor?.kind === "turn" ? `首问锚定轮次 ${anchor.turnId} 之后的持久证据` : "首问发送时冻结最新持久观察"}。{validSide && side.conversation.policy?.workspaceAccess === "readOnly" ? "可只读查询当前工作区；文件内容可能与历史锚点不同。" : "仅会话证据"}；不会执行来源任务。</p>
      {!sideId && <label>文件访问范围 <select value={workspaceAccess} onChange={event => setWorkspaceAccess(event.target.value as "none" | "readOnly")} disabled={busy || !!pendingId}>
        {workspaceReadAvailable && <option value="readOnly">只读当前工作区</option>}
        <option value="none">仅会话证据</option>
      </select></label>}
      {!sideId && !workspaceReadAvailable && <p className="text-foreground-subtle">当前 Core 未提供经过验证的工作区只读能力；可使用仅会话证据。</p>}
      {selection && !sideId && <blockquote className="notice">{selection.kind === "itemRange" ? "已持久化选区；发送时验证原文位置。" : "用户引文，来源未确认。"}<br />{selectionPreview || selection.text}</blockquote>}
      {validSide && <p role="status">模型：{project.configurations?.[sideId]?.model?.modelId || side.model?.modelId || source.model?.modelId || "当前配置"} · {active ? side.desktop?.sideCapacityStatus === "waiting" ? "等待模型容量" : "正在生成" : "空闲"}</p>}
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
        onFile={() => setError(side.conversation.policy?.workspaceAccess === "readOnly" ? "旁路模型可只读查询当前工作区；请在问题中指定文件路径。" : "此旁路仅能读取冻结会话证据。")}
        onReview={() => {}} readTurnReview={async () => ({})} />}
      {answers.length > 0 && <section aria-label="旁路回复带回主草稿">
        <p className="text-foreground-subtle">选择要带回的回复文字；整条回复需要单独确认。带回只修改来源主会话的本地草稿。</p>
        {answers.map((answer: Data, index: number) => <div className="utility-actions" key={answer.id ?? index}>
          <span>{`回复 ${index + 1}：${String(answer.text).slice(0, 70)}`}</span>
          <button type="button" onClick={() => prepareBringBack(answer.text, false)}>带回选中文字</button>
          <button type="button" onClick={() => prepareBringBack(answer.text, true)}>带回整条回复</button>
        </div>)}
      </section>}
      {bringPreview && <section aria-label="带回预览" className="side-evidence">
        <p>来源 Side：{side?.preview || sideId}；{sourceStatus}。请核对或编辑将插入的文字。</p>
        {bringPreview.stale && <p role="status">来源在旁路创建后已推进；以下文字仍依据旧快照。</p>}
        <textarea aria-label="编辑带回文字" value={bringPreview.text} onChange={event => setBringPreview({ ...bringPreview, text: event.target.value })} />
        <div className="utility-actions">
          <button type="button" onClick={confirmBringBack}>确认插入主草稿</button>
          <button type="button" onClick={() => {
            if (!navigator.clipboard?.writeText) { setBringResult("无法自动复制，请手动选择预览文字。"); return; }
            void navigator.clipboard.writeText(bringPreview.text).then(() => setBringResult("已复制带回文字。"), () => setBringResult("复制失败，请手动选择预览文字。"));
          }}>复制文字</button>
          <button type="button" onClick={() => { setBringPreview(null); setBringResult(""); }}>取消</button>
        </div>
      </section>}
      {bringResult && <p role="status">{bringResult}</p>}
      {error && <p role="alert">{error}</p>}
      {pendingId && <button type="button" onClick={() => void recover()} disabled={busy}>核对首问结果</button>}
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <textarea data-side-owner={owner} aria-label="旁路问题" value={text} onChange={event => {
          setText(event.target.value); localStorage.setItem(draftKey, event.target.value);
        }} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
        }} placeholder={side?.conversation?.policy?.workspaceAccess === "readOnly" || !sideId && workspaceAccess === "readOnly" ? "向旁路提问（可只读查询当前文件）" : "向旁路提问（仅会话证据）"} disabled={!project.state?.connected || !!sideId && (!validSide || side.desktop?.archived)} />
        <div className="utility-actions">
          <button type="submit" disabled={!text.trim() || busy || !!pendingId || !!active || !!sideId && (!validSide || side.desktop?.archived)}>发送</button>
          {active && <button type="button" onClick={stop}>停止旁路</button>}
        </div>
      </form>
  </>;
}
