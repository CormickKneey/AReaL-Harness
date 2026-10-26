import { useMemo, useState } from "react";
import { TaskResourcesPopover } from "../views/TaskResourcesPopover.js";
import { SettingsSelect } from "../settings/SettingsPageParts.js";
import type { Action, CommandName, Data } from "../services.js";

const project = {
  id: "context-preview",
  name: "AReaL-Harness",
  root: "/preview/AReaL-Harness",
  state: { connected: true, tasks: {} },
  core: { features: { processes: false } },
};
const sources = [
  "https://www.electronjs.org/releases",
  "https://blog.rust-lang.org/releases",
  "https://nodejs.org/en/about/previous-releases",
  "https://endoflife.date/nodejs",
];

export function TaskContextPreview() {
  const [scenario, setScenario] = useState("ready");
  const [destination, setDestination] = useState("");
  const thread = {
    id: `context-${scenario}`,
    turns:
      scenario === "empty"
        ? []
        : [
            {
              id: "context-turn",
              status: "completed",
              items: [
                {
                  id: "context-input",
                  type: "userMessage",
                  content: [{ type: "text", text: sources.join("\n") }],
                },
              ],
            },
          ],
  };
  // 仅替换服务边界的数据；开关、来源披露和返回由同一生产组件处理。
  const action = useMemo(
    () =>
      (async (command: CommandName, params: Data) => {
        if (command === "workspace") {
          if (scenario === "busy") return new Promise<never>(() => {});
          if (scenario === "failed") throw new Error("示例：工作区读取暂不可用");
          return params.operation === "info"
            ? { git: true, head: "main" }
            : { files: scenario === "empty" ? [] : [{ additions: 120921, deletions: 27122 }] };
        }
        if (command === "tasks") return { data: [] };
        if (command === "manage" && params.operation === "agents")
          return {
            data:
              scenario === "empty"
                ? []
                : Array.from({ length: 17 }, (_, index) => ({
                    id: `context-agent-${index}`,
                    preview: `资源核对 ${index + 1}`,
                    parentThreadId: `context-${scenario}`,
                  })),
          };
        if (command === "manage" && params.operation === "agentWait")
          return {
            data: Array.from({ length: 17 }, (_, index) => ({
              threadId: `context-agent-${index}`,
              status: index < 3 ? (scenario === "unknown" ? "unknown" : "inProgress") : "completed",
            })),
          };
        throw new Error(`该预览不支持 ${command}`);
      }) as Action,
    [scenario],
  );

  return (
    <section className="design-preview-panel" aria-label="任务上下文预览">
      <h2>对话顶部任务资源</h2>
      <p>复用实际顶部入口与资源卡片；数据来自本地固定样例，不连接 Core。</p>
      <div className="design-preview-actions">
        <label>
          资源状态
          <SettingsSelect
            aria-label="资源状态"
            value={scenario}
            onValueChange={(value) => {
              setScenario(value);
              setDestination("");
            }}
          >
            <option value="ready">有改动与来源</option>
            <option value="empty">空态</option>
            <option value="busy">读取中</option>
            <option value="failed">读取失败</option>
            <option value="unknown">子代理待确认</option>
          </SettingsSelect>
        </label>
        <TaskResourcesPopover
          key={scenario}
          project={project}
          thread={thread}
          action={action}
          onPanel={setDestination}
          onAgent={setDestination}
          onFile={setDestination}
          onLink={setDestination}
          onAddSource={() => setDestination("来源添加入口已打开；生产路径由 Composer 维护草稿")}
          onAddSchedule={() => setDestination("定时任务创建入口已打开")}
        />
      </div>
      <p role="status">{destination || "点击任务资源按钮，核对来源展开、查看全部与返回。"}</p>
    </section>
  );
}
