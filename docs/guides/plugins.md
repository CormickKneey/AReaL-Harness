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

用户选择作为默认值，项目的明确选择覆盖用户默认；它们不代表更高权限的强制要求。显式 Profile 不会自动获得全部插件。MCP 必须明确核对已安装摘要后连接；Connector 必须映射原始 ID 并配置账户。未支持的 hooks、认证机制、旧命令或依赖显示诊断。“已安装”不代表服务器已经连接。

## Skills 与设置流程

普通聊天可在 Skills 目录选择已启用插件的技能。禁止隐式调用的 Skill 仍可以显式选择。资源按需分页读取；同包共享资源可以通过相对路径读取，最终路径必须留在固定安装包内。独立 Skill 保留原有实时文件与路径限制。

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

OAuth 使用独立的私有存储和 loopback PKCE callback。显式重试会重新认证已被拒绝的凭据；刷新和并发登录按凭据键协调。认证失败不会自动重发 MCP 操作。便携认证中尚不能执行的声明会明确报告，见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。

## 桌面 Apps 与 GitHub

“应用”标签页、全局/会话入口及匹配文件入口使用官方 MCP Apps AppBridge。插件页面运行在独立 origin 的沙箱框架内，不提供 Node、产品 bridge 或凭据。调用绑定项目、Thread、包摘要和连接版本；同服务器工具经普通 Core 执行、审批和日志路径调用。旧 App 在 Core 重启后失效，需要重新打开。

`ui/message` 可以将文本和资源添加到草稿，保留未发送的人类内容；只有 `send:true` 发起明确的新提交。标题和 `_meta` 留在历史/UI，递归剔除 `_meta` 后才进入模型。App 上下文按实例分组，可更新或移除。设置、mentions 和表单预览通过服务器声明的工具/资源处理；不猜测方法或地址。

GitHub Connector 保留 `.app.json` 的原始 ID。在详情中填写这个 ID 和 GitHub token，通过系统安全存储保存，再明确连接。Core 将这个显式映射接到 `https://api.githubcopilot.com/mcp/`；不会根据不透明 ID 猜测供应商。账户凭据不足、未映射和不支持分别显示。只读 `get_me` 的实际服务验收独立于本地模型与桌面夹具。

文件入口只给 App 不透明资源 URI。Core 校验保存的文件授权，并复用 Runtime 的目录描述符文件助手读写；Main 只管理窗口与文件监听。读取最多2 MiB，当前原子写入最多64 KiB；超限返回 `too-large`。写入支持 ETag/CAS 和持久请求回执；重试同键返回原结果，不覆盖后续编辑。

## 当前边界

P2 hooks 未实现。本批次不宣称全部 Codex 协议已经兼容：原生表单用户上传、现代2026 MRTR、部分便携认证机制、私有 OpenAI catalog/sharing、跨平台和安装包验收仍有缺项。受支持的 legacy 表单按完整 schema 验证；不支持的上传表单整表拒绝。固定 Codex 管理 RPC 使用独立 adapter，共享安装所有者；未配置的托管服务返回明确 capability error。完整清单与可重复证据见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。
