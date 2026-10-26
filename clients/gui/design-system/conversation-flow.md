# 对话流设计系统：活动与上下文

状态：2026-10-24 设计目录与生产对话共用组件，仍保留实验导出与有限Base边界。生产接线见文末，设计预览继续供状态评审；不把采用等同于完整模式准入。适用桌面GUI的主聊天、活动详情与任务上下文；Side等复用Messages的入口共享活动呈现，Remote及各入口宿主仍分别验收。

`R-CONVERSATION-002` 用户目标是把两张 Codex 截图中反复出现的结构变成可复用的设计语言：正文负责沟通，活动行负责说明做了什么，展开区负责核对细节，右侧负责整理当前工作的对象与输入。视觉沿用现有 AReaL Token、图标和控件，不从截图另建主题。

## 可操作预览

从仓库根运行 `pnpm --dir clients/gui design:dev`，打开 [对话流设计预览](../renderer/design-system.html?conversation-system)。建设看板和组件目录也提供“对话流设计”入口。

预览提供运行中、已完成、需要关注三种状态，来源数量可选零、三、五项，图片可切换可用/引用不可用。活动与图片默认收起；三十项列表、追加命令输出、文件/变更入口、子任务、来源折叠/查看全部、添加示例网页到草稿和窄窗上下文返回均可操作。切换状态保留同一组的人工展开和未发送草稿，刷新则回到初始样例。

`R-CONVERSATION-004` 任务上下文卡片默认关闭，从对话顶部“任务上下文”按钮打开，不是永久的右侧面板。过程摘要可切换模型文字、长摘要与无摘要回退，通过“推进摘要样例”验证变化；这些是显式固定样例，不模拟真实模型流或按时间编造进度。

## 研究后的优化选择

见[冻结原文](../../../design/archive/gui/conversation-design-research.md#研究后的优化选择)。

## 依据与规则强度

见[冻结原文](../../../design/archive/gui/conversation-design-research.md#依据与规则强度)。

## 设计系统如何组织

`R-CONVERSATION-021` 沿 [AReaL 架构](../../../design/architecture.md)和 [D-004 私有 UI 包](../../../design/decisions/004-local-ui-package.md)组织，复用已有包、Token/主题和目录构建链，不新增平行组件库或页面 DSL。

| 层 | 本题维护什么 | 唯一来源与后续落点 |
| --- | --- | --- |
| Foundations | 内容/控件文字、次级信息、表面、间距、图标、焦点和动效角色 | [GUI 基础规则](foundations.md)、[Token 来源与使用](../../../design/foundations/tokens.md)及生产 CSS/偏好链；本稿不存数值副本 |
| 通用控件 | 按钮、折叠、列表语义、反馈和详情容器 | 包内基础 Button/Disclosure 及原控件；不认识 Thread、processId 或权限结果 |
| 对话领域组合 | 活动组、图片入口与任务上下文 | 首批 src/conversation 实现与就近合同；命令、子代理资源与权威状态沿原所有者，接口以真实类型为准 |
| 交互模式 | 活动何时分组、怎样展开、回看与返回 | [过程阅读](../../../design/patterns/task-progress.md)与原 CONV 合同；不接管 Core 状态机 |
| 产品布局 | 主阅读列、右侧上下文、查看资源及窄窗返回 | [桌面工作台](../../../design/products/workbench/README.md)与现有 App 宿主 |
| 目录与示例 | 找到合同、真实实现及已覆盖状态 | 原 registry、设计文档阅读器与生产组件预览；未实现概念不登记成可用组件 |

上表的实验导出有实际类型和合同；下文其他英文名称仍是设计词汇，不构成新增导出或 Props 承诺。若现有所有者能够承担，直接补齐它的合同与有限变体。

## 主阅读列与活动层级

组件专属合同由[R-ACTIVITYGROUP-011 等规则](../packages/ui/src/conversation/activity-group/activity-group.md#主阅读列与活动层级)维护。

### 活动行的有限变体

见[组件合同](../packages/ui/src/conversation/activity-group/activity-group.md#活动行的有限变体)。

活动行视觉节奏与图标约定见 `R-ACTIVITYGROUP-032`、`R-ACTIVITYGROUP-033` 及[组件组成合同](../packages/ui/src/conversation/activity-group/activity-group.md#组成)。

### 折叠与状态

见[组件合同](../packages/ui/src/conversation/activity-group/activity-group.md#折叠与状态)。

### 溢出与滚动

见[组件合同](../packages/ui/src/conversation/activity-group/activity-group.md#溢出与滚动)。

## 右侧任务上下文

组件专属合同由[R-TASKCONTEXT-009 等规则](../packages/ui/src/conversation/task-context/task-context.md#右侧任务上下文)维护。

### Sources 管理输入

见[组件合同](../packages/ui/src/conversation/task-context/task-context.md#sources-管理输入)。

## 组件合同与实现所有者

见[冻结原文](../../../design/archive/gui/conversation-design-research.md#组件合同与实现所有者)。

## 视觉与可访问性

`R-CONVERSATION-028` 活动采用轻量行式表达，右侧分区使用已有面板表面与分隔；命令正文只在展开后获得内容区域。最终回答保持最高阅读权重，正常结束的过程使用次级表达，但不能把运行/失败内容做成禁用态。

过程摘要消费 `--text-content-caption`，控件标签消费 `--text-ui-caption`，次级信息沿 `--color-foreground-subtle/subtlest`；代码沿 `--font-mono`，阅读列沿 `--reading-width`。间距、圆角、状态颜色和字号偏好只引用 [Token 来源与使用](../../../design/foundations/tokens.md)，不登记截图数值或 Raft 字体副本。

折叠触发器是具名按钮，Enter/Space 可切换并暴露 expanded/controls；文件打开、详情展开、复制与菜单分别是独立目标，不嵌套按钮。“查看全部”带来源区上下文与数量。被收起内容退出焦点序列；收起正在聚焦的内容时将焦点交回触发器。滚动区溢出时可键盘到达和纵向滚动，图片有可理解名称，纯图标动作有可访问名称。颜色与动画均不独自承担状态；沿已有 reduced motion 和可逆折叠机制。

## 后续样例与验收清单

见[冻结原文](../../../design/archive/gui/conversation-design-research.md#后续样例与验收清单)。

## 生产接线

`R-CONVERSATION-035` 生产主会话、子历史及复用Messages的入口消费同一实验包；不复制预览fixture或另建执行状态。TurnExecution负责原事件分组，单项以inline呈现，增加条目后同实例折叠；活动默认收起，人工选择跨增量和完成保留，失败/UNKNOWN在折叠外。

`R-CONVERSATION-036` ToolEvent通过ImageDisclosure按需阅读已确认的工具图片，原SentAttachment负责Core媒体读取和查看器，读取失败在折叠外反馈。用户输入附件与最终交付图片保持原呈现。TurnActivity以连接、审批、重试、工具和未确认状态为先，仅在实际模型生成期间使用ThinkingStatus；消费Core reasoning.summary公开摘要，无摘要回退，不从modelContext提取隐藏信息。

`R-CONVERSATION-037` App沿原顶部“任务资源”入口承载TaskContext。Sources来自已保存附件、已验证文件读取及用户明确网页引用；仅展示引用不宣称抓取，三项/全部/返回由原卡片维护。加号打开原Composer附件入口，只加入草稿。关联信息仅来自实际worktree.sourceRoot/directory，不把工作区内任意目录列为关联项目。Changes仍为工作区未暂存范围，定时任务与后台进程保留原动作。

`R-CONVERSATION-038` Subagents入口先打开分状态列表，再进入AgentConversationPane真实历史，时间线子任务仍可直达。AgentsPane继续拥有原agents/agentWait分页查询与状态，AgentHistoryPane仅拥有阅读选择；失败、中断、未知使用原状态文字，不由父任务结算推导。原子任务管理页不替换。阅读卡片暂收起，关闭阅读器恢复；卡片通过React Activity保留阅读状态，隐藏期间清理查询effect。SidePane继续负责资源标签与主对话草稿/焦点返回。

`R-CONVERSATION-039` 实验导出保留wip；生产采用不等于稳定API、完整Codex复刻或Base升级。真实桌面验收与安装包、供应商能力分别记录。
