**中文** | [English](plugins.en.md)

# Codex 插件包（P0）

AReaL 的插件包由共享 Core 管理；GUI 与 CLI 读取同一安装与启用状态。当前支持本地 marketplace、根目录 Agent Plugins `plugin.json` 和 `.codex-plugin/plugin.json` 兼容格式中的 Skills，以及显式 onboarding。固定格式基线见 [upstream/pins.json](../../upstream/pins.json)，完整实施与验收见[任务计划](../development/codex-plugins-plan.md)。

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
areal plugin --workspace /absolute/workspace install review-helper@team-tools --scope project
areal plugin --workspace /absolute/workspace setup review-helper@team-tools
areal plugin --workspace /absolute/workspace disable review-helper@team-tools --scope project
```

用户选择作为默认值，项目的明确选择覆盖用户默认；它们不代表更高权限的强制要求。显式 Profile 不会自动获得全部插件。插件声明的未支持 MCP、hooks、Apps、旧命令迁移或依赖会显示诊断，不能将插件“已安装”理解为所有组件可运行。

## Skills 与设置流程

普通聊天可在 Skills 目录选择已启用插件的技能。禁止隐式调用的 Skill 仍可以显式选择。资源按需分页读取；同包共享资源可以通过相对路径读取，最终路径必须留在固定安装包内。独立 Skill 保留原有实时文件与路径限制。

“运行设置”在普通聊天中选择包内 onboarding Skill；用户可以打开该对话查看结果与审批。它使用普通 Core 模型执行和受理回执，不是具有额外权限的安装脚本。Side 和受限 Profile 不能借 setup 扩大范围。没有可用模型时配置模型后再运行。

## 版本、停用与恢复

安装副本按内容摘要保留，源目录编辑不改变已经安装的资源。活动 Turn 固定插件技能引用；后续 Turn 使用当前可用版本。停用和卸载立即阻止后续资源读取，保留旧包用于历史，不默认删除可写数据。当前尚未运行插件 MCP/hooks，因此不声称完成这些进程的排空验收。

Core 管理写入要求 `requestId` 与必要的 `expectedRevision`；RPC 安装还要求选中 `source` 和 `expectedDigest`。重复同键同参数查询原结果，异参数拒绝。界面遇到结果未知可“核对插件提交”，只读查询受理回执，不重新执行：

```sh
areal plugin --workspace /absolute/workspace submission REQUEST_ID
```

权限归 Core；观察者和限制到特定 Thread 的身份不能进行全局插件管理。安装状态存在 Core 配置 home 的 `plugins/`，不修改 Codex 的缓存或配置。

## 当前边界

Git/npm 下载、完整 MCP 配置/认证、公开 hooks 运行、MCP Apps/OpenAI 桌面扩展与 Connector 托管服务接入分别属于后续阶段。格式接受不赋予 Connector 账户访问权。P0 的源码、文件系统集成、Core/CLI、确定性模型、原生桌面与安装包验证必须分别报告；最终“完整兼容”以任务计划的全部必需验收为准。
