import { useEffect, useState } from "react";
import type { Action, Data } from "./services.js";

/** 从 Core 读取目标持有的历史种子；本地 Turn 仍是执行账本。 */
export function ForkHistory({ projectId, thread, action, onFork }: { projectId: string; thread: Data; action: Action; onFork?: (turnId: string) => Promise<void> }) {
  const [items, setItems] = useState<Data[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [forking, setForking] = useState(false);
  const snapshotId = thread.conversation?.historySeed?.snapshotId;
  useEffect(() => { setItems([]); setCursor(undefined); setComplete(false); setError(""); }, [thread.id, snapshotId]);
  useEffect(() => {
    if (!snapshotId || complete || error) return;
    let cancelled = false;
    void action("manage", { projectId, operation: "inheritedHistory", threadId: thread.id,
      view: "inherited", ...(cursor ? { cursor } : {}), maxBytes: 65536 }).then((page: Data) => {
      if (cancelled || page.snapshotId !== snapshotId) return;
      setItems(previous => [...previous, ...(page.data ?? [])]);
      setCursor(page.nextCursor ?? undefined);
      setComplete(page.complete === true);
    }).catch((cause: Error) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [action, projectId, thread.id, snapshotId, cursor, complete, error]);
  if (!snapshotId) return null;
  return <section className="fork-history" aria-label="继承的对话历史">
    <p className="notice">继承至来源会话 <code>{thread.conversation.origin?.sourceThreadId}</code> 的轮次 <code>{thread.conversation.origin?.sourceTurnId}</code> 结束后。项目文件使用当前共享工作区；历史中的文件内容可能已变化。</p>
    {items.map((entry, index) => <article key={`${thread.id}:inherited:${entry.sourceTurnId}:${entry.sourceItemId}`} className="fork-history-item">
      <small>{entry.item?.type === "userMessage" ? "原提问" : "原回答"}</small>
      <p>{entry.item?.type === "userMessage" ? entry.item.content?.map((part: Data) => part.text ?? "").join("") : entry.item?.text ?? ""}</p>
      {onFork && entry.sourceTurnId && items[index + 1]?.sourceTurnId !== entry.sourceTurnId &&
        <button type="button" disabled={forking} onClick={() => {
          setForking(true);
          void onFork(entry.sourceTurnId).finally(() => setForking(false));
        }}>{forking ? "正在创建分支…" : "从此轮次创建分支"}</button>}
    </article>)}
    {error && <p role="alert">继承历史读取失败：{error}</p>}
    {!complete && !error && <p role="status">正在加载继承历史…</p>}
  </section>;
}
