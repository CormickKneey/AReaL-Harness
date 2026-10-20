# 用户交互模式

从用户意图选择交互族，再组合页面。页面名称、对象类型和组件列表不是分类入口。同一页可以使用多个交互族，但不创建另一套字体、颜色、滚动、状态或保存机制。

## 使用方式与规则强度

1. 用一句话写用户要完成的事，从下表选一至三个主要交互族，补充必要的恢复路径。
2. 阅读对应模式卡；从 registry 的生产所有者和 patterns 的组合中选择实现。
3. 记录采用的默认规则及少量例外。必须规则不可由 agent 自行豁免；与当前用户决定冲突时，以用户决定为准并记录影响。
4. 固定状态、数据、主题、字号、窗口和可观察结果，沿用 [B 流程](structured-flow.md)验证。

| 强度 | Agent 的责任 |
| --- | --- |
| 必须 must | 保持状态可信、必要上下文和可达性；有冲突先定位原所有者，不临时绕过 |
| 默认 default | 直接采用已有结构与视觉角色；偏离时记录具体用户理由及验证 |
| 可探索 explore | 允许领域内容、信息组织和专属可视化变化；沿用基础语言 |

模式卡是设计建议与约束，不表示所有生产页面已迁移或所有状态已验证。目录检查只核验声明和引用；视觉质量、原生体验与业务正确性分别验证。Base 0.1.3 的准入边界不因新增分类扩大。

## 分类索引

<!-- BEGIN GENERATED: interaction-families -->

| ID / 用户意图 | 既有组合 | 生产所有者 | 规则 |
| --- | --- | --- | --- |
| I-NAV 定位与切换 | P-SETTINGS, P-RESOURCES | SettingsNavigation | NAV-CONTEXT-01, NAV-DEFAULT-01 |
| I-INPUT 输入与提交 | P-CONVERSATION, P-SETTINGS, P-DETAIL | ConversationComposer, SettingsRow | INPUT-TRUTH-01, INPUT-DEFAULT-01 |
| I-OBSERVE 等待与观察 | P-CONVERSATION, P-STATUS, P-SETTINGS | TurnExecution, TurnProgress, Feedback | OBSERVE-TRUTH-01, OBSERVE-DEFAULT-01 |
| I-READ 阅读与探索 | P-CONVERSATION, P-DETAIL, P-SETTINGS | CollapsibleText, SettingsDisclosure | READ-CONTINUITY-01, READ-DEFAULT-01 |
| I-RETURN 打开与返回 | P-CONVERSATION, P-DETAIL, P-SETTINGS | AgentConversationPane, SettingsDialog | RETURN-CONTEXT-01, RETURN-DEFAULT-01 |
| I-DECIDE 选择与确认 | P-DECISION, P-SETTINGS, P-DETAIL | SettingsSelect, Switch, DecisionCard | DECIDE-RESULT-01, DECIDE-DEFAULT-01 |
| I-MANAGE 调整与管理 | P-SETTINGS, P-RESOURCES | SettingsPage, SettingsSection, SettingsGroupCard, SettingsRow | MANAGE-OWNER-01, MANAGE-DEFAULT-01 |
| I-RECOVER 异常与恢复 | P-STATUS, P-CONVERSATION, P-SETTINGS, P-RESOURCES, P-DETAIL, P-DECISION | Feedback, EmptySettings | RECOVER-TRUTH-01, RECOVER-DEFAULT-01 |

<!-- END GENERATED: interaction-families -->

## I-NAV 定位与切换

- 意图：知道当前位置，切换工作上下文，返回原任务。
- 默认结构：现有工作台导航、SettingsNavigation；沿原 App 的导航与未保存更改守卫。
- 状态：当前、可前往、切换中、被未保存修改阻止、无匹配结果。
- `NAV-CONTEXT-01`：必须。选中状态反映当前内容；切换或返回不丢失尚未提交的内容。不得用焦点、悬停冒充选中或绕过原导航守卫。
- `NAV-DEFAULT-01`：默认。一个壳层；导航有稳定名称和显式返回入口；搜索无结果就近说明且可清除。键盘操作依现有控件语义。
- 连续性/视觉/动效：页面内容变化与所选入口同步；沿共享选中和焦点角色，不用入场动画代替当前位置。
- 可探索：按产品任务组织分组、名称和顺序。依据：既有设置导航；完整多窗口切换仍是覆盖缺口。

## I-INPUT 输入与提交

- 意图：表达需求、填写信息、确认系统已受理。
- 默认结构：ConversationComposer、现有 Input/表单与明确提交动作；继承业务提交所有者。
- 状态：空、编辑、组合输入、可提交、提交中、失败、结果未知。
- `INPUT-TRUTH-01`：必须。草稿与已受理结果分开；IME 组合输入不触发提交；失败保留可恢复输入；未知受理不自动重发。
- `INPUT-DEFAULT-01`：默认。标签说明预期输入；校验就近显示；明确采用即时生效或显式保存，不能同时暗示两种方式。
- 连续性/视觉/动效：保留草稿与操作位置；提交反馈沿现有 pending，不虚构成功动画。可探索：领域字段和辅助输入。
- 依据：Composer、颜色输入的局部草稿、原保存链路。原生候选浮窗未验证。

## I-OBSERVE 等待与观察

- 意图：判断系统正在做什么、是否需要介入。
- 默认结构：TurnExecution、TurnProgress、ToolEvent、Feedback；状态沿 Core 投影。
- 状态：排队、工作、等待用户、完成、失败、未知；并行子任务各自独立。
- `OBSERVE-TRUTH-01`：必须。状态有文字；请求已受理、实际执行、工具结算、最终完成分别表达；子任务状态不替代父任务状态。
- `OBSERVE-DEFAULT-01`：默认。当前进展轻量可见，过程细节逐步展开；正常结束可收敛，失败与未决事项仍可发现。
- 连续性/视觉/动效：运行反馈不抢读者位置；减少动态效果保留静态状态。可探索：有真实依据的领域进度。依据：对话规则与 E1/E2 选定旅程，非所有异步场景。

## I-READ 阅读与探索

- 意图：理解结果、长内容和必要细节。
- 默认结构：Messages、CollapsibleText、SettingsDisclosure；长输出沿既有有界阅读器。
- 状态：摘要、展开、折叠、阅读历史、跟随最新。
- `READ-CONTINUITY-01`：必须。隐藏内容不可继续获得焦点；读者主动回看时保持阅读意图；关键决策信息不得仅放在默认隐藏区域。
- `READ-DEFAULT-01`：默认。常用判断和操作直接可见；专业微调、长过程按主题渐进展开，入口名称说明其中内容，采用共享展开控件。不把所有内容装进无语义的“高级”。
- 连续性/视觉/动效：一个主滚动区；展开由内容决定高度，反向与 reduced motion 沿原组件。可探索：正文结构、领域图表。
- 依据：已有对话阅读与设置详情；具体哪些设置常用属于本产品选择；设置首阶段效果已获用户认可。

## I-RETURN 打开与返回

- 意图：检查资源或子任务后继续原工作。
- 默认结构：既有资源面板、AgentConversationPane、图片查看器、SettingsDialog；平台生命周期仍归 Electron。
- 状态：关闭、打开、加载、不可用、返回。
- `RETURN-CONTEXT-01`：必须。返回保留父任务、必要草稿和阅读上下文，并恢复合理焦点；关闭阅读不改变后台任务执行状态。
- `RETURN-DEFAULT-01`：默认。持续检查用现有面板，短编辑用既有对话框；不重复叠加弹窗；宽窄布局沿壳层所有者。
- 连续性/视觉/动效：展开解释空间关系，返回不重新播放整页；资源失败保留返回路径。可探索：资源特有的阅读器。
- 依据：子代理、图片和原生网页预览的已测切片；文件原生预览及跨应用返回不因此通过。

## I-DECIDE 选择与确认

- 意图：理解影响并作出选择。
- 默认结构：SettingsSelect、Switch、SettingsSegmentedTabs、DecisionCard、ApprovalRequest。
- 状态：可选、已选、禁用、处理中、失败、未知。
- `DECIDE-RESULT-01`：必须。真实当前值与即将执行的选择分开；处理中防止重复操作；未经确认不展示已完成。
- `DECIDE-DEFAULT-01`：默认。双向布尔用开关、两个互斥值用分段、多候选用菜单；一次操作用按钮。具体 API 和尺寸以原控件合同为准。
- 连续性/视觉/动效：选择可辨、禁用原因可读；菜单关闭恢复触发焦点；动效不承担唯一反馈。可探索：领域选项和影响说明。
- 依据：Base 控件与决策题；权限边界仍由原业务所有者决定。

## I-MANAGE 调整与管理

- 意图：改变持续生效的偏好、资源或配置。
- 默认结构：SettingsPage → SettingsSection → SettingsGroupCard → SettingsRow；资源管理沿现有列表和详情。
- 状态：当前值、编辑、保存中、保存成功、失败、不可用。
- `MANAGE-OWNER-01`：必须。使用既有偏好与业务保存所有者；界面设置不更换执行权威；编辑非当前配色不隐式切换应用主题；恢复默认范围明确。
- `MANAGE-DEFAULT-01`：默认。按用户目的分组；常用设置优先，专门微调按主题展开。即时偏好不增设虚假的保存按钮；需确认的持久配置保留原保存入口。
- 连续性/视觉/动效：内容决定行高；窄组沿共享容器重排，长标签不靠缩字或裁切解决。可探索：任务分组、摘要和领域字段。
- 依据：现有设置与偏好链路；第一阶段重点验证外观/通用，不代表整个设置中心完成迁移。

## I-RECOVER 异常与恢复

- 意图：知道影响并找到可行的继续路径。
- 默认结构：Feedback、EmptySettings 和业务现有恢复动作。
- 状态：空、加载失败、离线、明确拒绝、结果未知、恢复中、恢复完成。
- `RECOVER-TRUTH-01`：必须。错误归属明确；未知不改写为失败或成功，不自动重放；恢复动作必须由当前能力支持。
- `RECOVER-DEFAULT-01`：默认。影响和可行动作就近呈现，技术细节渐进展开；局部可选能力失败不遮蔽其余有效内容。
- 连续性/视觉/动效：保留输入和可用内容，错误使用共享语义颜色与文字，不仅依赖颜色或通知。可探索：领域诊断内容。
- 依据：既有状态、保存错误与 UNKNOWN 规则；本次设置旅程未注入全部失败组合。

## 跨交互族的共同语言

精确字体、颜色、空间和形状引用 [foundations](foundations.md) 与生产 token，不在模式卡复制数值。动效需说明目的（反馈、空间关系或连续性）、起止状态、可中断方式和减少动态效果后的状态；已有组件默认即时反馈时不添加装饰动画。窗口、滚动和焦点依现有壳层与平台所有者；每个区域明确阅读归属。

## 例外与验证

使用 [交互任务简报](templates/interaction-brief.json)记录用户意图、交互族、所选组件、默认规则及例外、验收状态和未知。这是设计时简报，不是页面渲染 DSL。先复用，再决定是否需要新变体；仅单页内容变化不新增模式。重复出现且有跨场景证据的例外，回到本文件或原组件合同修改；不要复制规则到每个页面。

验收分别报告：业务结果、交互连续性、视觉一致性、平台行为。规则检查通过不等于视觉获批；同一会话设计的设置页是首个迁移试点，不是独立泛化测试。第二阶段使用不同任务检验可迁移性，按用户审查决定是否启动。

## 对话阶段二的生产应用

默认的过程入口同时说明内容和展开动作；命令详情就近显示权威文字状态；子代理入口与面板使用原始委派任务名，缺失时沿既有身份回退。发送和打开返回继续由原生产所有者管理。适用范围、裁决依据与可重复检查见[对话阶段二](exercises/conversation-stage2.md)，不新增全局值，也不扩大 Base 准入。
