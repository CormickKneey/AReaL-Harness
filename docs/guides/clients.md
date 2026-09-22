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

省略 endpoint 时，交互式 TUI 连接共享 Core/Runtime，监听随机 loopback 端口。同一工作区多个窗口复用服务，关闭窗口保留后台服务和任务。`--prompt`、`--goal`、`--input-file` 默认使用 owned 模式，退出后清理所拥有的服务；`--local-mode shared|owned` 可覆盖默认选择。显式 endpoint（别名 `--remote`）只连接已有服务，不能与本地部署参数混用。

共享模式默认在 `~/.areal-harness/instances/` 下按工作区保存数据；显式数据目录配置保持优先级。旧 `~/.areal-harness/state` 历史须使用 `--data-dir`，或停止旧 Core 后绑定。模型 TOML 配置自动热更新；其他 TOML 变化等待后台工作结算后重启，权限/部署参数变化需显式 restart。发现、迁移、日志和 Desktop 接入见[本地服务契约](../api/local-service.md)。

```sh
target/debug/areal web --workspace /absolute/task
target/debug/areal service list --json
target/debug/areal service status --json
target/debug/areal service restart --json
target/debug/areal service stop --json
```

`areal -p 'prompt' --output-format stream-json --verbose` 提供非交互 CLI，`areal serve` 启动持续服务；参数、认证、恢复与退出码见 [CLI 契约](../api/claude-cli.md)。Web 位于服务的 `/ui`，使用服务数据目录 `security/auth.json` 中的本地 token 登录。

TUI 的 `--input-file /absolute/input.json` 与 `--prompt` 互斥，接受最多 2 MiB 的 Core Input 数组，如 `[{"type":"text","text":"Inspect the image"},{"type":"localImage","path":"/absolute/image.png"}]`。本地模式和显式 endpoint 均支持，可信 launcher 可用 `--tui --input-file` 透传；媒体路径与字段仍按 [Core API](../api/core.md) 验证。

## Web 操作与外观

Web 采用中性灰工作台布局：240px 可收起侧栏、任务标题与视图标签、居中会话内容，以及圆角输入框。浅色和深色外观对齐 AReaLGameAgent 的工作台；默认跟随系统，也可在侧栏底部「设置 → 外观」切换，偏好保存在当前浏览器。窄屏使用可关闭的任务导航抽屉。

- 通过侧栏新建、切换、刷新或分页加载任务；新任务显示居中的输入区域，产生记录后输入框固定在底部。
- 在「设置 → 本地连接」输入访问令牌；认证失败时在设置内显示错误。连接断开后可重新认证连接并恢复当前任务快照。
- Enter 发送，Shift + Enter 换行；输入法确认候选字不发送。运行中可以追加说明或停止执行。
- 输入框上方的「持续目标」可展开查看预算与进度、创建或编辑目标、暂停、恢复和清除；有活动 Goal 时停止按钮暂停目标，自动续轮保留来源标记。
- 「任务记录」展示消息和可展开的工具结果；UNKNOWN 工具结果仍需记录检查说明。「协同任务与验收」保留计划提交、进度查询、取消和调整入口。

外观与导航由 Web 客户端维护，任务、权限和执行状态以 Core 返回的数据为准。

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
| 点击历史摘要 | 展开组后，再展开指定记录；滚轮滚动历史 |
| ↑/↓、Enter/Space、←/→ | 历史焦点下选择、切换、收起/展开；Esc 返回输入框 |
| Ctrl-O、`/details` | 切换紧凑/详细历史，保留局部展开选择 |
| `/restore-input` | 恢复提交失败或结果未确认时保留的输入 |

`--prompt` 只输出本次 Turn 的文本，Thread ID 写 stderr；失败返回非零，不读取 TUI 偏好。外观配置见[配置指南](configuration.md#tui)。

## 思考与等待状态

Web 将 Chat Completions / Responses 返回的思考文本放在可展开的“模型思考”区域，只有摘要时标为“思考摘要”，正文独立展示。等待正文期间显示“正在等待模型回复”或“已收到模型思考”，并显示本页观察到的等待秒数；超过 30 秒提示可继续等待、刷新或停止。这是界面提醒，不表示模型超时或停止。刷新当前任务保留同一请求的观察计时，重新打开页面从当前观察时刻计时。

“刷新任务”显示刷新状态，以 Core 的最新快照替换历史。“停止执行”提交取消后显示“正在停止”，等 Core 结束任务与工具；连接断开时控制按钮禁用，服务端任务可能仍继续。恢复连接后先刷新确认状态，不自动重发任务。

TUI 默认紧凑显示：连续工具调用、思考和过程正文合为一条 Activity 摘要，参数、成功输出首行及思考需显式展开。最终回复直接显示；无阶段标记的旧消息保留正文。点击组后再点指定记录，或用 Tab 将焦点移入历史并使用上表按键。`--mouse=false` 关闭捕获，保留终端原生选择行为。

错误原因保留在所属 Turn 旁，重连后仍可见；不显示空 Agent 标题。失败前部分回复标记为未完成，Goal 阻塞、等待交互、自动重试和未确认用量均有明确提示。提交失败仅在输入框为空时自动恢复原输入；`/restore-input` 显式替换当前草稿。断线显示状态待同步，不自动重发提交或工具。非交互输出沿用正文输出行为。详见 [TUI 设计](../design/tui.md)与 [Core API](../api/core.md#思考进度)。

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

`--goal` 与 `--prompt` / `--input-file` 互斥，可用 `--resume THREAD_ID` 在已有空闲 Thread 中创建新 Goal。headless 跨 Turn 等待目标终态，仅 completed 返回成功；其他停止状态返回非零并输出目标 JSON 和原因。远端 headless 退出或断连不取消服务器上的 Goal；owned 本地 launcher 退出会关闭所拥有的 Core，shared 模式仅断开连接。通过交互式 `/open` 和 `/goal-resume` 恢复已停止目标。普通 `--prompt`、Claude CLI 入口保持单次执行语义。

Core 重启后 active 目标恢复为 paused/serverRestarted，`thread/resume` 只恢复订阅，不自动运行。未知模型消费不会补零；显式 Goal resume 确认保守预留并继续保留该消费。工具 UNKNOWN 仍须检查和 acknowledge。预算、活动时间、轮次或历史容量耗尽时停止，不自动重试。预算配置见 [执行策略](configuration.md#goals)，接口字段见 [Core API](../api/core.md#goals)。
