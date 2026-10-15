**中文** | [English](plugins.en.md)

# Codex 插件包

AReaL 的插件包由共享 Core 管理；GUI 与 CLI 读取同一安装与启用状态。支持本地/Git marketplace、Git 与 npm 来源、两种 manifest 中的 Skills，以及显式 onboarding；插件 MCP、Apps 和 GitHub Connector 通过现有 Core 执行边界接入。固定格式基线见 [upstream/pins.json](../../upstream/pins.json)，完整实施与验收见[任务计划](../development/codex-plugins-plan.md)。

## 发现与安装

在工作区或个人目录的 `.agents/plugins/marketplace.json` 声明本地插件：

```json
{
  "name": "team-tools",
  "plugins": [{
    "name": "review-helper",
    "source": {"source": "local", "path": "./plugins/review-helper"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
    "category": "Productivity"
  }]
}
```

路径相对 marketplace 根，不相对 `.agents/plugins` 文件所在目录。可在 GUI 的“设置 → 插件 → 插件包”添加其他本地 marketplace 根目录，查看组件并安装。安装固定已选来源和内容摘要；预览后源文件变化会拒绝安装，需要刷新后重新选择。安装不执行包中的脚本、MCP 或 hooks，也不自动运行 setup。

CLI 连接到已经运行的 Core，保持运行服务的配置：

```sh
areal service ensure --workspace /absolute/workspace --json
areal plugin --workspace /absolute/workspace list --json
areal plugin --workspace /absolute/workspace marketplace-add /absolute/marketplace
areal plugin --workspace /absolute/workspace marketplace-add-git https://github.com/TEAM/catalog.git --ref-name main
areal plugin --workspace /absolute/workspace resolve review-helper@team-tools
areal plugin --workspace /absolute/workspace read review-helper@team-tools
areal plugin --workspace /absolute/workspace install review-helper@team-tools --scope project
areal plugin --workspace /absolute/workspace setup review-helper@team-tools
areal plugin --workspace /absolute/workspace connect review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST
areal plugin --workspace /absolute/workspace mcp-list
areal plugin --workspace /absolute/workspace disconnect review-helper@team-tools
areal plugin --workspace /absolute/workspace disable review-helper@team-tools --scope project
```

用户选择作为默认值，项目的明确选择覆盖用户默认；它们不代表更高权限的强制要求。显式 Profile 不会自动获得全部插件。MCP 必须明确核对已安装摘要后连接；Connector 必须映射原始 ID 并配置账户。未支持的 hook handler、认证机制、旧命令或依赖显示诊断。“已安装”不代表服务器已经连接。

## Skills 与设置流程

普通聊天可在 Skills 目录选择已启用插件的技能。禁止隐式调用的 Skill 仍可以显式选择。资源按需分页读取；同包共享资源可以通过相对路径读取，最终路径必须留在固定安装包内。独立 Skill 保留原有实时文件与路径限制。

Rust 嵌入式调用通过 `Engine::install_plugin_store` 接入插件。未配置默认 Profile 或插件 Store 的纯 Engine 会话保留原有轻量状态，不因插件代码可用而注入桌面指令或改变上下文预算。

“运行设置”在普通聊天中选择包内 onboarding Skill；用户可以打开该对话查看结果与审批。它使用普通 Core 模型执行和受理回执，不是具有额外权限的安装脚本。Side 和受限 Profile 不能借 setup 扩大范围。没有可用模型时配置模型后再运行。

## 版本、停用与恢复

安装副本按内容摘要保留，源目录编辑不改变已经安装的资源。活动 Turn 固定插件技能引用；后续 Turn 使用当前可用版本。停用和卸载立即阻止后续资源读取，保留旧包用于历史，不默认删除可写数据。活动 Turn 的工具 schema 和调用对象一起固定；升级为后续 Turn 建立新连接，旧连接等待已有调用和 App 排空。停用、卸载和显式断开撤销调用。清理未确认显示 UNKNOWN 并阻止重连；显式断开也清除自动重连信任。

Core 管理写入要求 `requestId` 与必要的 `expectedRevision`；RPC 安装还要求选中 `source` 和 `expectedDigest`。重复同键同参数查询原结果，异参数拒绝。界面遇到结果未知可“核对插件提交”，只读查询受理回执，不重新执行：

```sh
areal plugin --workspace /absolute/workspace submission REQUEST_ID
```

权限归 Core；观察者和限制到特定 Thread 的身份不能进行全局插件管理。安装状态存在 Core 配置 home 的 `plugins/`，不修改 Codex 的缓存或配置。

## Git/npm 与 MCP

在“添加来源”选择 Git marketplace；包条目可以使用以下来源。Git ref 固定到 commit，npm 版本范围解析到具体版本与 integrity；下载和安装不运行 npm lifecycle scripts。

```json
{"name":"example","source":{"source":"git-subdir","url":"https://github.com/example/plugins.git","ref":"main","path":"plugins/example"}}
{"name":"example","source":{"source":"npm","package":"@example/plugin","version":"^1.0.0"}}
```

详情中先“解析并预览来源”，核对提交、版本和摘要，再勾选确认并安装。候选摘要与已安装摘要分开显示。连接必须确认已安装摘要；新版本安装后需要再次核对。MCP 配置按便携/legacy 格式归一化；命令、环境和认证字段不作为管理结果返回。服务器策略控制工具启用、必需性、审批和模型可见输出预算；失败不等于包已卸载。

认证配置支持 provided、DCR、CIMD preference、声明的 endpoint/resource/OIDC/scopes，以及 API-key bearer/basic/custom header。没有宿主可信 metadata URL 的 CIMD preference 回退 DCR；不会借用 OpenAI 客户端身份。OAuth client secret 和签名私钥在详情中配置并由 Main 安全存储，Core 只持引用。`ON_INSTALL` 安装后显示待认证并门控声明认证的服务；`ON_USE` 在需要时提出需求，mixed 可先匿名使用公开能力。

OAuth 使用私有存储和 loopback PKCE callback。scope override（包括空列表）在授权与刷新时保留；认证挑战只交给认证所有者。服务要求增加权限时，同一绑定的授权请求保留已授予权限；取消后重试也保留，待授权权限不会被当成已授予权限，新配置或账号不继承旧授权。工具级拒绝绑定实际发送的 token，不误删并发刷新得到的新 token，也不自动重发 MCP 操作。实现与真实服务证据分开记录，见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。

Codex `marketplace/add` 接受顶层 `sparsePaths`：非空列表使用 Git cone 目录选择并在更新时保留；调用方须包含目录文件与所需插件路径，不自动扩大选择。省略或空列表保留完整 checkout；本地目录来源不接受非空 sparse 选择。

## 桌面 Apps 与 GitHub

“应用”标签页、全局/会话入口及匹配文件入口使用官方 MCP Apps AppBridge。插件页面运行在独立 origin 的沙箱框架内，不提供 Node、产品 bridge 或凭据。调用绑定项目、Thread、包摘要和连接版本；同服务器工具经普通 Core 执行、审批和日志路径调用。旧 App 在 Core 重启后失效，需要重新打开。

`ui/message` 可以将文本和资源添加到草稿，保留未发送的人类内容；只有 `send:true` 发起明确的新提交。标题和 `_meta` 留在历史/UI，递归剔除 `_meta` 后才进入模型。App 上下文按实例分组，可更新或移除。设置、mentions 和表单预览通过服务器声明的工具/资源处理；不猜测方法或地址。

GitHub Connector 保留 `.app.json` 的原始 ID。在详情中填写这个 ID 和 GitHub token，通过系统安全存储保存，再明确连接。Core 将这个显式映射接到 `https://api.githubcopilot.com/mcp/`；不会根据不透明 ID 猜测供应商。账户凭据不足、未映射和不支持分别显示。只读 `get_me` 的实际服务验收独立于本地模型与桌面夹具。

文件入口只给 App 不透明资源 URI。Core 校验保存的文件授权，并复用 Runtime 的目录描述符文件助手读写；Main 只管理窗口与文件监听。读取最多2 MiB，当前原子写入最多64 KiB；超限返回 `too-large`。写入支持 ETag/CAS 和持久请求回执；重试同键返回原结果，不覆盖后续编辑。

现代 MCP `2026-07-28` 支持多轮 MRTR 表单；直接旧连接仍支持 legacy elicitation。每轮保留原工具参数和 Core 调用归属，重新检查权限，不重放 UNKNOWN。资源更新只投递给订阅该 URI 的 App；多个 App 共享 wire 订阅，关闭最后一个才退订。

表单可通过原生选择器添加本机文件/目录。Core 导入只读副本，原文件后续编辑不影响副本；每文件16 MiB、每逻辑调用256文件/64 MiB、目录深度16。URI 绑定表单字段和服务世代，取消/关闭/撤权/调用结束会清理。当前文件副本仅交给同机 stdio 服务；HTTP 服务没有公开约定的上传通道时明确报告不支持，仍可选择服务器提供的资源。

## 当前边界

P2 完整 hooks 验收、OpenAI 私有 catalog/sharing、跨平台、真实供应商 OAuth 和签名/公证安装包仍未接受。部分子进程验收在本机收到原因未确认的 SIGKILL；不能把源码完成或局部通过当作完整兼容验收。未配置的托管服务返回明确 capability error。完整清单与可重复证据见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。

## Hooks（P2 候选实现）

包内 hooks 与用户、项目配置使用同一个 Core 执行所有者。用户来源是选定 home 的 `hooks.json` 与选定 TOML 的 `[hooks]`；项目来源是工作区 `.codex/hooks.json` 与 `.codex/config.toml` 的 `[hooks]`。每层先 JSON 后 TOML 累加，包定义沿用原格式及覆盖规则。项目文件只提供 hooks，不覆盖模型、凭据或用户全局功能开关；不导入 Codex `hooks.state` 的信任声明。

在“设置 → 插件”审阅当前包摘要、定义摘要、事件、matcher、命令/MCP 输入与完整定义，勾选确认后才允许执行。用户/项目配置来源也须分别审阅。安装、启用包或连接 MCP 都不授予 hook 信任；更新定义须重新核对。CLI 使用同一 Core 状态：

```sh
areal plugin --workspace /absolute/workspace hooks-list
areal plugin --workspace /absolute/workspace hooks-trust review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST --definition-digest REVIEWED_DEFINITION_DIGEST
areal plugin --workspace /absolute/workspace hooks-revoke review-helper@team-tools
```

已布点的事件是 SessionStart/SessionEnd、UserPromptSubmit、PreToolUse/PermissionRequest/PostToolUse、PreCompact/PostCompact、SubagentStart/SubagentStop、Stop/Interrupt。command 使用 Runtime 的现有 Scope；MCP handler 只调用已经连接且仍获授权的包内工具，不递归进入模型工具审批。MCP 的活跃时间预算在真实人工表单等待期间暂停，取消和撤权继续生效。`deny`、输入改写和已完成工具的 Post 反馈独立处理；Stop 可在同一 Turn 内继续，自动续轮不制造用户提交事件。包命令获得包根/数据环境；配置命令不获得包环境或额外路径授权，provider 秘密不继承给 hook 后代。

Core 保存每次受理的 `desktop.hookRuns`。UNKNOWN 保留并阻止继续执行；检查实际副作用和资源后，可通过 `areal/hook/acknowledge` 保存有界说明，结果仍为 UNKNOWN且不重放。归档和关闭先取消、等待已受理任务，再结算 SessionEnd；正在关闭的 Session 不接受新轮次。后台结果只在安全点或下一次用户 Turn 投影，不自行启动空闲 Turn。

已信任的 command hook 使用有界 Runtime 任务写入组：固定窗口内同任务 hook/工具允许重叠，ordinary/ordinary 与跨任务冲突仍独占。窗口不能延长，封口后的操作可能排在外组任务之后。P2 尚未完整验收：Side/研究及限制 Profile 继续排除；普通只读子任务采用独立 command 许可。Windows shell、完整配置栈与固定 Codex 二进制对照仍开放。详见 [P2 验收矩阵](../development/codex-plugins-p2-acceptance.md)。

普通只读子任务的 command hooks 需要审阅当前定义后另行勾选同意；CLI 在 `hooks-trust` 添加 `--allow-read-only-commands`，省略该选项会移除此项同意。工作区/安装包只读，仅私有子任务 scratch 和本插件 data 可写，禁止网络和 provider 秘密继承，data 目录被重定向时拒绝执行。Side、研究任务、nativeTaskAgent、受限 Profile 和只读根会话继续排除，此项同意不包含 MCP handler。
