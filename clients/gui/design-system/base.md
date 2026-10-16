# Base 设计系统候选

此处是[架构阶段 B](architecture.md#bbase-设计系统)的最小基础切片。复用已有生产角色和组件，以实际挂载上下文验证；独立模拟题目属于阶段 C。候选集的数据维护在 registry.json，下面的区块由 design:sync 生成。

<!-- BEGIN GENERATED: base -->

候选 ID：`desktop-core`；版本：`0.1.0`。该版本尚未冻结。

| 层 | 准入范围 |
| --- | --- |
| Foundations | 文字、表面与反馈、尺寸与间距、形状与动效 |
| Primitives | Button、ActionButton、Switch、Select、Feedback |
| Compositions | SettingsPage、SettingsSection、SettingsGroupCard、SettingsRow、SettingsSelect、SettingsSegmentedTabs、SettingsDisclosure、DecisionCard、ApprovalRequest、CollapsibleText |
| Patterns | P-SETTINGS、P-DECISION |

### 验收条件

- 角色引用现有生产来源；目录不存数值副本
- 公共控件覆盖默认、禁用、处理中、失败和待确认
- 设置组合挂载真实 SettingsPage 上下文；不只展示脱离页面的库默认
- 明暗、14/18 字号、宽/窄与键盘交互有独立运行断言
- 决策与长文本保留原权威状态、全文和焦点可达性

### 边界

- 候选集不是已冻结 Base，不代表用户视觉验收完成
- 证据仅覆盖生产 renderer 组件和本地 fixture，不覆盖 Core、真实供应商或安装包
- 未覆盖全仓组件、其它平台和所有自定义主题；未完成独立做题实验

<!-- END GENERATED: base -->

## 使用与变更

页面先选候选模式，在现有组件的已定义接口上填内容和动作；生产数值与变体继续归原所有者。当前候选范围之外的组件仍是已有生产实现，不能据此称为 Base 已验收。新增公共成员需有真实消费者和对应状态证据；不能只把名字加入目录便视为准入完成。

## 复验入口

```sh
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
```

现有测试保存源码 SHA、工作树差异摘要、构建入口资产摘要、浏览器/viewport/DPR、状态条件、计算样式、原始截图哈希及失败诊断。设计状态和键盘/布局断言只证明列明的 fixture；截图不自动成为用户认可的视觉基线。

设置组合必须包含生产 SettingsPage 上下文。孤立 SettingsGroupCard 的库默认与挂载页面的变体可能不同；预览应复用实际组合，避免用 preview CSS 模拟生产上下文。
