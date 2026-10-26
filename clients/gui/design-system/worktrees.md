# Worktree 设计系统：配置、准备与管理

`R-WORKTREE-001` 状态：生产 UI 已按本文迁移，代表状态的视觉对照与交互覆盖见[Worktree 验收题](exercises/worktrees.md)。本文继续拥有目标规则；实现与验证限于列明范围，不扩大全局 Token、执行合同或 Base 准入。适用桌面项目模式，首期脚本平台为 macOS、Linux。产品名称统一为 **Worktree**，设置导航使用 **Worktrees**。

`R-WORKTREE-002` 目标是让用户在发送前选清工作位置，发送后看懂准备过程，进入聊天后保留轻量的工作区身份，并在设置中管理目录与项目环境。视觉以用户提供的九张 Codex 截图为参照，沿用 AReaL 的字体、语义色、图标与公共控件。

## 依据与取舍

`R-WORKTREE-051` 九张截图的逐项观察和采样限制见[冻结参考观察](../../../design/archive/gui/worktree-reference-observations.md)。下表保留当前采纳边界。

| 截图能力 | AReaL 的采纳边界 |
| --- | --- |
| `R-WORKTREE-005` “with local code changes”来源 | 当前只从已提交版本创建，不复制未提交内容。分支子页清楚说明此限制，不把当前文件状态做成可用选项 |
| `R-WORKTREE-006` 自动删除前保存恢复快照 | 当前删除合同没有可恢复快照承诺；不展示该说明或恢复图标。沿原安全检查，删除受阻时保留目录 |
| `R-WORKTREE-007` Windows 脚本标签 | 本期仅 Default / macOS / Linux，不展示可编辑的 Windows 标签 |
| Variables 入口 | 只解释当前三个受支持变量；不借截图新增自定义变量、密钥或注入能力 |
| `R-WORKTREE-008` 目录行中的第二个小图标 | 单帧不能证明用途；本期只定义查看详情与删除，不猜测归档、恢复或打开系统目录能力 |

实际创建、取消、清理与恢复语义继续归[Worktree 指南](../../../docs/guides/worktrees.md)和[桌面宿主合同](../../../docs/api/desktop.md#桌面宿主-worktree-契约)。这里规定如何呈现事实，不重建状态机。

## 在现有系统中的位置

| 层级 | Worktree 的职责 | 唯一来源 |
| --- | --- | --- |
| Foundations | 表面、字号、字重、间距、图标、焦点、动效 | [foundations](foundations.md)、[Token 来源与使用](../../../design/foundations/tokens.md)、生产 CSS 与外观偏好 |
| `R-WORKTREE-009` 通用控件 | Button、Switch、搜索、Tabs、Popover、详情、输入与反馈 | 原 UI / Settings 控件；不在控件中认识项目、分支或创建请求 |
| `R-WORKTREE-010` 领域组合 | 配置行、分支条目、准备摘要、目录行、脚本字段、Action 条目 | [UI包Worktree层](../packages/ui/src/worktree)承接有限组合与就近MD，原Worktree所有者保留数据/操作适配，Props由真实TS生成 |
| `R-WORKTREE-011` 交互模式 | 选择、观察、管理、返回与恢复 | 复用 P-DETAIL、P-STATUS、P-SETTINGS；对话顺序沿 P-CONVERSATION |
| 产品布局 | Composer 上下文条、时间线、侧栏、设置导航 | 原 App / Messages / TaskListItem / SettingsWorkspace |

`R-WORKTREE-012` 主要交互族为 [I-INPUT、I-OBSERVE、I-MANAGE](interactions.md)，返回和异常沿 I-RETURN / I-RECOVER。页面只组合既有模式，不新增 P-WORKTREE、组件库或 Token 生成链。本文的 WT-* 是领域设计检查点，不替代通用规则 ID。

## 视觉基础与几何

以下尺寸是**后续实现的局部候选值**，不是从截图实测得出的事实，也不是对全局 Token 的修改。若大字号或长文案迫使调整，先保持列关系、对齐与可达性，再在原组件所有者记录差异。

| 对象 | 目标规则 |
| --- | --- |
| 设置内容列 | General、项目列表、环境编辑共用一条居中阅读列；候选最大宽度 41rem，窄窗占可用宽度。沿 SettingsWorkspace 外边距，不给各区块单独设置宽度 |
| `R-WORKTREE-013` 配置浮层 | 候选宽度 20rem，上限为窗口可用宽度减两侧 `--spacing-inline`；主菜单、分支、环境子页等宽，右边缘与齿轮对齐。优先向上，碰撞时由公共 Popover 调整位置 |
| 行结构 | 图标 / 主标签 / 弹性空间 / 当前值 / 尾部动作；名称列 `min-width: 0`，尾部动作不收缩。同类行共享左右边缘与图标列 |
| 控件密度 | 配置菜单与资源行采用紧凑列表密度，最小行高沿 `--spacing-control-lg`，文字增长时自然增高；设置输入与开关仍沿原交互类型尺寸，不缩成截图位图大小 |
| 组内与组间 | 图标、标签和值用 `--spacing-inline`；字段之间用 `--spacing-field`；页面区块之间用 `--spacing-section`；容器内边距用 `--spacing-panel` |
| `R-WORKTREE-014` 表面层级 | 页面底色 → 一个安静的设置组 / 浮层表面 → 必要的输入或日志内衬。项目列表行不再套卡片；完成标识没有常驻大边框 |
| `R-WORKTREE-015` 圆角与边线 | 外浮层沿 `--radius-overlay`，输入/按钮/列表高亮沿 `--radius-control`；组内分隔使用原边线角色。不得从截图采样 hex 或新增相近灰色 |
| 文字 | 页面标题沿 SettingsPage；普通标签、项目/会话名使用 regular；说明、当前值与状态摘要用 UI caption / 次级前景；正文沿内容字号；代码和日志用 `--font-mono` |
| `R-WORKTREE-016` 状态 | 运行使用已有状态色及文字；正常完成降低强调；失败用错误角色；未知用明确文字。禁用、次级、完成是不同语义，不能共用一层低透明度 |
| `R-WORKTREE-017` 图标 | 沿现有图标集：文件夹 / 本机 / 齿轮 / Git 分支 / GitFork / 勾 / Chevron / Plus / Trash。图标尺寸沿原控件，不以 emoji 或新品牌图替换 |

`WT-VISUAL-01`：先核对轮廓、阅读宽度、对齐和层级，再核对局部细节。禁止以加粗所有标签、每段套边框、显示完整 UUID 或缩字号弥补信息组织问题。明暗主题沿同一语义角色，不能仅在深色截图中成立。

## Composer：上下文条与配置菜单

组件专属合同由[WT-PICKER-01 等规则](../packages/ui/src/worktree/worktree-picker/worktree-picker.md#composer上下文条与配置菜单)维护。

### 分支与环境子页

见[组件合同](../packages/ui/src/worktree/worktree-picker/worktree-picker.md#分支与环境子页)。

## 时间线：准备、取消与完成

组件专属合同由[WT-PROGRESS-01 等规则](../packages/ui/src/worktree/worktree-status/worktree-status.md#时间线准备取消与完成)维护。

## 侧栏与会话工作区身份

侧栏身份见 [WT-IDENTITY-01](../packages/ui/src/workbench/task-list-item/task-list-item.md#worktree-身份)；会话入口与操作位置见 [WorktreeWorkspace](../packages/ui/src/worktree/worktree-workspace/worktree-workspace.md#会话入口与操作位置)。

## 设置：页面骨架与 General

组件专属合同由[WT-SETTINGS-01 等规则](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#设置页面骨架与-general)维护。

### General

见[组件合同](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#general)。

### 按项目管理目录

见[组件合同](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#按项目管理目录)。

## 设置：Environments 与环境编辑

组件专属合同由[WT-ENV-01 等规则](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#设置environments-与环境编辑)维护。

### Action 的有限形态

见[组件合同](../packages/ui/src/worktree/worktree-settings/worktree-settings.md#action-的有限形态)。

## 有限例外与共享规则

`R-WORKTREE-019` 下面是对[控件选择](patterns.md#控件选择)的**本领域有限例外**，只限所列用途；由 Worktree 组合承担，不增加公共控件的新默认值。

| 例外 | 为什么需要 | 限制 |
| --- | --- | --- |
| `R-WORKTREE-020` General / Environments 标签导航 | 参考强调同一设置领域内的两个页面 | 采用真实 tab / 导航语义，不当作布尔设置；仍复用原标签控件 |
| `R-WORKTREE-021` 三个脚本平台标签 | 用户需要来回编辑同一个脚本的多个平台版本 | 这是编辑面板切换，允许三个可见标签；不推广到普通三值配置 |
| `R-WORKTREE-022` 分支 / 环境的行式选择 | 长列表需要搜索、分组和返回，参考主菜单要求单行 label/value | 沿公共浮层与选择语义组合，不另造通用 Select；普通设置仍用 SettingsSelect |
| `R-WORKTREE-023` 目录行首 Chevron | 表达树层级，保留紧凑的文件目录语言 | 只用于目录树；普通设置说明仍用明确“展开 / 收起”的披露入口 |
| `R-WORKTREE-024` 目录行尾图标删除 | 管理列表需要稳定窄动作列 | 始终可键盘触达、有可访问名称及确认；普通设置操作继续文字按钮 |

## 状态、内容与可访问性

`WT-STATE-01`：可见文本取决于权威状态与用户动作。以下补齐截图未覆盖的状态，是设计决定；不得将其写成 Codex 已观察行为。

| 状态 | 必须看见 | 不可出现 |
| --- | --- | --- |
| 加载 / 刷新 | 所属项目、已有值、局部忙碌说明 | 把暂未读到当成没有分支或环境 |
| 无匹配 / 无资源 | 区分搜索无匹配、环境为空、目录为空 | 一律用同一句“暂无数据” |
| 创建 / 绑定 / Setup | 当前确认阶段、等待发送、可用取消入口 | 伪百分比、模型已开始回答的暗示 |
| 已创建但未 ready | 创建事实与剩余准备说明 | 解除发送等待或显示完整成功 |
| 取消中 / 已取消 | 正在核对终止 / 已确认取消；目录与草稿去向 | 点击即显示已终止、静默改用原目录 |
| ready / 正常聊天 | 一行创建标识、真实工作区身份、普通 Composer | 成功大卡片长期占据主阅读列 |
| `R-WORKTREE-025` failed | 哪一步失败、保留内容、宿主允许的恢复动作 | 不加条件的“再试一次即可” |
| UNKNOWN | 结果待核对、原请求核对入口 | 自动重跑、自动删除或回退 |
| 保存 / 删除 / Action 忙碌 | 所属对象与重复操作限制 | 只显示全页 spinner 丢失上下文 |
| `R-WORKTREE-026` 删除被阻挡 | 可理解的真实原因、目录仍保留 | 成功 toast 后实际目录仍在、强制删除捷径 |

`R-WORKTREE-027` 文字沿现有 i18n；中文“Worktree / 分支 / 环境 / 设置脚本 / 清理脚本 / 操作”，英文与参考相同用途保持简短。状态使用动词与对象，不把内部 UUID、枚举或错误码当作主要说明。详情可保留必要的技术身份以便核对。

- `R-WORKTREE-028` 齿轮、返回、刷新、添加、删除、工作区标识均有对象相关的可访问名称。tooltip 是补充，不能承担唯一说明。
- `R-WORKTREE-029` 主配置不是 `menu` 内嵌不可达表单：含开关的浮层沿 Popover 的普通焦点序列；分支和环境列表采用单选列表语义，选中状态可读，不只显示勾。
- `R-WORKTREE-030` 键盘可打开、切换、选择、返回、关闭；关闭回到原触发器。进入设置再返回时保留同项目草稿；不存在的旧触发器不能抢焦点。
- 平台标签具备 tab / tabpanel 关系与键盘切换；输入关联标签、说明与错误。折叠区暴露 expanded / controls，隐藏内容退出焦点序列。
- `R-WORKTREE-031` 状态摘要使用适度的 live region；原始日志不逐字播报。失败与未知在详情收起时仍可发现。后台任务不能因增量抢当前窗口焦点。
- `R-WORKTREE-032` 窄窗优先保住名称、当前值、尾部动作及返回；必要时设置行上下排列，不缩小字体。日志、代码与详情路径可读全，页面无横向溢出。
- `R-WORKTREE-033` 沿原动效与 reduced motion；静态截图不提供新时长。减少动态效果时保留状态文本与静态图标，不以停止旋转表示执行结束。

## 实现落点与保留差异

下表记录生产落点。精确参数与状态投影以源码为准，已实现的展示不代表所有宿主和平台均经过验收。

| 目标 | 当前落点与边界 | 原所有者 |
| --- | --- | --- |
| 配置行与单浮层子页 | 三行主菜单、同浮层分支 / 环境子页、搜索和焦点返回。宿主只提供分支字符串，因此使用真实分支列表，不伪造本地 / 远端元数据分组 | [WorktreeStarter](../renderer/src/WorktreeStarter.tsx)、[DraftComposer](../renderer/src/DraftComposer.tsx) |
| 准备 / 完成层级 | 默认关闭日志，取消控制同排，ready 收敛为轻量事实。创建记录只绑定完整本地历史的首轮 Prompt，不挂在继承或分页后的其他消息下 | [WorktreeStatus](../renderer/src/WorktreeStatus.tsx)、[Messages](../renderer/src/Messages.tsx) |
| 侧栏单标识 | 名称为主，尾部分叉图标与具名状态，不显示 UUID 第二行 | [TaskListItem](../renderer/src/TaskListItem.tsx) |
| 设置导航层级 | General 一个主设置组与紧凑目录；项目列表、环境列表、独立编辑页分开。高级前缀与安全删除提示保留 AReaL 能力边界 | [WorktreesSettings](../renderer/src/settings/WorktreesSettings.tsx)、[SettingsWorkspace](../renderer/src/settings/SettingsWorkspace.tsx) |
| 脚本与 Actions | 独立平台标签、只读 Variables、单行 Action 展开编辑；语义表面与边框使用既有角色 | [WorktreesSettings](../renderer/src/settings/WorktreesSettings.tsx)、原 Settings 控件 |

`R-WORKTREE-038` 局部几何与样式落在 [Worktree.css](../renderer/src/Worktree.css) 和 [WorktreesSettings.css](../renderer/src/settings/WorktreesSettings.css)；状态从已有服务读取。Dirty 刷新保留原 revision，版本冲突后需放弃再重新编辑，不能静默推进 revision 覆盖其他配置。

## 固定样例与后续验收

见[冻结原文](../../../design/archive/gui/worktree-design-exercise.md#固定样例与后续验收)。

## UI包采用

`R-WORKTREE-047` 五个 Worktree 组合从私有 `@areal/ui/experimental` 消费，样式入口为 `worktree.css`。包与宿主职责见[架构分层](architecture.md#分层与所有权)，各组件合同维护本地交互和原业务适配边界。

`R-WORKTREE-048` 操作失败/成功通知采用统一NotificationToast；提示自动消失不清除原记录或目录详情中的受阻原因。
