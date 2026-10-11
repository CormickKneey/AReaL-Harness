**中文** | [English](README.en.md)

# AReaL Harness GUI

完整桌面客户端：React renderer、Electron 原生适配器与公开依赖。与 CLI/TUI/Web 同属 Clients 层；Core 持有会话、历史、模型循环和定时任务，Runtime 执行工具。移动端源码后续迁移，桌面侧配对入口保留。

## 开发

从仓库根执行，需 Node.js 22.19+、pnpm 11.7.0 及仓库 Rust 工具链：

```sh
make build
make gui-install
make gui
```

`make gui-build` 只构建 renderer。`pnpm --dir clients/gui typecheck` 检查界面类型，`pnpm --dir clients/gui run verify` 检查公开文件边界。此模块单独锁定 pnpm 依赖，不改变仓库 SDK 的 npm 工具链。依赖来自公开 npm registry；Electron 和 Core 工具首次安装需网络。

`AREAL_CORE_BIN` 可指定可信 Core 的绝对路径；开发默认使用仓库 `target/debug/areal`。默认使用独立的 `AReaL Harness GUI Dev/<工作树摘要>` 数据目录；安装版使用 `AReaL Harness GUI`。不导入或替换旧桌面安装与数据。`AREAL_GUI_USER_DATA`、`AREAL_CORE_HOME`、`AREAL_HARNESS_HOME`、`AREAL_CORE_CONFIG` 可显式设置隔离目录/配置。

macOS 开发和安装版均需要可执行的 `/usr/bin/python3`，供 Runtime 及可信工具助手启动中转；可通过 `xcode-select --install` 安装 Xcode Command Line Tools。该解释器不随应用打包；共享服务在启动前检查可用性并返回明确错误。

## Composer

新草稿和已有聊天的 `+` 与 `/` 共用功能/Skills 分组目录和搜索；方向键选择，Enter 确认，Esc 关闭。Skill 附加到当前消息，发送前由 Core 读取正文；失败保留草稿和标签。模型入口先显示强度，再进入真实模型目录；强度值取自 Core 适配器能力，远端供应商支持须单独验证。

图片显示缩略图，UTF-8 文本附件可通过“在文本框中显示”追加到正文。超过 200 字符或至少 5 行的粘贴折叠为文本卡片，展开上限为 1 MiB；文件与技能删除不影响正文。目标模式在原输入区编写，创建目标只消费正文，其余附件继续保留。`pnpm --dir clients/gui run test:composer` 使用隔离 Electron/Core/Runtime 验证这些路径。

## 子任务与交付

普通输入区直接描述目标，Core 自动安排子任务。侧面板的“子任务”统一显示执行进度、检查证据与交付状态；点击“查看过程”读取子任务历史，等待或停止操作继续由 Core 管理。检查通过但尚未应用、应用冲突、部分应用和结果未知会分别显示。 候选交付可分页预览文件并一次性应用全部改动；应用由 Core 统一管理。若原任务已不活跃，继续原任务后承接交付，界面不会把尚未应用的候选显示为成功。

“高级：兼容委派与工作组历史”保留旧手工只读委派、显式计划和历史检查入口，不是普通任务的前置配置。旧 Core 未提供统一执行接口时，界面明确提示并保留兼容历史访问。

## 生命周期

Renderer 仅通过窄 preload IPC 访问桌面适配器。独立适配器使用 `areal service ensure/restart/stop --json` 连接 Core，不直接管理 Core PID。退出 GUI 断开界面并结算 GUI 拥有的终端，Core Turn/Goal 和已配置的定时任务继续执行；重新打开按权威快照恢复，不自动重放提交。停止后台服务是显式操作，忙碌时拒绝安全停止。

适配器保留已有凭据加密、订阅转发和手机配对职责，不运行另一套 Agent 循环。订阅转发的本地能力令牌和固定 loopback 端口在私有目录的 0600 文件中持久化；上游账号/API 凭据继续使用系统安全存储。适配器退出会中断当时的转发 HTTP 响应；稳定地址允许后续请求恢复，不保证崩溃中的流继续。GUI 正常退出保留适配器。

服务注册默认位于 `~/.areal/gui/<GUI 数据目录摘要>`，避免 macOS Unix socket 路径过长。CLI 如需连接相同实例，应显式使用 GUI 的 `AREAL_HARNESS_HOME` 与实例描述，不能假定默认 CLI 配置与 GUI 独立数据目录相同。认证描述不交给 Renderer。契约见[共享本地服务](../../docs/api/local-service.md)。

## 本地安装与验收

```sh
make gui-package
make gui-smoke
```

打包默认使用已构建的 debug Core。先 `make release` 并设置 `AREAL_CORE_PROFILE=release` 可使用 release Core。输出位于 `clients/gui/dist/local-*/`，包含可复制安装的 `.app`、ZIP、依赖清单与 Core 完整性清单；设置 `AREAL_GUI_PACKAGE_DIR` 可选择新输出目录。只面向本次 macOS arm64 本地验收，不执行 Developer ID 签名、公证或发布。应用与 Core 可执行文件使用本地 ad-hoc 签名；没有私有签名材料。旧安装升级与自动更新衔接不在本次范围内。

`make gui-smoke` 使用真实 Electron/Core/Runtime 和确定性本地 HTTP 模型，原生沙箱保持启用；项目选择对话框注入临时工作区，测试目录隔离。本地模型请求直连 loopback，测试保留并合并已有 `NO_PROXY` / `no_proxy` 条目。截图及 `manifest.json` 留在命令打印的临时目录，清单记录运行前后的 Core 二进制校验和及失败原因。安装包测试可设置 `AREAL_GUI_EXECUTABLE=/absolute/App.app/Contents/MacOS/AReaL\ Harness\ GUI`，此时不使用外部 Core 路径。实际账号登录、付费模型、其他操作系统和签名安装分发须单独验收。

第三方归属见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。运行时图标沿用源仓库版本；不迁入采集档案、开发 Skills/AGENTS 或来源 Git 历史。
