# 页面模式与有限选择

先按用户任务选模式，同一页面可组合内容模式，但沿用一个壳层和主滚动区。以下是 v1 默认；既有未迁移页面不构成新增自由变体的依据。

<!-- BEGIN GENERATED: patterns -->

| ID / 用户任务 | 最小组合 / 生产参考 | 允许变化 | 验收重点 |
| --- | --- | --- | --- |
| P-SETTINGS 修改偏好或配置 | SettingsPage + SettingsSection + SettingsGroupCard + SettingsRow；[参考](../renderer/src/settings/DisplaySettings.tsx) | 分组、字段、文案与现有控件类型 | 标签/控件对齐，窄窗换行，值和反馈真实 |
| P-RESOURCES 查找并管理资源 | SettingsSection + ActionButton + Feedback；[参考](../renderer/src/settings/PluginCenter.tsx) | 搜索、筛选、资源状态与详情 | 安装/连接状态分开；列表和详情职责清楚 |
| P-CONVERSATION 阅读并推进任务 | Messages + TurnProgress + TurnExecution + ToolEvent + ConversationComposer；[参考](../renderer/src/design-system/ConversationTimelinePreview.tsx) | 消息类型、工具结果、合法动作与上下文 | 权威状态、内容层级与阅读意图独立；按信息流合同验收完成收敛、人工展开和返回最新；未知提交不重放 |
| P-DECISION 回答或批准请求 | DecisionCard + ApprovalRequest + Feedback；[参考](../renderer/src/ApprovalRequest.tsx) | 请求正文及已有决策动作 | 关键参数可核对，动作和结果可达 |
| P-DETAIL 阅读或编辑详情 | SettingsDialog + SettingsDisclosure + Feedback；[参考](../renderer/src/settings/common.tsx) | 表单字段、正文及受控 footer | 返回/关闭路径和焦点恢复；不叠多层弹窗 |
| P-STATUS 了解状态并恢复 | Feedback + EmptySettings；[参考](../renderer/src/settings/ServiceStatusSettings.tsx) | 状态说明、必要详情及可行恢复入口 | 离线/失败/未知区分，静默刷新保留已确认内容 |

<!-- END GENERATED: patterns -->

P-RESOURCES 尚无统一公共列表封装；registry 中的组件列表是可复用的最小组合，不表示页面必须或只能导入这些组件。布局槽位、状态及允许变化由本文件继续约束。

## 控件选择

| 意图 | 默认组件 | 限制 |
| --- | --- | --- |
| 执行一次操作或打开管理入口 | `ActionButton` / `Button` | 文字为主；不伪装成开关 |
| 真正可双向开启/关闭 | `Switch` / `SettingsSwitch` | 读取真实状态；单向停止/清理使用操作按钮 |
| 两个互斥设置值 | `SettingsSegmentedTabs` 或 `SettingsSelect` | 两值同时可见；不用于先后步骤或导航 |
| 三个及以上候选单选 | `Select` / `SettingsSelect` | 收起显示当前值，展开显示选中项；不铺开一排按钮 |
| 多选 | 现有 Checkbox / 多选拥有者 | 保留复选语义；不套单选 API |
| 显示更多信息 | 详情面板；短内容用 `SettingsDisclosure` | 明确“展开 / 收起”，保留可访问语义；不用左侧三角 |

既有控件合同的详细规则归 [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md#设置与管理界面的交互规范)。

## 设置组合布局

`SET-LAYOUT-01`：复用 SettingsPage → SettingsSection → SettingsGroupCard → SettingsRow。宽组共享控件右边缘；窄组由 SettingsWorkspace.css 的容器规则切为上下排列，控件在完整标签/说明之后左对齐。页面不重新定义断点，不以缩字号、固定行高或偏移隐藏长文案。

`SET-CONTENT-01`：标签、说明、值和反馈沿用生产语义角色，行高随内容增长。控件尺寸的唯一规则见 [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md#按交互类型选择控件)，页面不自行选择紧凑档。选项过长时由共享 Select 的截断和完整菜单承担，不为页面另造控件。参考与本产品组合不同的布局需要有界内容验证后决定采纳或保留；单次参考截图不覆盖现有共享规则。

[设置迁移题](exercises/settings-reflow.md)固定内容和反证，用于探索这两条规则；题目不自行创建新设计值。

## 对话信息流

以下是 P-CONVERSATION 的目标合同。参考依据见[信息流观察](references.md#对话信息流的动态观察)，复验题见[动态信息流题](exercises/conversation-flow.md)。该完整模式尚未准入Base候选0.1.3；已准入的仅是下述动态题验证过的过程/阅读组合，资源宿主及真实执行等缺口保留。

`CONV-OWNER-01`：执行、内容展示和阅读意图分别拥有状态，不合成一个页面大枚举。

| 事实 | 所有者 | 决定什么 |
| --- | --- | --- |
| 等待、执行、需确认、完成、失败与未知 | 原 Core/Runtime 权威投影 | 状态反馈与合法动作；不由文字、动画或折叠推断成功 |
| 用户消息、过程、工具、最终回答与资源入口 | Messages / TurnExecution / ToolEvent | 保留身份、顺序与语义层级，组合展示而不改写原始历史 |
| 跟随最新、回看历史、手动展开与返回 | Messages 既有本地阅读所有者及所属详情组件 | 滚动与展开选择；不提交、恢复或重放执行 |

`CONV-INPUT-01`：若存在预测指令或建议，它属于未发送输入；出现建议不等于用户提交。采集回复增长时排除 Composer、用户提示和预测建议。业务页不得因建议自动提交或把建议插入已受理消息历史；不据本条规则新增预测功能。

`CONV-CONTENT-01`：按 Core 的消息身份、顺序及 commentary / final_answer 展示。当前正文增量完整可读；工具开始、运行、结束与结果分别表达，不能用模型正文中的“已执行”冒充工具回执，也不能用命令等待代替正文增长证据。

`CONV-GROUP-01`：本轮过程与最终回答是不同层级。正常完成且已有明确最终回答时，目标默认将过程文字和常规工具活动收入可展开的过程总组，最终回答独立可读；展开后保持原文与活动顺序。总组→活动摘要→具体命令输出各有明确身份与展开入口，不强制每条内容都套三层。需确认、失败、未知或尚在运行的资源应保持可发现的状态与合法动作，不能只因 final 出现就当作已结算内容隐藏。

`CONV-DISCLOSURE-01`：默认展开状态和用户选择分别记录。在同一组/详情身份存续期间，不用无关增量或刷新重置人工选择；父组收起与子项展开值分别处理，重新打开父组应恢复其仍存续的详情状态。跨轮次或新总组不得继承不属于它的展开状态。这是本产品验收约束，不能仅凭一次参考的完成总组截图声称已验证。

`CONV-READ-01`：跟随最新时，新内容可推进视口；用户主动向上阅读后，后续正文增长应保留其阅读锚点。展开、折叠及完成收敛改变内容高度时，区分布局引起的scrollTop调整与读者离开最新的动作，不因一次尺寸变化擅自恢复跟随。返回最新是显式阅读动作；等待可观察到的到达条件后才称跟随已恢复，点击返回成功不等于滚动动画已经结束。实现阈值与坐标留在原阅读所有者，不由页面按截图硬编码。

`CONV-RESOURCE-01`：图片、网页来源、子代理等保留对应内容的轻量入口与真实状态；打开和返回应保持父聊天身份与阅读上下文。活动列表随主对话滚动，具体命令输出可沿用既有有界阅读器。网页摘要或引用不能当作独立网页面板已打开，子代理完成也不替代父任务完成。

### 从证据回溯到规则和组件

这里拥有对话组合的设计决策；结构化引用在[信息流合同](surfaces/conversation-flow.json)，观察事实在[参考观察索引](references.md#对话信息流的动态观察)。正文规则不复制到JSON。调用方选择P-CONVERSATION后必须声明全部规则ID和必需检查点；目录检查只能阻断遗漏或虚构引用，不能证明实现遵守。

| 规则 | 依据与判断强度 | 修改所有者 | 合同检查点 |
| --- | --- | --- | --- |
| CONV-OWNER-01 | 本仓既有执行权威和[职责分层](architecture.md#分层与所有权)，不是从Codex外观推断其架构 | 原Core投影 / Messages / 所属详情组件 | ready、busy、failed、unknown |
| CONV-INPUT-01 | OBS-CONV-INPUT：可见建议及用户说明；不推断预测机制 | ConversationComposer输入边界 / Messages已受理内容 | ready |
| CONV-CONTENT-01 | OBS-CONV-TOOL：真实运行与成功输出；内容顺序仍服从本仓投影 | Messages / TurnExecution / ToolEvent | busy、failed、unknown |
| CONV-GROUP-01 | OBS-CONV-GROUP：参考终态层级；采纳为本产品正常完成的默认组合 | Messages既有过程总组 / TurnExecution | completed；同时保留failed、unknown反例 |
| CONV-DISCLOSURE-01 | OBS-CONV-OPEN-GAP：跨完成保留未实测；明确的产品选择，不是参考事实 | 同身份过程总组、活动组和ToolEvent | tool-details、completed |
| CONV-READ-01 | OBS-CONV-READ：生成中可见锚点和返回后的连续样本；目标规则不复制测量常量 | Messages既有阅读逻辑 | reading-history、following-latest |
| CONV-RESOURCE-01 | OBS-CONV-RESOURCE：图片/子对话入口直接观察；独立网页面板仍未知 | ToolEvent及既有父聊天/资源面板所有者 | busy、completed；资源返回按复验题追加 |

### 组合与变化边界

正常完成的阅读层级为：用户消息 → 可展开的过程总组（过程文字与常规活动，保留原顺序）→ 独立最终回答；资源沿所属内容提供入口。只有实际存在子活动时才展开下一层，不给每条纯文字强加工具外壳。执行异常与未结算资源沿权威投影保持可发现。

页面允许变化的是任务文案、消息内容、真实资源、业务上下文与合法动作绑定。分组条件、人工展开保留、跟随/回看规则、反馈语义和设计数值都回到公共所有者；新增任务不另写一套页面CSS或折叠/滚动策略。过程文字和命令使用现有正文/过程角色，动作使用现有控件，间距与颜色沿Foundations；本轮观察没有足够依据修改Token。

| 到达事件 | 执行事实 | 阅读/展开响应 | 不能据此声称 |
| --- | --- | --- | --- |
| 新消息被权威接受 | 增加本轮身份并进入执行 | 原阅读所有者处理新轮占位；冷历史与续接不冒充新提交 | Composer出现建议就是接受 |
| 正文追加，用户回看历史 | 本轮继续执行 | 保存同一可见内容锚点；不因高度变化自动跟随 | scrollTop数值不变就一定没有跳动 |
| 用户返回最新 | 执行状态不变 | 先观察滚动到达，再核验后续增量跟随 | 点击回执就是到达底部 |
| 用户打开详情 | 工具状态不变 | 按详情身份记录人工选择，与父组/default分离 | 展开动作完成了工具或重新执行了它 |
| 正常完成且final存在 | 以权威终态和资源结算判断 | 适用默认值的过程收敛；人工选择按原身份保留，final独立 | final出现就能隐藏失败/UNKNOWN/仍运行资源 |

这些行是不同状态轴的交互，不组成新的全局状态机。结构化合同的states是验收检查点，不能拿它替代Core状态、重连快照或真实用户操作。

### 当前实现差异

| 所有者 | 当前源码事实 | 迁移/验收缺口 |
| --- | --- | --- |
| Messages / TurnProgress | 带phase与legacy均复用从运行期挂载的过程总组；正常完成时默认收敛，final独立 | 动态renderer题验证；真实Core/桌面路径未复验 |
| TurnExecution / ToolEvent | 同一命令从单项变多项、结果增量及父组收敛后保留人工详情；失败/未知/未结算不默认收敛 | 已验证合成命令；图片/子对话/网页宿主返回未覆盖 |
| ConversationTimelinePreview | 切换整份live/completed fixture，并关闭回复占位 | 不证明接受消息→逐项追加→完成，也不证明真实聊天的阅读占位行为 |
| ConversationFlowExercise / Messages阅读逻辑 | 逐步接受合成输入，保留生产回复占位；正文增长时实际滚轮回看并显式返回 | 可见旧段落锚点及后续跟随在代表条件通过；不是Core或桌面验收 |

## 按钮与表面

普通行内操作采用 `ActionButton`；其现有默认是紧凑的次要操作。页面级主要提交才使用 `Button` 的主要变体，次要动作使用 outline / secondary / ghost 的已有用途。危险动作使用 destructive / destructive-subtle 并保留原确认合同。Composer 的发送/停止沿用 composer 变体，不推广到设置页。

一个外框对应一个功能关系；只读详情与工具过程优先轻量展示。不要把每一行、每段状态、每个按钮再装进独立大卡片。选中、hover、focus、disabled、busy 与 error 使用组件状态，业务页面不重新描边或覆盖控件圆角。

## 状态必须先于样式决定

| 状态 | 展示与动作 |
| --- | --- |
| 首次加载 | 所属区域 loading；无假数据，无可误触操作 |
| 刷新 | 保留已确认内容，局部标识刷新；请求失败时旧值不伪装为新结果 |
| 空 | 说明为何为空；只有存在可用下一步时提供动作 |
| 提交中 | 防重复提交，保留动作标签/草稿；只禁用受影响动作 |
| 成功 | 显示权威回执后的当前值；必要反馈就近出现 |
| 失败 | 明确原因及可行恢复，保留输入；无条件重试不作为默认 |
| 待确认 / UNKNOWN | 与失败、成功分开；核对原请求，不以新身份重放 |
| 不可用 / 无权限 | 显示真实原因与适用入口，不生成虚假开关或无效按钮 |

## 最小实现说明

新页面、公共模式或跨状态的实质修改先按[结构化流程](structured-flow.md)在 `surfaces/` 登记合同；纯文案或沿现有合同的小改动可引用已有合同。变更说明简短引用合同及差异即可：

```text
用户任务：
模式 ID / 生产参考：
复用组件 / Token 角色：
状态与宽窄条件：
例外（没有则写无）：
验证证据与未覆盖项：
```

例如新增配置导入入口：P-SETTINGS，沿用设置行和 ActionButton，调用方管理文件选择及提交；覆盖空、处理中、失败、成功与窄窗，只有诊断详情可展开。不能借此新建整套导入仪表盘或换主题。
