# Base 设计系统候选

此处是[架构阶段 B](architecture.md#bbase-设计系统)的最小基础切片。复用已有生产角色和组件，以实际挂载上下文验证；独立模拟题目属于阶段 C。候选集的数据维护在 registry.json，下面的区块由 design:sync 生成。

<!-- BEGIN GENERATED: base -->

候选 ID：`desktop-core`；版本：`0.1.3`。该版本尚未冻结。

| 层 | 准入范围 |
| --- | --- |
| Foundations | 文字、表面与反馈、尺寸与间距、形状与动效 |
| Primitives | Button、ActionButton、Switch、Select、Feedback |
| Compositions | SettingsPage、SettingsSection、SettingsGroupCard、SettingsRow、SettingsSelect、SettingsSegmentedTabs、SettingsDisclosure、DecisionCard、ApprovalRequest、CollapsibleText、Messages、TurnProgress、TurnExecution、ToolEvent |
| Patterns | P-SETTINGS、P-DECISION |

### 验收条件

- 角色引用现有生产来源；目录不存数值副本
- 公共控件覆盖默认、禁用、处理中、失败和待确认
- 设置组合挂载真实 SettingsPage 上下文；不只展示脱离页面的库默认
- 明暗、14/18 字号、宽/窄与键盘交互有独立运行断言
- 决策与长文本保留原权威状态、全文和焦点可达性
- 设置单选使用公共control尺寸与navigation圆角；普通设置开关使用default，不自行降为sm
- 活跃设置说明保留独立角色、对比度偏好与自定义前景色，不连带修改禁用或过程信息
- 对话过程组合在逐步投影中验证接受消息占位、可见阅读锚点、返回最新、完成收敛及人工详情保留；异常不因final默认隐藏

### 边界

- 候选集不是已冻结 Base，不代表用户视觉验收完成
- 证据仅覆盖生产 renderer 组件和本地 fixture，不覆盖 Core、真实供应商或安装包
- 未覆盖全仓组件、其它平台和所有自定义主题；未完成独立做题实验
- 仅准入过程/阅读组合；复合fixture补充命令、图片和子对话组合证据，完整P-CONVERSATION、生产App宿主、重连和真实执行仍未准入

<!-- END GENERATED: base -->

## 使用与变更

页面先选候选模式，在现有组件的已定义接口上填内容和动作；生产数值与变体继续归原所有者。当前候选范围之外的组件仍是已有生产实现，不能据此称为 Base 已验收。新增公共成员需有真实消费者和对应状态证据；不能只把名字加入目录便视为准入完成。

## 复验入口

```sh
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
pnpm --dir clients/gui test:design --conversation-exercise
```

现有测试保存源码 SHA、工作树差异摘要、构建入口资产摘要、浏览器/viewport/DPR、状态条件、计算样式、原始截图哈希及失败诊断。设计状态和键盘/布局断言只证明列明的 fixture；截图不自动成为用户认可的视觉基线。

设置组合必须包含生产 SettingsPage 上下文。孤立 SettingsGroupCard 的库默认与挂载页面的变体可能不同；预览应复用实际组合，避免用 preview CSS 模拟生产上下文。

## 候选快照的探索题

[设置迁移题](exercises/settings-reflow.md)固定 `269ab4ec` 为输入，试用问题到证据的记录方法。它检验现有设置组合承受新内容的能力；候选快照固定仅用于实验复现，不表示 Base 已正式冻结、用户已接受视觉效果或正式阶段 C 已完成。

候选 `0.1.1` 的设置切片收敛：SettingsSelect 使用既有 control 尺寸和 navigation 圆角；设置预览与题目使用默认 Switch。输入快照 `0.1.0` 的对照暴露了紧凑档选择歧义，此处在公共所有者修正，不增加页面 CSS。当前仍保留窄容器上下排列的既有布局规则，未据参考的单一宽度更改断点。

候选 `0.1.2` 按[设置说明题](exercises/settings-contrast.md)核对明暗与对比度端点后，仅修订深色设置说明默认层级；保留本产品对比度斜率、明亮主题较强说明角色、禁用和已完成过程信息。自定义颜色通过原偏好归一化和派生，不增加消费者覆写。

[内容/决策迁移题](exercises/decision-transfer.md)固定候选0.1.2作为输入，组合现有 CollapsibleText 与 ApprovalRequest。长内容、窄容器、大字号与回执/失败/未知的探索不增加生产样式；窄卡正文沿用内部滚动，页脚动作留在滚动区外。该题保留候选版本，不因新增fixture提升Base版本，也不据一个额外题目声称通用性或盲测通过。

候选`0.1.3`将Messages、TurnProgress、TurnExecution和ToolEvent的过程/阅读切片纳入组合层，依据[动态信息流题](exercises/conversation-flow.md)。共享所有者统一phased/legacy过程收敛，工具详情保持挂载；正常终态与工具失败、UNKNOWN、未结算分别验证。正文增长时的可见锚点及显式返回通过生产阅读逻辑处理；预览尺寸只约束题目容器，不添加产品设计值。完整P-CONVERSATION仍在候选范围外，资源宿主返回、重连、真实执行及桌面验收未覆盖。
