**中文** | [English](local-service.en.md)

# 共享本地服务

TUI、Web 启动入口和可信 Desktop Main 共用 `areal service`，由独立 `areal-service-host` 托管一组 Core/Runtime。窗口只拥有连接。运行平台沿用[Runtime 边界](../guides/runtime.md)，不是系统级、多用户或远程 daemon。

## 公共入口

```sh
target/debug/areal service ensure --workspace /absolute/workspace --json
target/debug/areal service list --json
target/debug/areal service status --json
target/debug/areal service restart --json
target/debug/areal service stop --json
# 显式取消当前工作并等待结算
target/debug/areal service stop --instance INSTANCE_ID --cancel --json
target/debug/areal web --workspace /absolute/workspace
# Desktop Main 获取同一描述，不打开浏览器
target/debug/areal web --workspace /absolute/workspace --json
```

`ensure`、`restart` 和 `web` 接受同一组本地参数：`--config`、`--workspace`、`--data-dir`、`--allow-write`、`--allow-network`、`--allow-concurrent-writes`、`--workgroup-policy`、`--workgroup-toolchain`、`--command-timeout-ms`、`--command-output-bytes`、`--model-endpoint`、`--model-protocol`、`--model`、`--model-provider`、`--api-key-env`、`--desktop-config`。默认工作区是当前目录；服务监听随机 loopback 端口。未配置模型时可启动管理服务，运行模型任务仍需有效配置。

`status`、`stop` 默认定位当前工作区，可用 `--workspace`、`--data-dir` 或 `--instance` 消歧。`restart` 按当前工作区和与 `ensure` 相同的参数解析目标部署；使用自定义配置/权限时传入对应参数。重启保留历史，有未结算工作时拒绝，只有显式 `--cancel` 才取消任务。

服务命令 stdout 始终是 JSON，`--json` 显式声明机器调用；`web` 默认另打开浏览器，`--json` 只发现。ensure/restart/status/stop 返回一个描述，list 返回数组，bind 返回 `{dataDir}`。操作失败退出 1，stderr 为 `{error:{code:"localServiceError",message}}`；参数解析错误遵循 CLI 行为。启动诊断写 stderr 或私有日志，不把 token 放入命令、URL 或描述。

描述字段见 [local-service-v1.json](../../schemas/local-service-v1.json)：

| 字段 | 含义 |
|---|---|
| `protocolVersion` | 发现与控制协议版本，当前 1 |
| `serviceId` | 规范 dataDir 路径 SHA-256 的前 24 个十六进制字符，重启保持 |
| `generation` | 每次启动的新 UUID；不是 Runtime epoch 或工具 Host generation |
| `workspace`, `dataDir` | 规范绝对路径 |
| `configFingerprint` | 部署配置、模型 CLI/环境覆盖、权限、部署文件与二进制内容的摘要；热更新模型值独立版本化 |
| `endpoint`, `webUrl` | Core WebSocket 与 `/ui` URL |
| `authFile`, `logFile` | 可信调用方读取的认证文件与宿主日志路径 |
| `hostPid`, `corePid` | 仅用于诊断，不能据此对旧 PID 发信号 |
| `state` | `ready`、`stopping`、`stopped` 或 `unavailable` |

## 实例、兼容性与历史

同一 dataDir 只允许一个 Core。`ensure` 串行化并发启动，发现运行实例后校验身份和配置；模型文件变更原地热更新；其他 TOML 配置和二进制更新在空闲时自动重启，有后台工作时拒绝自动重启。权限、Runtime、部署文件或模型 CLI/环境覆盖变化需执行 `areal service restart`。不会静默扩大写/网络权限，也不会杀掉未被托管的旧 Core。符号链接按规范路径识别。

未显式配置 dataDir 时，共享入口使用 `$AREAL_HARNESS_HOME/instances/<workspace-hash前24位>/state`；home 默认 `~/.areal-harness`。显式 CLI、环境变量或 TOML 中的 dataDir 保持配置优先级。独占 launcher、非交互 CLI 的默认目录保持原有规则。

旧 `~/.areal-harness/state` 不自动搬迁或混入新工作区。可显式指定 `--data-dir`，或停止旧 Core 后绑定默认目录：

```sh
target/debug/areal service bind --workspace /absolute/workspace \
  --data-dir /absolute/old-state --json
```

首次绑定会持有 Core 数据锁并检查历史 Thread 的 cwd 都位于该工作区，再写入 `service-workspace` 绑定文件；不复制历史。工作区默认映射保存在 home 的 `workspaces/`。已绑定的数据不能换工作区；混合历史需先单独整理。数据和服务登记须位于工作区外，写模式的可信二进制也须在工作区外。

兼容性将部署身份与默认模型版本分开。模型热更新完整校验 TOML，失败时保留旧配置。限额、权限、运行时预算、部署清单/工具扩展/Workgroup policy 和二进制内容仍保留重启边界。模型凭据值不写入摘要或登记；服务继承首次启动的环境，修改凭据或其他环境必须显式重启。运行中的 Provider/Thread 配置仍由 Core 管理，不属于客户端窗口状态。

## 生命周期与恢复

关闭窗口只断开连接；活动 Turn/Goal 可继续，多个窗口可订阅同一 Thread。相同 Thread 的并发写入仍遵循 Core 的准入、CAS、队列及 requestId 规则。显式取消与关闭窗口是不同操作。

服务没有闲置退出计时器。模型文件更新保持 generation 和连接；其他 TOML 更新由 TUI 在后台工作结算后发起安全重启。Web 等客户端可运行 `areal service ensure` 或 `restart`；浏览器不拥有进程生命周期。默认 stop 检查 `restartSafe`、`activeGoals`、`pendingQueueItems`，再通过 `drain(strategy="ifIdle")` 在 Core 准入锁内复查；有工作或资源时拒绝且不暂停任务；`--cancel` 通过 Core drain 取消并结算，UNKNOWN 或未确认清理仍会阻止成功。受理停止后禁止新工作；清理失败应查日志/权威状态，不能推断任务未发生。状态检查和 drain 之间新受理的工作遵循 drain 的等待/暂停规则。

宿主控制 Core/Runtime 的启动和关闭；Core 生命周期管道在 launcher 死亡后收到 EOF，Runtime 沿私有管道执行清理。宿主死亡由 launcher 的父进程检查触发清理；launcher 继承并持有实例锁，即使宿主被强杀也会保持到 Core/Runtime 清理结束。旧 Core 锁未释放时不启动替代实例。`service.json` 是发现线索，客户端同时验证持锁状态、控制 socket 和经过认证的 Core 身份，不信任历史 PID 或端口。

TUI 断线会重新发现服务，故障清理完成后可启动新 generation；显式 stop 会留下停止标记，现有窗口不会自动撤销停止。新开窗口或手工 ensure 可重新启动。恢复使用 `thread/resume` 获取快照，不重放请求；Goal 重启后暂停，工具 UNKNOWN 保持原有检查要求。

## Web 与 Desktop 接入

- Web 通过 `areal web` 打开已有 `/ui`，沿用 token 登录换 HttpOnly cookie；浏览器不启动进程、不读 authFile，也不访问控制 socket。端口变化后重新运行 `areal web`。
- Desktop Main 用参数数组执行 `areal service ensure --json`，校验 `protocolVersion`，在 Main 读取 authFile 建立认证连接；只向 Renderer 暴露经过筛选的应用操作和状态。不要把完整服务描述或 token 交给 Renderer。
- 重连重新发现并比较 generation，然后 initialize/initialized 和 thread/resume。先查 request/read 或权威状态再决定重试，不自动重放已提交操作。
- 需要跨窗口的动态 ToolHost 应放在稳定 Main/独立宿主连接中。窗口上的动态工具不会自动转移；连接丢失仍按现有 Host generation 与 UNKNOWN 语义处理。

内部控制使用 home/services/INSTANCE_ID/control.sock 上的单行 JSON，目录 0700、登记与凭据 0600；请求 `{method:"status",version:1}` 或 `{method:"stop",version:1,generation,cancel}`，响应 `{result:"ok",service}` 或 `{result:"error",message}`。建议非 Rust 客户端使用 CLI，避免复制锁和恢复逻辑。Unix socket 路径过长时需缩短 AREAL_HARNESS_HOME。

认证 GET `/areal/service` 返回描述中的六个身份字段（protocolVersion/serviceId/generation/workspace/dataDir/configFingerprint），需要 observe 权限，拒绝不匹配的 Origin；无托管身份的已认证 Core 返回 404。业务协议仍见 [Core](core.md) 与[桌面 API](desktop.md)，无需另建 Agent loop。

LocalArgs 新增 permissions（YOLO/ASK_PERMISSIONS）与 scratch。生效权限策略和 scratch 参与部署兼容性摘要。本地 launcher 默认改为 full-access；旧共享服务需显式重启应用此默认变更，客户端连接不会静默扩权。见[权限配置](../guides/configuration.md#permissions)。
