**中文** | [English](0008-conversation-origin.en.md)

# 来源关系与 Agent 委派关系分离

决策标识：SCF-ADR01 · 状态：proposed

现有父子 Thread 路径承载 Session、Goal 和父 Turn 取消语义，而用户发起的 Side/Fork 需要独立生命周期。决定使用独立会话来源元数据，创建新的根 Thread 和 Session，保持原委派字段含义不变。代价是相关讨论列表需要理解一种新的关系；收益是不会因 UI 上的“子窗口”误继承执行控制。

源码已在开发开关下实现，契约见[桌面 API](../api/desktop.md#turn-fork-开发预览)。原生桌面与完整 P0 验收仍待完成，因此决策保持 proposed；局部源码验证不能替代这些验收结果。

## 权衡与后果

考虑过直接复用 parentThreadId：字段少，但会把来源关系变成取消、预算和权限关系；拒绝。后续统计与评测必须按 conversation kind / 显式入口区分 Side 与真正主任务，不能只看“是不是根 Thread”。
