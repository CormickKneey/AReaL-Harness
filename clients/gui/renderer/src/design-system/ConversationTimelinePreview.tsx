import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationComposer } from "../ConversationComposer.js";
import { AgentConversationPane } from "../AgentConversationPane.js";
import { CodeViewer } from "../components/ui/code-viewer.js";
import { DiffViewer } from "../components/ui/diff-viewer.js";
import { CloseIcon, StopIcon } from "../interfaceIcons.js";
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
const action = (async (name: string, params: Data) => {
  if (name === "open" && params.threadId === "preview-child") return {};
  if (name === "media") return { bytes: new Uint8Array(await (await fetch(sampleImage)).arrayBuffer()), mime: "image/png" };
  throw new Error("组件预览不执行真实操作。");
}) as Action;

export function ConversationTimelinePreview({ dark }: { dark: boolean }) {
  const [live, setLive] = useState(false);
  const [panel, setPanel] = useState<{ kind: "agent" | "file" | "review"; value: string } | null>(null);
  const [draft, setDraft] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const region = useRef<HTMLElement | null>(null);
  const openPanel = (kind: "agent" | "file" | "review", value: string) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel({ kind, value });
  };
  const closePanel = useCallback(() => {
    setPanel(null);
    requestAnimationFrame(() => {
      const target = trigger.current?.isConnected ? trigger.current : region.current?.querySelector<HTMLElement>('[data-testid="timeline-composer"]');
      target?.focus({ preventScroll: true });
    });
  }, []);
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); closePanel(); }
    };
    const element = region.current;
    element?.addEventListener("keydown", onKey);
    return () => element?.removeEventListener("keydown", onKey);
  }, [panel, closePanel]);
  const thread = { id: "timeline-preview", turns: [{ id: "timeline-turn", status: live ? "inProgress" : "completed", durationMs: 19220,
    items: live ? [...items.slice(0, -1),
      { id: "timeline-stream", type: "agentMessage", phase: "commentary", text: "正在输出的正文保持完整，不因后续思考事件而折叠。\n\n".repeat(10) },
      { id: "timeline-reasoning", type: "reasoning", summary: ["继续检查对话展示。"] },
    ] : items }] };
  const project = { id: "timeline-project", root: "/preview", models: [{ providerId: "preview", modelId: "fixture", displayName: "演示模型" }], configurations: {}, state: { connected: true, interactions: {}, queues: {},
    threads: { "preview-child": { id: "preview-child", parentThreadId: thread.id, preview: "检查消息投影", turns: [{ id: "timeline-child-turn", status: "completed", items: [{ id: "timeline-child-input", type: "userMessage", content: [{ type: "text", text: "检查消息投影" }] }, { id: "timeline-child-final", type: "agentMessage", phase: "final_answer", text: "已核对消息投影：过程、工具结果和最终回答分别保留。此处为固定演示内容。" }] }] } } } };
  return <section ref={region} id="conversation-timeline" className="design-preview-panel design-preview-flow-panel" aria-label="对话时间线预览" data-demo-state={live ? "running" : "completed"}>
    <h2>对话时间线</h2>
    <p className="text-ui-sm text-foreground-subtle">固定演示数据。切换执行状态，打开工具、图片、子对话和文件；不连接实际项目。</p>
    <div className="design-preview-actions">
      <Button variant="outline" onClick={() => setLive(!live)}>{live ? "显示已完成" : "显示执行中"}</Button>
    </div>
    <div className="design-preview-flow-workspace" data-panel-open={!!panel}>
      <div className="design-preview-flow-chat" aria-label="主对话">
        <header className="design-preview-flow-toolbar"><span>检查对话交互</span><span>{live ? "执行中" : "已完成"}</span></header>
        <Messages project={project} thread={thread} action={action} dark={dark} reserveResponseSpace={false}
          onLink={path => openPanel("file", path)} onFile={path => openPanel("file", path)}
          onReview={() => openPanel("review", "src/conversation.tsx")} onAgent={id => openPanel("agent", id)} readTurnReview={readReview} />
        <div className="composer-dock">
          <ConversationComposer project={project} modelConfig={{ model: { providerId: "preview", modelId: "fixture" } }}
            modelDisabled onConfigureModel={() => {}} onModelSettings={() => {}}
            taskId={thread.id} workspacePath={project.root} initialValue={draft} onChange={setDraft} inputTestId="timeline-composer"
            placeholder="可输入未发送草稿；用上方按钮切换演示状态" submitLabel="发送"
            enableMentionPanel={false} enterSubmits submitDisabled onSubmit={() => false}
            submitControl={live ? <Button type="button" variant="composer" size="icon-md" aria-label="结束本地演示" onClick={() => setLive(false)}><StopIcon /></Button> : undefined} />
        </div>
      </div>
      {panel && <aside className="design-preview-flow-context" aria-label="对话详情面板">
        <header className="design-preview-flow-toolbar"><span>{panel.kind === "agent" ? "子对话" : panel.kind === "review" ? "本轮文件变更" : panel.value}</span>
          <Button variant="ghost" size="icon-sm" aria-label="返回主对话" onClick={closePanel}><CloseIcon /></Button>
        </header>
        {panel.kind === "agent" ? <AgentConversationPane project={project} parentId={thread.id} childId={panel.value} action={action} dark={dark}
          onLink={path => openPanel("file", path)} onFile={path => openPanel("file", path)} onReview={() => openPanel("review", "src/conversation.tsx")} onAgent={id => openPanel("agent", id)} />
          : <div className="design-preview-timeline-resource" role="region" aria-label={panel.kind === "review" ? "文件变更预览" : "文件内容预览"}>
            <p className="text-ui-sm text-foreground-subtle">{panel.value}</p>
            {panel.kind === "review" ? <DiffViewer oldFile={{ name: panel.value, contents: "const spacing = 8;\n" }} newFile={{ name: panel.value, contents: "const spacing = 12;\n" }} disableWorkerPool themeType={dark ? "dark" : "light"} />
              : <CodeViewer code={"const spacing = 12;\n"} language="tsx" showLineNumbers />}
          </div>}
      </aside>}
    </div>
  </section>;
}
