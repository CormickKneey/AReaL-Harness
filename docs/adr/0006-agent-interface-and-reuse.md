**中文** | [English](0006-agent-interface-and-reuse.en.md)

# 使用受限浏览接口，不引入第二套可编程宿主

**状态：proposed（设计提案，尚未实施）**

现有 Harness 已有模型循环、工具执行和历史。Browser 采用版本化 Dispatcher、语义观察及有界动作序列，复用 Core 审批与证据；不整体引入 Ego SDK 的全局原生绑定、Page Ledger 或任意 Node.js 执行器。这样优先获得同页体验，代价是复杂程序化工作流暂不支持。

## 考虑的方案

直接外接 Ego 可快速实验但操作另一应用；模拟全部 ego 原生绑定需要重建其 snapshot 与任务空间；完整 Playwright/agent-browser 服务则增加浏览器所有权和连接协调。选择窄 Driver 与针对性参考，扩展 Provider 须有真实需求。

## 后果

Ref 的 Frame/Document/节点身份和错误停止规则可借鉴 Ego；Tab 认领、Host bridge 和状态隔离可借鉴 ZCode。任何代码提取先核对固定提交、依赖、许可证及行为测试。受限序列不是事务，不自动回滚；任意 page evaluate/raw CDP 不作为低权限逃生口。

关联：[规格](../design/browser.md)、[契约](../api/browser.md)。
