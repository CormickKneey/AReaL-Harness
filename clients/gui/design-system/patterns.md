# 页面模式与有限选择

先按用户任务选模式，同一页面可组合内容模式，但沿用一个壳层和主滚动区。以下是 v1 默认；既有未迁移页面不构成新增自由变体的依据。

<!-- BEGIN GENERATED: patterns -->

| ID / 用户任务 | 最小组合 / 生产参考 | 允许变化 | 验收重点 |
| --- | --- | --- | --- |
| P-SETTINGS 修改偏好或配置 | SettingsPage + SettingsSection + SettingsGroupCard + SettingsRow；[参考](../renderer/src/settings/DisplaySettings.tsx) | 分组、字段、文案与现有控件类型 | 标签/控件对齐，窄窗换行，值和反馈真实 |
| P-RESOURCES 查找并管理资源 | SettingsSection + ActionButton + Feedback；[参考](../renderer/src/settings/PluginCenter.tsx) | 搜索、筛选、资源状态与详情 | 安装/连接状态分开；列表和详情职责清楚 |
| P-CONVERSATION 阅读并推进任务 | Messages + TurnExecution + ToolEvent + ConversationComposer；[参考](../renderer/src/design-system/ConversationTimelinePreview.tsx) | 消息类型、工具结果、合法动作与上下文 | 草稿保留；过程与最终结果边界清楚；未知提交不重放 |
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
