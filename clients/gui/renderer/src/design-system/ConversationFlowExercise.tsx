import { useCallback, useRef, useState } from "react";
import { Messages } from "../Messages.js";
import { ConversationComposer } from "../ConversationComposer.js";
import { Button } from "../components/ui/button.js";
import type { LexicalChatInputHandle } from "../LexicalChatInput.js";
import type { Action, Data } from "../services.js";

const paragraph = (index: number) => `第 ${index} 段：这是一段用于检验阅读位置的合成内容。新的消息继续到达时，旧段落应保持可读。段落编号只用于复验定位，不参与生产组件的分组、折叠或滚动判断。`;
const history = { id: "flow-old-turn", status: "completed", durationMs: 4000, items: [
  { id: "flow-old-user", type: "userMessage", content: [{ type: "text", text: "保留这段合成历史，供回看定位。" }] },
  { id: "flow-history", type: "agentMessage", phase: "final_answer", text: Array.from({ length: 20 }, (_, i) => paragraph(i + 1)).join("\n\n") },
] };
const command = (status: string, outcome?: string): Data => ({ id: "flow-command", type: "dynamicToolCall", tool: "run_command",
  arguments: { command: "printf 'Apples: 16\\nPears: 16\\n'", cwd: "/synthetic" }, status,
  ...(status === "completed" ? { success: outcome !== "failed" } : {}),
  execution: { outcome: outcome ?? (status === "inProgress" ? "running" : "succeeded"), operationId: "synthetic-command" },
  contentItems: [{ type: "inputText", text: JSON.stringify({ processId: "synthetic-process", commandStatus: outcome === "unknown" ? undefined : outcome ?? (status === "inProgress" ? "running" : "succeeded"), state: outcome === "unknown" ? "unknown" : undefined, stdout: status === "completed" ? "Apples: 16\nPears: 16\n" : "", exitCode: outcome === "failed" ? 1 : status === "completed" ? 0 : undefined }) }],
});
const progress = { id: "flow-progress", type: "agentMessage", phase: "commentary", text: "先读取合成结果，再输出可持续增长的长回复。" };
const read = { id: "flow-read", type: "dynamicToolCall", tool: "fs_read", arguments: { path: "synthetic.txt" }, status: "completed", success: true, contentItems: [{ type: "inputText", text: "synthetic read result" }] };

// 只控制外部投影到达顺序；分组、展开、占位和阅读行为仍由生产组件拥有。
export function ConversationFlowExercise({ dark }: { dark: boolean }) {
  const [generation, setGeneration] = useState(0);
  const [step, setStep] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState("");
  const [scenario, setScenario] = useState("");
  const [calls, setCalls] = useState<string[]>([]);
  const api = useRef<LexicalChatInputHandle | null>(null);
  const threadId = `flow-preview-${generation}`;
  const running = step > 0 && step < 8 && !scenario;
  const items: Data[] = [{ id: "flow-user", type: "userMessage", content: [{ type: "text", text: prompt || "合成异常反例" }] }, progress,
    command(step === 1 ? "inProgress" : "completed", scenario === "失败" ? "failed" : scenario === "未知" ? "unknown" : scenario === "未结算" ? "running" : undefined)];
  if (step >= 2) items.push(read);
  if (step >= 3) items.push({ id: "flow-final", type: "agentMessage", phase: "final_answer", text: Array.from({ length: 12 + (step - 3) * 3 }, (_, i) => paragraph(i + 21)).join("\n\n") + (!running ? "\n\nEND_OF_FLOW" : "") });
  const turn = { id: "flow-turn", status: running ? "inProgress" : "completed", durationMs: running ? undefined : 12000, items };
  const thread = { id: threadId, turns: step ? [history, turn] : [history] };
  const project = { id: "flow-project", root: "/synthetic", models: [{ providerId: "preview", modelId: "synthetic", displayName: "合成投影" }], configurations: {}, state: { connected: true, threads: {}, interactions: {}, queues: {} } };
  const action = useCallback((async (name: string) => { setCalls(previous => [...previous, name]); throw Error("本题不连接Core；保留原状态，不执行或重放。" ); }) as Action, []);
  const reset = () => { setGeneration(value => value + 1); setStep(0); setScenario(""); setDraft(""); setPrompt(""); setCalls([]); api.current?.setText(""); };
  return <section id="conversation-flow-exercise" className="design-preview-panel design-preview-flow-panel" aria-label="动态信息流题">
    <h2>动态信息流 · 固定复验题</h2>
    <p>合成投影，不执行命令。先发送，再逐步推进；直接在对话内回看、返回最新和展开工具。</p>
    <div className="design-preview-actions">
      <Button variant="outline" onClick={reset}>重置题目</Button>
      <Button variant="outline" disabled={!running} onClick={() => setStep(value => Math.min(8, value + 1))}>下一事件</Button>
      <Button variant="outline" disabled={!running || step < 3} onClick={() => setStep(8)}>投影完成</Button>
      {['失败', '未知', '未结算'].map(value => <Button key={value} variant="ghost" onClick={() => { setGeneration(n => n + 1); setScenario(value); setStep(8); setCalls([]); }}>{value}反例</Button>)}
    </div>
    <p role="status">{step === 0 ? "等待发送" : scenario ? `${scenario}反例` : running ? `事件 ${step} · 执行中` : "已完成"}</p>
    <div className="design-preview-flow-chat">
      <Messages key={threadId} project={project} thread={thread} action={action} dark={dark} onLink={() => {}} onFile={() => {}} onReview={() => {}} readTurnReview={async () => ({})} />
      <div className="composer-dock"><ConversationComposer project={project} modelConfig={{ model: { providerId: "preview", modelId: "synthetic" } }}
        onConfigureModel={() => {}} onModelSettings={() => {}} initialValue={draft} inputApiRef={api} inputTestId="flow-composer" taskId={threadId} workspacePath="/synthetic"
        placeholder="输入合成验证任务" submitLabel="发送" submitting={running} disabled={step > 0} submitDisabled={step > 0 || !draft.trim()} enableMentionPanel={false} enterSubmits onChange={setDraft}
        onSubmit={value => { if (step || !value.trim()) return false; setPrompt(value); setStep(1); setDraft(""); api.current?.setText(""); }} /></div>
    </div>
    <output aria-label="本地调用记录">{calls.join(", ") || "无Core调用"}</output>
  </section>;
}
