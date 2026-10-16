import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "../workbench.css";
import "./preview.css";
import { ConversationComposer } from "../ConversationComposer.js";
import { ApprovalRequest } from "../ApprovalRequest.js";
import { SideChatPane } from "../SideChatPane.js";
import { Button } from "../components/ui/button.js";
import { Feedback } from "../components/ui/feedback.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { TurnExecution } from "../TurnExecution.js";
import { Messages } from "../Messages.js";
import type { LexicalChatInputHandle } from "../LexicalChatInput.js";
import type { Action, CommandName } from "../services.js";
import { tokenGroups } from "./catalog.js";
import { setApplicationPreferences, useAppearance } from "../settings/applicationPreferences.js";

const project = {
  id: "design-preview", root: "/preview", pending: [],
  core: { instanceId: "design-preview", connectionGeneration: 1, features: { sidePreview: true } },
  state: { connected: true, threads: {}, interactions: {}, queues: {} },
  models: [{ providerId: "preview", modelId: "example", displayName: "示例模型", reasoningEffortOptions: ["low", "medium", "high"] }],
  configurations: { main: { model: { providerId: "preview", modelId: "example" }, parameters: { reasoningEffort: "medium" } } },
};
const source = { id: "main", preview: "示例主聊天", turns: [], updatedAt: 1 };
const approval = { requestId: "preview-approval", threadId: "main", tool: "fs_create",
  effectiveArguments: { path: "example.txt", text: "示例文本 Example content" }, effectivePermissions: { rememberAllowed: true } };
const states = { ready: "可操作", busy: "提交中", failed: "明确失败", unknown: "结果待核对" } as const;
type PreviewState = keyof typeof states;

const longMessage = `# 长消息预览\n\n${Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 段：保留原始内容，长文本默认展示开头，展开后可完整阅读。 Long text stays complete and readable.`).join("\n\n")}\n\n[末尾链接](https://example.com)\n\n全文结束 END_OF_LONG_MESSAGE`;
const messagePreview = { id: "long-text-preview", turns: [{ id: "preview-messages", status: "completed", items: [
  { id: "long", type: "userMessage", content: [{ type: "text", text: longMessage }] },
  { id: "short", type: "userMessage", content: [{ type: "text", text: "短消息直接完整展示。" }] },
  { id: "wrapped", type: "userMessage", content: [{ type: "text", text: "随宽度重新判断折叠，文字保留。".repeat(12) }] },
] }] };

const motionText = "流式文字沿用当前主题，新内容柔和显现，已经读过的内容保持稳定。\n\nStreaming text stays readable as each new fragment arrives.\n\n- 支持**加粗**和 `行内代码`\n- 保留中文、English 与换行";
function ChatMotionPreview({ dark }: { dark: boolean }) {
  const [length, setLength] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    let cursor = 0;
    setLength(0);
    const timer = setInterval(() => {
      cursor = Math.min(cursor + 8, motionText.length);
      setLength(cursor);
      if (cursor === motionText.length) setPlaying(false);
    }, 120);
    return () => clearInterval(timer);
  }, [playing]);
  return <section className="design-preview-panel" aria-label="聊天动效预览">
    <h2>流式输出与等待状态</h2>
    <TurnExecution items={[]} turn={{ id: "preview-turn", status: "inProgress", items: [] }} project={project} threadId="main" renderItem={() => null} />
    <div className="design-preview-actions">
      <Button variant="outline" disabled={playing} onClick={() => setPlaying(true)}>播放流式输出</Button>
      <Button variant="ghost" disabled={playing} onClick={() => setLength(value => Math.min(value + 8, motionText.length))}>追加片段</Button>
      <Button variant="ghost" disabled={playing} onClick={() => setLength(motionText.length)}>完成输出</Button>
    </div>
    <div data-testid="preview-stream"><MessageResponse className="conversation-markdown" preserveLineBreaks streaming={length > 0 && length < motionText.length} theme={dark ? "dark" : "light"}>{motionText.slice(0, length)}</MessageResponse></div>
  </section>;
}

function Preview() {
  const [dark, setDark] = useState(false);
  const [fontSize, setFontSize] = useState("14");
  const [width, setWidth] = useState("wide");
  const [state, setState] = useState<PreviewState>("ready");
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [reducedMotion, setReducedMotion] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const api = useRef<LexicalChatInputHandle | null>(null);
  useAppearance(dark);
  useLayoutEffect(() => { setApplicationPreferences({ reducedMotion: reducedMotion ? "on" : "off" }); }, [reducedMotion]);
  useEffect(() => { document.querySelector(".design-preview")?.scrollTo(0, 0); }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("theme-areal-light", !dark);
    root.classList.toggle("theme-areal-dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    root.style.setProperty("--ui-font-size", `${fontSize}px`);
    const css = getComputedStyle(root);
    setValues(Object.fromEntries(tokenGroups.flatMap(group => group.tokens.map(([name]) => [name, css.getPropertyValue(name).trim()]))));
  }, [dark, fontSize]);
  // fixture 只接受 respond；其余 Action 重载均明确拒绝，不伪造业务返回值。
  // 只反馈本地状态，不读取 preload，也不连接 Core 或供应商。
  const action = (async (name: CommandName) => {
    if (name !== "respond") throw new Error("组件预览保留业务入口，不执行真实操作。");
    if (state === "busy") return new Promise<never>(() => {});
    if (state === "failed") throw new Error("示例：操作未受理，内容已保留。");
    if (state === "unknown") throw Object.assign(new Error("示例：等待核对"), { submissionUnknown: true });
    return {};
  }) as Action;
  const disabled = state === "busy" || state === "unknown";
  return <main className="design-preview" data-width={width}>
    <header className="design-preview-header">
      <div><h1>客户端设计系统</h1><p>生产组件与语义 Token · 本地预览</p></div>
      <label>主题<select aria-label="主题" value={dark ? "dark" : "light"} onChange={event => setDark(event.target.value === "dark")}><option value="light">明亮</option><option value="dark">深色</option></select></label>
      <label>字号<select aria-label="字号" value={fontSize} onChange={event => setFontSize(event.target.value)}><option value="14">14</option><option value="18">18</option></select></label>
      <label>面板宽度<select aria-label="面板宽度" value={width} onChange={event => setWidth(event.target.value)}><option value="wide">宽面板</option><option value="narrow">窄面板</option></select></label>
      <label>状态<select aria-label="状态" value={state} onChange={event => { setState(event.target.value as PreviewState); setMessage(""); }}>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>减少动态效果<input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /></label>
    </header>
    <section className="design-preview-panel" aria-label="公共控件">
      <h2>按钮与反馈</h2><div className="design-preview-actions"><Button>主要动作</Button><Button variant="outline">次要动作</Button><Button variant="ghost">辅助动作</Button><Button disabled>不可用</Button></div>
      <Feedback error={state === "failed" ? "操作未受理，请检查后重试。" : undefined} message={state === "unknown" ? "结果待核对，保留当前内容。" : "反馈跟随所属组件，错误与等待保持不同含义。"} />
    </section>
    <section className="design-preview-panel" aria-label="Composer 预览">
      <h2>Composer</h2>
      <div className="composer-dock">
        <ConversationComposer project={project} modelConfig={project.configurations.main} modelDisabled={disabled}
          onConfigureModel={() => setMessage("模型配置仅作预览。")} onModelSettings={() => setMessage("配置入口仅作预览。")}
          initialValue={text} inputApiRef={api} inputTestId="preview-composer" workspacePath="/preview" taskId="preview-main" placeholder="随心输入"
          disabled={disabled} submitDisabled={disabled || !text.trim()} submitting={state === "busy"} submitLabel="发送"
          enterSubmits enableMentionPanel={false} onChange={setText} onSubmit={() => { setMessage("预览收到输入，草稿保留。"); return false; }} />
      </div>
      <Feedback message={message} />
    </section>
    <ChatMotionPreview dark={dark} />
    <section className="design-preview-panel design-preview-messages" aria-label="长文本预览">
      <h2>已发送消息 · 渐进展示</h2>
      <Messages project={project} thread={messagePreview} action={action} dark={dark} reserveResponseSpace={false}
        onLink={() => setMessage("链接入口仅作预览。")} onFile={() => {}} onReview={() => {}} readTurnReview={async () => ({})} />
    </section>
    <section className="design-preview-panel" aria-label="审批预览">
      <h2>审批卡片</h2><ApprovalRequest key={state} item={approval} projectId="design-preview" action={action} />
    </section>
    <section className="design-preview-panel design-preview-side" aria-label="Side 预览">
      <h2>Side Chat</h2><SideChatPane project={project} source={source} action={action} dark={dark}
        onReturn={() => setMessage("关闭入口仅作预览。")} onPanel={() => setMessage("面板入口仅作预览。")} />
    </section>
    <section className="design-preview-tokens" aria-label="Token 目录">
      <h2>Token 角色与当前值</h2>{tokenGroups.map(group => <div key={group.title}><h3>{group.title}</h3><dl>{group.tokens.map(([name, role]) => <div key={name}><dt><code>{name}</code><span>{role}</span></dt><dd data-token={name}>{values[name]}</dd></div>)}</dl></div>)}
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<TooltipProvider><Preview /></TooltipProvider>);
