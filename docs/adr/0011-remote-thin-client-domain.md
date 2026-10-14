**中文** | [English](0011-remote-thin-client-domain.en.md)

# 0011：薄客户端保持 Thread、Task 与 Review 的领域边界

移动信息架构以工作概览和人工介入为中心。Session 是既有 Thread 的用户界面称呼，Task/TaskRun 保持原调度语义，WorkItem 只是概览投影；不为手机另造一套任务模型。P0 选择 Web/PWA，并提供只读结果 Review，而非完整移动 ADE。

相比复刻桌面功能，该选择减少终端/文件/配置权限面与 UI 维护成本；代价是忙碌会话的排队/steer、任务调度编辑和 Git 管理继续留在桌面。普通停止作用于确切 Turn，Task 停止使用有明确后续调度影响的暂停操作，Review 不等于批准执行。

以后可添加原生客户端或更多只读展示能力，但不得通过 UI 扩展改变这些执行与授权含义。
