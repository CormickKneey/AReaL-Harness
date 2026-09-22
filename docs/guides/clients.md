**中文** | [English](clients.en.md)

# CLI、TUI 与本地 Web

先完成[快速开始](quickstart.md)。客户端使用同一 Core 历史；工具由 Runtime 执行，不需要 Codex 二进制。

## 启动

```sh
make tui
make tui ARGS='--resume THREAD_ID'
make tui ARGS='--workspace /absolute/task --allow-write --prompt "Describe the task"'
# 连接已有服务；使用它的数据目录中的认证文件
make tui ARGS='--endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json'
```

省略 endpoint 时 TUI 通过内嵌 launcher 启动本地 Core/Runtime，监听随机 loopback 端口；退出会关闭服务。显式 endpoint（别名 `--remote`）只连接已有服务，退出仅断开客户端。客户端本地部署参数不能与 endpoint 混用。

默认数据目录为 `~/.areal-harness/state`，日志为其中 `launch-*.log`；数据目录和可信二进制须位于可写工作区外。同一数据目录有独占锁，多实例需分别配置。launcher 使用系统 `/usr/bin/python3 -I -S`，不导入工作区代码。

`areal -p 'prompt' --output-format stream-json --verbose` 提供非交互 CLI，`areal serve` 启动持续服务；参数、认证、恢复与退出码见 [CLI 契约](../api/claude-cli.md)。Web 位于服务的 `/ui`，使用服务数据目录 `security/auth.json` 中的本地 token 登录。

TUI 的 `--input-file /absolute/input.json` 与 `--prompt` 互斥，接受最多 2 MiB 的 Core Input 数组，如 `[{"type":"text","text":"Inspect the image"},{"type":"localImage","path":"/absolute/image.png"}]`。本地模式和显式 endpoint 均支持，可信 launcher 可用 `--tui --input-file` 透传；媒体路径与字段仍按 [Core API](../api/core.md) 验证。

## TUI 操作

| 操作 | 行为 |
|---|---|
| Enter | 空闲时开始 Turn；运行中追加指令 |
| `/`、Tab、Esc | Slash 候选、补全和关闭候选 |
| Ctrl-C / Ctrl-Q | 暂停当前 Goal 并取消 Turn（无 Goal 时中断 Turn）/ 退出 |
| Ctrl-R | 重连并恢复快照，不重放请求 |
| F5、`/sessions`、`/new`、`/open ID` | 选择、创建或打开会话 |
| F6、`/model` | 空闲时选择模型或恢复默认值 |
| F2、`/theme` | 预览主题，Enter 保存，Esc 撤回 |
| `/agents`、F3、`/topology` | 子任务树与根拓扑 |
| `/spawn prompt` | 手工派发当前 Turn 的子任务 |
| `/tasks`、`/groups` | 计划与 Workgroup |
| PageUp/PageDown/Home、End | 阅读历史；End 恢复跟随 |

`--prompt` 只输出本次 Turn 的文本，Thread ID 写 stderr；失败返回非零，不读取 TUI 偏好。外观配置见[配置指南](configuration.md#tui)。

## 历史、恢复与观测

Core 保存原始历史、工具意图与结果；上下文压缩只改变后续模型视图。工作区根 `AGENTS.md` 通过 Runtime 读取（普通 UTF-8，最多 32 KiB），不自动递归加载子目录。默认 Agent 委派共享工作区，隔离写入用 [Workgroup](workgroups.md)。

重启把未确认的工具/hooks 标为 UNKNOWN 并阻止新 Turn。检查实际文件与进程后，在 Web 中记录检查或调用 `areal/tool/acknowledge`，历史仍保留 unknown。它不是重放、审批或旧进程恢复。损坏快照不会被静默丢弃。

```sh
export OTEL_SERVICE_NAME='areal-core'
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4318'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
make server
```

OTLP 仅支持 HTTP/protobuf；未设置 endpoint 不启用，`OTEL_SDK_DISABLED=true` 可关闭。默认 span 记录 ID、usage、状态和时长，不采集提示正文或凭据。上报失败不改变 Turn 结果。

<a id="goals"></a>
## Goal 模式

无需修改配置；交互式 TUI 输入 `/goal 完成模块迁移并通过相关测试` 创建并运行目标；`/goal` 查看当前状态。`/goal-pause` 暂停，等待活动 Turn 清理完毕后用 `/goal-resume` 恢复；`/goal-edit 新目标`、`/goal-budget 200000`（或 `none`）仅编辑已停止目标，保留累计用量。`/goal-clear` 清除已停止且队列与资源均已结算的目标。Web 的 Goal 面板提供对应操作。

目标状态、token 用量、活动时间、Turn 次数和停止原因展示在客户端。自动续轮有单独的来源标记。普通最终回复只结束当前 Turn；模型通过 `goal_update` 报告完成，并在 Core 结算完资源后提交目标终态。用户追问优先于自动续轮，追加输入会使旧完成申请失效。

```sh
make tui ARGS='--goal "完成模块迁移并通过相关测试" --goal-token-budget 200000'
target/debug/areal-tui --endpoint ws://127.0.0.1:4500 --goal '检查代码并整理迁移建议'
```

`--goal` 与 `--prompt` / `--input-file` 互斥，可用 `--resume THREAD_ID` 在已有空闲 Thread 中创建新 Goal。headless 跨 Turn 等待目标终态，仅 completed 返回成功；其他停止状态返回非零并输出目标 JSON 和原因。远端 headless 退出或断连不取消服务器上的 Goal；本地 launcher 退出会关闭所拥有的 Core。通过交互式 `/open` 和 `/goal-resume` 恢复已停止目标。普通 `--prompt`、Claude CLI 入口保持单次执行语义。

Core 重启后 active 目标恢复为 paused/serverRestarted，`thread/resume` 只恢复订阅，不自动运行。未知模型消费不会补零；显式 Goal resume 确认保守预留并继续保留该消费。工具 UNKNOWN 仍须检查和 acknowledge。预算、活动时间、轮次或历史容量耗尽时停止，不自动重试。预算配置见 [执行策略](configuration.md#goals)，接口字段见 [Core API](../api/core.md#goals)。
