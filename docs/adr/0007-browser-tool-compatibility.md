**中文** | [English](0007-browser-tool-compatibility.en.md)

# 以显式追加工具包与只读订阅保持既有 Thread

**状态：proposed（设计提案，尚未实施）**

当前 Thread 的动态工具定义不可变，thread/resume 同时涉及宿主绑定。为避免复制旧聊天或让 CLI 抢走 GUI 宿主，新增限定 Browser v1 工具包的空闲时追加操作，以及不重绑 ToolHost 的原子观察订阅。已有工具定义绝不替换；新的 Browser Dispatcher 外形固定，实际操作受 capability 与严格二级 schema 约束。

## 考虑的方案

只支持新 Thread 成本最低但牺牲用户现有上下文；全局内置浏览器 registry 扩大 Core 职责；强制替换旧工具表破坏已记录执行。选择有界追加而非通用运行时工具编辑器。

## 后果

这是明确的 Core 协议与持久化兼容性变更，需 capability、requestId 去重、Thread 空闲检查、冲突检查、恢复和旧客户端测试。只允许部署登记的工具包；模型无法自行追加。功能只增不减，旧工具身份与历史保留。新观察入口只取得投影，不授予执行宿主权限。

关联：[规格](../design/browser.md)、[契约](../api/browser.md)。
