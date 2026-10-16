import { useState } from "react";
import { Messages } from "../Messages.js";
import { Button } from "../components/ui/button.js";
import type { Action, Data } from "../services.js";
import sampleImage from "../assets/codex-fork-mask.png";

const tool = (id: string, name: string, args: Data, result: Data) => ({
  id, type: "dynamicToolCall", tool: name, arguments: args, status: "completed", success: true,
  contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
});
const receipt = { path: "workspace://repo/src/conversation.tsx", size: 128, sha256: "a".repeat(64) };
const items = [
  { id: "timeline-user", type: "userMessage", content: [{ type: "text", text: "检查对话交互，保留工具详情和文件变更入口。" }] },
  { id: "timeline-progress", type: "agentMessage", phase: "commentary", text: "我会先检查消息投影，再调整工具详情、图片与子智能体的展示。" },
  tool("timeline-read", "fs_read", { path: "src/conversation.tsx" }, receipt),
  tool("timeline-command", "run_command", { command: "pnpm --dir clients/gui typecheck" }, { stdout: "> tsc --noEmit\n\n类型检查通过。\n".repeat(12), stderr: "", exitCode: 0, commandStatus: "succeeded" }),
  { id: "timeline-image", type: "dynamicToolCall", tool: "browser_v1", arguments: { operation: "capture" }, status: "completed", success: true,
    contentItems: [{ type: "arealMedia", modality: "image", media: { uri: "areal-blob:preview-image" } }] },
  tool("timeline-agent", "agent_spawn", { input: [{ type: "text", text: "检查消息投影" }] }, { threadId: "preview-child" }),
  { id: "timeline-long-progress", type: "agentMessage", phase: "commentary", text: Array.from({ length: 10 }, (_, i) => `检查记录 ${i + 1}：过程文字保留原文，默认有界展示，展开后可以完整阅读。`).join("\n\n") },
  tool("timeline-write", "fs_write", { path: "src/conversation.tsx" }, receipt),
  { id: "timeline-final", type: "agentMessage", phase: "final_answer", text: "已完成对话交互调整，类型检查通过。\n\n工具详情可以按需展开，图片和子智能体有独立入口。最终回答保留完整内容。" },
];
const readReview = async (turnId: string, itemId?: string) => ({ turnId, ...(itemId ? { itemId, scope: "tool" } : {}),
  diff: "-const spacing = 8;\n+const spacing = 12;", files: [{ path: "src/conversation.tsx", additions: 1, deletions: 1, beforeText: "const spacing = 8;\n", afterText: "const spacing = 12;\n" }] });
// Synthetic read-only boundaries; never connect this catalog to a user's Core.
const action = (async (name: string) => {
  if (name === "media") return { bytes: new Uint8Array(await (await fetch(sampleImage)).arrayBuffer()), mime: "image/png" };
  throw new Error("组件预览不执行真实操作。");
}) as Action;

export function ConversationTimelinePreview({ dark }: { dark: boolean }) {
  const [live, setLive] = useState(false);
  const [opened, setOpened] = useState("");
  const thread = { id: "timeline-preview", turns: [{ id: "timeline-turn", status: live ? "inProgress" : "completed", durationMs: 19220,
    items: live ? [...items.slice(0, -1),
      { id: "timeline-stream", type: "agentMessage", phase: "commentary", text: "正在输出的正文保持完整，不因后续思考事件而折叠。\n\n".repeat(10) },
      { id: "timeline-reasoning", type: "reasoning", summary: ["继续检查对话展示。"] },
    ] : items }] };
  const project = { id: "timeline-project", root: "/preview", configurations: {}, state: { connected: true, interactions: {}, queues: {},
    threads: { "preview-child": { id: "preview-child", parentThreadId: thread.id, preview: "检查消息投影", turns: [{ status: "completed" }] } } } };
  return <section id="conversation-timeline" className="design-preview-panel" aria-label="对话时间线预览">
    <h2>对话时间线</h2>
    <div className="design-preview-actions"><Button variant="outline" onClick={() => setLive(!live)}>{live ? "显示已完成" : "显示执行中"}</Button></div>
    <Messages project={project} thread={thread} action={action} dark={dark} reserveResponseSpace={false}
      onLink={setOpened} onFile={setOpened} onReview={() => setOpened("本轮文件变更")} onAgent={setOpened} readTurnReview={readReview} />
    {opened && <p role="status">预览打开：{opened}</p>}
  </section>;
}
