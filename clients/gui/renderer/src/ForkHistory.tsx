import { useEffect, useState } from "react";
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
export function ForkHistory({ projectId, thread, action, onFork }: { projectId: string; thread: Data; action: Action; onFork?: (turnId: string, boundary: "before" | "after") => Promise<void> }) {
  const [items, setItems] = useState<Data[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState("");
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
    <p className="notice">继承至来源会话 <code>{thread.conversation.origin?.sourceThreadId}</code> 的轮次 <code>{thread.conversation.origin?.sourceTurnId}</code> {thread.conversation.origin?.boundary === "before" ? "之前" : "之后"}。项目文件使用当前共享工作区；历史中的文件内容可能已变化。</p>
    {items.map((entry, index) => <article key={`${thread.id}:inherited:${entry.sourceTurnId}:${entry.sourceItemId}`} className="fork-history-item">
      <small>{entry.item?.type === "userMessage" ? "原提问" : "继承记录"}</small>
      <InheritedItem item={entry.item} projectId={projectId} threadId={thread.id} action={action} />
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
