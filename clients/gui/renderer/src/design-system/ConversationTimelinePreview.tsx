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
const writtenPaths = ["src/conversation.tsx", ...Array.from({ length: 6 }, (_, index) => `src/view-${index + 1}.tsx`)];
const items: Data[] = [
  { id: "timeline-user", type: "userMessage", content: [{ type: "text", text: "检查对话交互，保留工具详情和文件变更入口。" }] },
  { id: "timeline-progress", type: "agentMessage", phase: "commentary", text: "我会先检查消息投影，再调整工具详情、图片与子智能体的展示。" },
  tool("timeline-read", "fs_read", { path: "src/conversation.tsx" }, receipt),
  ...Array.from({ length: 8 }, (_, index) => tool(`timeline-extra-read-${index}`, "fs_read", { path: `src/context-${index + 1}.tsx` }, { ...receipt, path: `workspace://repo/src/context-${index + 1}.tsx` })),
  tool("timeline-command", "run_command", { command: "pnpm --dir clients/gui typecheck" }, { stdout: "> tsc --noEmit\n\n类型检查通过。\n".repeat(12), stderr: "", exitCode: 0, commandStatus: "succeeded" }),
  { id: "timeline-image", type: "dynamicToolCall", tool: "browser_v1", arguments: { operation: "capture" }, status: "completed", success: true,
    contentItems: [{ type: "arealMedia", modality: "image", media: { uri: "areal://blob/preview-image" } }] },
  tool("timeline-browser", "browser_v1", { operation: "navigate", parameters: { url: "http://127.0.0.1:4198/design-system.html?conversation" } }, { pageId: "preview-page", url: "http://127.0.0.1:4198/design-system.html?conversation" }),
  tool("timeline-agent", "agent_spawn", { input: [{ type: "text", text: "检查消息投影" }] }, { threadId: "preview-child" }),
  { id: "timeline-long-progress", type: "agentMessage", phase: "commentary", text: Array.from({ length: 10 }, (_, i) => `检查记录 ${i + 1}：过程文字完整显示，随对话一起滚动阅读。`).join("\n\n") },
  tool("timeline-write", "fs_write", { path: "src/conversation.tsx" }, receipt),
  ...writtenPaths.slice(1).map((path, index) => tool(`timeline-write-${index}`, "fs_write", { path }, { ...receipt, path: `workspace://repo/${path}` })),
  { id: "timeline-final", type: "agentMessage", phase: "final_answer", text: "已完成对话交互调整，类型检查通过。\n\n![交互截图](areal://blob/preview-image)\n\n[**![链接图片](areal://blob/preview-image)**](https://example.com/linked-report)\n\n[验证说明](https://example.com/report)\n\n[对话交互预览](http://127.0.0.1:4198/design-system.html?conversation)\n\n最终回答保留完整内容。" },
];
const readReview = async (turnId: string, itemId?: string) => ({ turnId, ...(itemId ? { itemId, scope: "tool" } : {}),
  diff: "-const spacing = 8;\n+const spacing = 12;", files: (itemId ? writtenPaths.filter(path => items.find(item => item.id === itemId)?.arguments?.path === path) : writtenPaths).map(path => ({ path, additions: 1, deletions: 1, beforeText: "const spacing = 8;\n", afterText: "const spacing = 12;\n" })) });
// Synthetic read-only boundaries; never connect this catalog to a user's Core.
const action = (async (name: string) => {
  if (name === "media") return { bytes: new Uint8Array(await (await fetch(sampleImage)).arrayBuffer()), mime: "image/png" };
  throw new Error("组件预览不执行真实操作。");
}) as Action;

function DisclosureUpdatePreview({ dark }: { dark: boolean }) {
  const [revision, setRevision] = useState(0);
  const [opened, setOpened] = useState("");
  const thread = { id: "disclosure-preview", turns: [{ id: "disclosure-turn", status: revision < 3 ? "inProgress" : "completed", durationMs: 41000,
    items: [
      { id: "disclosure-user", type: "userMessage", content: [{ type: "text", text: "阅读执行中的两层工具详情。" }] },
      { id: "disclosure-commentary", type: "agentMessage", phase: "commentary", text: revision ? "早前的过程消息现在开始显示文字。" : "" },
      tool("disclosure-skill", "skill_read", { name: "interface" }, { text: "保留手动展开的工具结果" }),
      tool("disclosure-plan", "plan_read", {}, { steps: ["检查界面", "保留展开状态"] }),
      ...(revision >= 2 ? [tool("disclosure-search", "search_files", { pattern: "disclosure" }, { files: [] })] : []),
      ...(revision >= 3 ? [{ id: "disclosure-final", type: "agentMessage", phase: "final_answer", text: "本轮已完成，手动展开的详情保持可读。" }] : []),
    ] }] };
  const project = { id: "disclosure-project", root: "/preview", configurations: {}, state: { connected: true, interactions: {}, queues: {}, threads: {} } };
  return <section className="design-preview-panel" aria-label="实时活动状态预览">
    <div className="design-preview-actions"><Button variant="outline" disabled={revision >= 3} onClick={() => setRevision(value => value + 1)}>
      {revision === 0 ? "补全早前过程消息" : revision === 1 ? "追加活动" : "完成回合"}
    </Button></div>
    <Messages project={project} thread={thread} action={action} dark={dark} reserveResponseSpace={false} readTurnReview={readReview}
      onLink={setOpened} onFile={setOpened} onReview={setOpened} />
    {opened && <p role="status">预览打开：{opened}</p>}
  </section>;
}

function ActivityReadingPreview({ dark }: { dark: boolean }) {
  const [shape, setShape] = useState("multiple");
  const [state, setState] = useState("running");
  const [output, setOutput] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const command = { ...tool("reading-command", "run_command", { command: Array.from({ length: 12 }, (_, index) => `printf 'command line ${index + 1}\\n'`).join("\n") },
    { stdout: `延迟输出 ${output}\n` + "正在检查阅读位置。\n".repeat(24 + output * 12), stderr: "", commandStatus: "running" }), status: "inProgress", success: undefined };
  const reasoning = { id: "reading-reasoning", type: "reasoning", summary: ["阅读思考过程时，后续输出保留当前位置。".repeat(12)] };
  const turn = { id: "reading-turn", status: "inProgress", items: [
    { id: "reading-user", type: "userMessage", content: [{ type: "text", text: "展开执行详情并继续阅读。" }] },
    ...(shape === "multiple" ? [command, tool("reading-plan", "plan_read", {}, { steps: ["检查阅读位置", "保留阅读意图"] }), reasoning]
      : shape === "single" ? [command] : shape === "reasoning" ? [reasoning] : []),
    ...(output ? [{ id: "reading-output", type: "agentMessage", phase: "commentary", text: `后续回复 ${output}\n\n` + "后续回复继续增加，阅读位置由用户决定。\n\n".repeat(output * 8) }] : []),
  ], ...(state === "retry" ? { modelRetry: { purpose: "solve", retry: 2 } } : {}) };
  const thread = { id: "reading-preview", turns: [
    { id: "reading-history", status: "completed", items: [{ id: "reading-history-reply", type: "agentMessage", phase: "final_answer", text: "此前的回复保留完整阅读空间。\n\n".repeat(30) }] }, ...(accepted ? [turn] : []),
  ] };
  const project = { id: "reading-project", root: "/preview", configurations: {}, state: { connected: state !== "disconnected",
    interactions: state === "input" ? { [thread.id]: { data: [{ status: "pending", turnId: turn.id }] } } : {}, queues: {}, threads: {} } };
  return <section id="activity-reading-preview" className="design-preview-panel design-preview-messages" aria-label="活动与阅读预览">
    <div className="design-preview-actions">
      <label>活动形状<select aria-label="活动形状" value={shape} onChange={event => { setShape(event.target.value); setOutput(0); }}>
        <option value="multiple">多项活动</option><option value="single">单项工具</option><option value="reasoning">思考过程</option><option value="empty">等待响应</option>
      </select></label>
      <label>活动状态<select aria-label="活动状态" value={state} onChange={event => setState(event.target.value)}>
        <option value="running">运行中</option><option value="input">等待输入</option><option value="retry">模型重试</option><option value="disconnected">连接中断</option>
      </select></label>
      <Button variant="outline" disabled={accepted} onClick={() => setAccepted(true)}>接受新轮次</Button>
      <Button variant="outline" onClick={() => window.setTimeout(() => setOutput(value => value + 1), 120)}>延迟追加输出</Button>
    </div>
    <Messages project={project} thread={thread} action={action} dark={dark} readTurnReview={readReview}
      onLink={() => {}} onFile={() => {}} onReview={() => {}} />
  </section>;
}

export function ConversationTimelinePreview({ dark }: { dark: boolean }) {
  const [live, setLive] = useState(false);
  const [opened, setOpened] = useState("");
  const thread = { id: "timeline-preview", turns: [{ id: "timeline-turn", status: live ? "inProgress" : "completed", durationMs: 19220, startedAt: Math.floor(Date.now() / 1000) - 19,
    items: live ? [...items.slice(0, -1).map(item => item.id === "timeline-command" ? { ...item, status: "inProgress", success: undefined, contentItems: [] } : item),
      { id: "timeline-stream", type: "agentMessage", phase: "commentary", text: "正在输出的正文保持完整，不因后续思考事件而折叠。\n\n".repeat(10) },
      { id: "timeline-reasoning", type: "reasoning", summary: ["继续检查对话展示。"] },
    ] : items }] };
  const project = { id: "timeline-project", root: "/preview", configurations: {}, state: { connected: true, interactions: {}, queues: {},
    threads: { "preview-child": { id: "preview-child", parentThreadId: thread.id, preview: "检查消息投影", turns: [{ status: "completed" }] } } } };
  return <><section id="conversation-timeline" className="design-preview-panel" aria-label="对话时间线预览">
    <h2>对话时间线</h2>
    <div className="design-preview-actions"><Button variant="outline" onClick={() => setLive(!live)}>{live ? "显示已完成" : "显示执行中"}</Button></div>
    <Messages project={project} thread={thread} action={action} dark={dark} reserveResponseSpace={false}
      onLink={setOpened} onFile={setOpened} onReview={() => setOpened("本轮文件变更")} onAgent={setOpened} readTurnReview={readReview} />
    {opened && <p role="status">预览打开：{opened}</p>}
  </section><DisclosureUpdatePreview dark={dark} /><ActivityReadingPreview dark={dark} /></>;
}
