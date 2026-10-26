import type { Data } from "../services.js";

// Authored replay of the observed read-only task, not a recording of Core events.
export const scenarioPrompt =
  "读取项目说明和两份水果清单，运行汇总命令；同时委派子代理独立核对数量，查看蓝色示例图片，最后用表格汇总结果。";
export const childId = "fixture-summary";
export const lastStep = 12;
export const stages = [
  "等待发送",
  "读取项目说明",
  "启动命令与子代理",
  "命令输出 · 第一批",
  "图片就绪 · 子代理核对中",
  "命令完成 · 子代理仍在工作",
  "子代理完成 · 汇总结果",
  "生成最终回答",
  "生成最终回答",
  "生成最终回答",
  "生成最终回答",
  "生成最终回答",
  "任务完成",
];
export const imageUri = "areal-blob:conversation-blue-card";
export const imageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" rx="24" fill="#123c69"/><text x="480" y="278" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="40">SYNTHETIC BLUE CARD</text></svg>`;
const tool = (id: string, name: string, args: Data, result?: Data): Data => ({
  id,
  type: "dynamicToolCall",
  tool: name,
  arguments: args,
  status: result ? "completed" : "inProgress",
  ...(result
    ? { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] }
    : {}),
});
const comment = (id: string, text: string): Data => ({
  id,
  type: "agentMessage",
  phase: "commentary",
  text,
});
const user = (id: string, text: string): Data => ({
  id,
  type: "userMessage",
  content: [{ type: "text", text }],
});
export const finalText = `## 验证结果

已读取项目说明、汇总两份清单，并与子代理的独立核对结果交叉检查。命令和子代理均已完成。

| 活动 | 结果 |
| --- | --- |
| 项目说明 | Zeebo 是 macOS 语音协作助手 |
| 命令执行 | 两份清单读取完成，退出码 0 |
| 图片查看 | 深蓝色卡片，白色文字 SYNTHETIC BLUE CARD |
| 子代理 | 独立核对完成，数量与命令输出一致 |

### 数量汇总

alpha.txt 包含 12 个苹果、7 个梨；beta.txt 包含 4 个苹果、9 个梨。合计 **16 个苹果、16 个梨，共 32 个水果**。

### 操作范围

本次只读取项目说明、两份清单和示例图片，未修改项目文件，也未安装依赖。子代理的独立核对与命令结果一致。

以上为本地演示数据。`;
export const history: Data = {
  id: "flow-old-turn",
  status: "completed",
  durationMs: 4000,
  items: [
    user("flow-old-user", "先约定这次只读验证的范围和核对方法。"),
    {
      id: "flow-history",
      type: "agentMessage",
      phase: "final_answer",
      text: `## 本次验证约定

我们用一条包含命令、子代理和图片的任务检查信息流。重点是让执行事实、阅读行为和最终结论相互对应。

**项目说明。** 先读取 README，确认项目的用途；引用来自文件读取结果，不能由模型猜测补全。

**原始清单。** alpha.txt 与 beta.txt 分别保存两批水果。每批的项目和数量都应保留在命令输出里，方便独立复核。

**进程身份。** 同一条命令可能多次返回输出。后续读取应归到原进程，不能把每次读取都显示成重新执行了一次命令。

**独立核对。** 子代理只负责核对数量。主任务与子代理可以同时工作，它们的完成状态需要分别表达。

**资源查看。** 图片通过自己的入口打开。关闭图片只结束查看，不停止主任务，也不丢失已经展开的命令详情。

**历史阅读。** 新结果到达时，如果读者正在看这段历史，应继续保留正在阅读的内容。只有明确返回最新后，才恢复跟随新回复。

**完成条件。** 命令结束、子代理返回并且最终回答生成完毕后，过程可以收敛为可展开的总组。最终结论仍应独立可读。

**验证边界。** 本地演示使用确定性的投影数据；它能验证组件和交互，真实执行仍需要 Core 与 Runtime 的证据。`,
    },
  ],
};

export function scenarioProjection(
  step: number,
  threadId: string,
  prompt: string,
  startedAt: number,
  exception = "",
) {
  const at = exception ? lastStep : step;
  const done = at >= lastStep;
  const items: Data[] = [
    user("flow-user", prompt || scenarioPrompt),
    comment("flow-progress", "我会先读取项目说明，再运行清单汇总；同时让子代理独立核对数量。"),
  ];
  items.push(
    tool(
      "flow-read",
      "fs_read",
      { path: "README.md" },
      at >= 2 ? { text: "Zeebo is a macOS voice collaboration assistant." } : undefined,
    ),
  );
  if (at >= 2) {
    items.push(
      tool(
        "flow-command",
        "run_command",
        {
          command: `awk -F': ' 'FNR == 1 {print FILENAME} {print} /Apples/ {a += $2} /Pears/ {p += $2} END {printf "Total — Apples: %d, Pears: %d, Fruit: %d\\n", a, p, a+p}' fixtures/alpha.txt fixtures/beta.txt`,
          cwd: "/validation/zeebo-bot",
        },
        {
          processId: "fruit-summary",
          state: "running",
          commandStatus: "running",
          stdout: "",
          nextCursor: "page-0",
          outputReadComplete: false,
        },
      ),
    );
    items.push(
      tool(
        "flow-agent",
        "agent_spawn",
        {
          input: [
            { type: "text", text: "只读核对 alpha.txt 与 beta.txt，分别列出数量并计算总计。" },
          ],
        },
        { threadId: childId },
      ),
    );
  }
  if (at >= 3)
    items.push(
      tool(
        "flow-output-1",
        "read_process",
        { processId: "fruit-summary", cursor: "page-0" },
        {
          processId: "fruit-summary",
          state: "running",
          commandStatus: "running",
          stdout: "alpha.txt\n  Apples: 12\n  Pears: 7\n",
          nextCursor: "page-1",
          outputReadComplete: false,
        },
      ),
    );
  if (at >= 3)
    items.push(
      comment("flow-parallel", "命令正在读取两批清单，子代理同时核对。我会继续查看示例图片。"),
    );
  if (at >= 3)
    items.push(
      at >= 4
        ? {
            id: "flow-image",
            type: "dynamicToolCall",
            tool: "browser_v1",
            arguments: { operation: "inspect_image" },
            status: "completed",
            success: true,
            contentItems: [{ type: "arealMedia", modality: "image", media: { uri: imageUri } }],
          }
        : tool("flow-image", "browser_v1", { operation: "inspect_image" }),
    );
  if (at >= 4)
    items.push(
      tool(
        "flow-output-2",
        "read_process",
        { processId: "fruit-summary", cursor: "page-1" },
        {
          processId: "fruit-summary",
          state: "running",
          commandStatus: "running",
          stdout: "beta.txt\n  Apples: 4\n  Pears: 9\n",
          nextCursor: "page-2",
          outputReadComplete: false,
        },
      ),
    );
  if (at >= 5)
    items.push(
      tool(
        "flow-output-3",
        "read_process",
        { processId: "fruit-summary", cursor: "page-2" },
        {
          processId: "fruit-summary",
          state: exception === "未知" ? "unknown" : exception === "未结算" ? "running" : "exited",
          commandStatus:
            exception === "未知"
              ? undefined
              : exception === "未结算"
                ? "running"
                : exception === "失败"
                  ? "failed"
                  : "succeeded",
          stdout: "\nTotal — Apples: 16, Pears: 16, Fruit: 32\n",
          nextCursor: "page-3",
          exitCode: ["未知", "未结算"].includes(exception)
            ? undefined
            : exception === "失败"
              ? 1
              : 0,
          outputReadComplete: true,
        },
      ),
    );
  if (at >= 5)
    items.push(
      comment(
        "flow-check",
        "清单读取完成，图片是深蓝色卡片。子代理仍在核对，我会等它的结果再给出最终汇总。",
      ),
    );
  if (at >= 6)
    items.push(
      tool(
        "flow-wait",
        "agent_wait",
        { threadId: childId },
        {
          threadId: childId,
          status: "completed",
          settled: true,
          timedOut: false,
          text: "Apples: 16; Pears: 16; total: 32",
        },
      ),
    );
  if (at >= 7)
    items.push({
      id: "flow-final",
      type: "agentMessage",
      phase: "final_answer",
      text: finalText.slice(
        0,
        done ? undefined : Math.floor(finalText.length * [0.12, 0.28, 0.44, 0.64, 0.84][at - 7]),
      ),
    });
  if (exception === "未知") {
    const command = items.find((item) => item.id === "flow-command")!;
    command.execution = { outcome: "unknown", operationId: "fixture-command-unknown" };
  }
  const childItems: Data[] = [
    user("child-task", "独立核对两份水果清单并汇总数量。"),
    comment("child-progress", "我会分别读取两份清单，核对苹果和梨的数量。"),
  ];
  if (at >= 3)
    childItems.push(
      tool(
        "child-read",
        "fs_read",
        { path: "fixtures/alpha.txt" },
        { text: "Apples: 12\nPears: 7" },
      ),
    );
  if (at >= 4)
    childItems.push(
      tool(
        "child-read-beta",
        "fs_read",
        { path: "fixtures/beta.txt" },
        { text: "Apples: 4\nPears: 9" },
      ),
    );
  if (at >= 6)
    childItems.push({
      id: "child-final",
      type: "agentMessage",
      phase: "final_answer",
      text: "独立核对完成。\n\n| 清单 | 苹果 | 梨 |\n| --- | --- | --- |\n| alpha.txt | 12 | 7 |\n| beta.txt | 4 | 9 |\n| **合计** | **16** | **16** |\n\n共 **32** 个水果，与主任务命令结果一致。",
    });
  const child = {
    id: childId,
    parentThreadId: threadId,
    preview: "清单独立核对",
    turns: [
      {
        id: "child-turn",
        startedAt,
        status: at >= 6 ? "completed" : "inProgress",
        ...(at >= 6 ? { durationMs: 11000 } : {}),
        items: childItems,
      },
    ],
  };
  return {
    turn: {
      id: "flow-turn",
      startedAt,
      status: done ? "completed" : "inProgress",
      ...(done ? { durationMs: 36000 } : {}),
      items,
    },
    child,
  };
}
