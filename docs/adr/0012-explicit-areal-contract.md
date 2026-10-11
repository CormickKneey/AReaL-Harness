**中文** | [English](0012-explicit-areal-contract.en.md)

# 使用显式 AReaL 派生协议而非声称上游兼容

决策标识：SCF-ADR05 · 状态：proposed

仓库公开协议只是固定 Codex 版本的子集；本方案还需要 before 边界、持久业务键和独立来源关系。决定在 areal 扩展方法中定义完整契约并通过 capabilities 声明，不修改上游固定 schema 来冒充 thread/fork 全兼容。代价是客户端需要适配新的方法，但语义和权限可以被准确验证。

源码已在开发开关下实现，契约见[桌面 API](../api/desktop.md#turn-fork-开发预览)。原生桌面与完整 P0 验收仍待完成，因此决策保持 proposed；局部源码验证不能替代这些验收结果。

## 权衡与后果

数据格式版本保护持久权限语义，API 能力版本表达功能支持，两者分别维护。P0 拒绝 threadIds 限定身份的创建，不以来源关系自动派生 ACL；未来扩展 scoped creation 时须独立评审。
