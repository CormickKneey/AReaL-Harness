import { useEffect, useRef, useState } from "react";
import type { Action, Data } from "./services.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import { SentAttachment } from "./MessageAttachment.js";

/** 继承项只展示目标持有的证据；不装载来源工具控制。 */
function InheritedItem({ item, projectId, threadId, action }: { item: Data; projectId: string; threadId: string; action: Action }) {
  const attachment = (uri: string, type: string, name: string) => uri.startsWith("areal://blob/")
    ? <SentAttachment part={{ uri, type, name }} projectId={projectId} threadId={threadId} action={action} />
    : <span>{name} · 来源引用不可在此打开</span>;
  if (item.type === "userMessage") return <div>{(item.content ?? []).map((part: Data, index: number) =>
    <div key={index}>{part.type === "text" ? part.text : attachment(part.url ?? "", part.type, part.name ?? "原提问附件")}</div>)}</div>;
  if (item.type === "agentMessage") return <p>{item.text}</p>;
  if (item.type === "agentMedia") return attachment(item.media?.uri ?? "", item.modality, "原回答附件");
  if (item.type === "dynamicToolCall") return <div className="notice">
    <p>历史工具 · {item.tool} · {item.execution?.outcome ?? item.status}</p>
    {item.execution?.inspection && <p>来源核查：{item.execution.inspection}</p>}
    {(item.contentItems ?? []).map((part: Data, index: number) => <div key={index}>{part.type === "inputText" ? part.text
      : part.type === "arealMedia" ? attachment(part.media?.uri ?? "", part.modality, "工具结果附件") : null}</div>)}
    {item.execution?.resultSnapshot?.uri && <div>原始工具结果：{attachment(item.execution.resultSnapshot.uri, "file", "原始结果")}</div>}
  </div>;
  if (item.type === "reasoning") return <p>历史思考摘要 · {(item.summary ?? []).join(" ")}</p>;
  return <p>历史模型上下文</p>;
}

/** 从 Core 读取目标持有的历史种子；本地 Turn 仍是执行账本。 */
export function ForkHistory({ projectId, thread, action, onFork, onSideSelection }: { projectId: string; thread: Data; action: Action; onFork?: (turnId: string, boundary: "before" | "after") => Promise<void>; onSideSelection?: (selection: Data, text: string, anchor?: Data) => void }) {
  const [items, setItems] = useState<Data[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState("");
  const [selected, setSelected] = useState<{ turnId: string; itemId: string; text: string; startUtf8?: number; endUtf8?: number } | null>(null);
  const partial = useRef<{ itemId: string; json: string } | null>(null);
  const snapshotId = thread.conversation?.historySeed?.snapshotId;
  const capture = (entry: Data, article: HTMLElement) => {
    if (!onSideSelection) return;
    const current = window.getSelection();
    if (!current || current.isCollapsed || current.rangeCount !== 1) return;
    const range = current.getRangeAt(0);
    const body = article.querySelector<HTMLElement>("[data-inherited-content]");
    if (!body || !body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
    const text = current.toString();
    if (!text.trim()) return;
    const item = entry.item;
    const canonical = item?.type === "agentMessage" ? item.text : item?.type === "userMessage" && item.content?.length === 1 && item.content[0]?.type === "text" ? item.content[0].text : undefined;
    if (canonical && body.textContent === canonical) {
      const before = range.cloneRange(); before.selectNodeContents(body); before.setEnd(range.startContainer, range.startOffset);
      const startUtf8 = new TextEncoder().encode(before.toString()).length;
      setSelected({ turnId: entry.sourceTurnId, itemId: entry.sourceItemId, text, startUtf8, endUtf8: startUtf8 + new TextEncoder().encode(text).length });
    } else setSelected({ turnId: entry.sourceTurnId, itemId: entry.sourceItemId, text });
  };
  const ask = async () => {
    if (!selected || !onSideSelection) return;
    let selection: Data = { kind: "userQuote", text: selected.text, claimedTurnId: selected.turnId, claimedItemId: selected.itemId };
    if (selected.startUtf8 !== undefined && selected.endUtf8 !== undefined) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(selected.text));
      selection = { kind: "itemRange", turnId: selected.turnId, itemId: selected.itemId,
        startUtf8: selected.startUtf8, endUtf8: selected.endUtf8,
        textSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
    }
    onSideSelection(selection, selected.text, { kind: "turn", turnId: selected.turnId, boundary: "after" }); setSelected(null);
  };
  useEffect(() => { partial.current = null; setItems([]); setCursor(undefined); setComplete(false); setError(""); }, [thread.id, snapshotId]);
  useEffect(() => {
    if (!snapshotId || complete || error) return;
    let cancelled = false;
    void action("manage", { projectId, operation: "inheritedHistory", threadId: thread.id,
      view: "inherited", ...(cursor ? { cursor } : {}), maxBytes: 65536 }).then((page: Data) => {
      if (cancelled || page.snapshotId !== snapshotId) return;
      const completeEntries: Data[] = [];
      for (const entry of page.data ?? []) {
        if (!entry.fragment) {
          if (partial.current) throw new Error("继承历史分片不连续");
          completeEntries.push(entry); continue;
        }
        const fragment = entry.fragment;
        const pending = partial.current;
        const bytes = pending ? new TextEncoder().encode(pending.json).length : 0;
        if (fragment.offsetUtf8 !== bytes || pending && pending.itemId !== entry.sourceItemId) {
          throw new Error("继承历史分片不连续");
        }
        const json = (pending?.json ?? "") + fragment.text;
        const total = new TextEncoder().encode(json).length;
        if (total > fragment.totalBytes) throw new Error("继承历史分片长度无效");
        if (total === fragment.totalBytes) {
          completeEntries.push(JSON.parse(json));
          partial.current = null;
        } else partial.current = { itemId: entry.sourceItemId, json };
      }
      if (page.complete && partial.current) throw new Error("继承历史分片不完整");
      setItems(previous => [...previous, ...completeEntries]);
      setCursor(page.nextCursor ?? undefined);
      setComplete(page.complete === true);
    }).catch((cause: Error) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [action, projectId, thread.id, snapshotId, cursor, complete, error]);
  if (!snapshotId) return null;
  return <section className="fork-history" aria-label="继承的对话历史">
    <p className="notice">继承至来源会话 <code>{thread.conversation.origin?.sourceThreadId}</code> 的轮次 <code>{thread.conversation.origin?.sourceTurnId}</code> {thread.conversation.origin?.boundary === "before" ? "之前" : "之后"}。项目文件使用当前共享工作区；历史中的文件内容可能已变化。</p>
    {items.map((entry, index) => <article key={`${thread.id}:inherited:${entry.sourceTurnId}:${entry.sourceItemId}`} className="fork-history-item" onMouseUp={event => capture(entry, event.currentTarget)}>
      <small>{entry.item?.type === "userMessage" ? "原提问" : "继承记录"}</small>
      <div data-inherited-content><InheritedItem item={entry.item} projectId={projectId} threadId={thread.id} action={action} /></div>
      {selected && selected.turnId === entry.sourceTurnId && selected.itemId === entry.sourceItemId && <button type="button" onClick={() => void ask()}>在旁路中询问所选内容</button>}
      {onFork && entry.sourceTurnId && (items[index + 1]?.sourceTurnId !== entry.sourceTurnId && (index + 1 < items.length || complete)) &&
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" disabled={forking} aria-label={`继承轮次操作 ${entry.sourceTurnId}`}>⋯</button>} />
          <DropdownMenuContent align="end">
            {(["after", "before"] as const).map(boundary => <DropdownMenuItem key={boundary} onClick={() => {
              setForking(true); setForkError("");
              void onFork(entry.sourceTurnId, boundary).catch((cause: Error) => setForkError(cause.message)).finally(() => setForking(false));
            }}>{boundary === "after" ? "在此轮之后分支" : "在此轮之前分支"}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>}
    </article>)}
    {forkError && <p role="alert">{forkError}</p>}
    {error && <p role="alert">继承历史读取失败：{error}</p>}
    {!complete && !error && <p role="status">正在加载继承历史…</p>}
  </section>;
}
