# 组件与组合

组件承担有限、可重复的呈现与交互职责。先按[控件选择](controls.md)判断意图，再选择平台已有实现。多个组件完成一个用户任务时进入[交互模式](../patterns/README.md)，涉及人的决定、Agent 身份和执行事实时引用[人机协作](../people-and-agents/README.md)。

## 三类职责

| 类别 | 拥有的决定 | 现有实现入口 |
| --- | --- | --- |
| 通用控件 | 标签、有限变体、键盘、焦点、可访问语义与局部展示状态 | [GUI 控件](../../clients/gui/renderer/src/components/ui)、[TUI UI](../../clients/tui/src/ui.rs)、[Web 界面](../../clients/web/app.js) |
| AReaL 组合 | 消息、输入区、决策卡、设置组和资源入口的布局与呈现合同 | [GUI 组合目录](../../clients/gui/design-system/inventory.md)、[TUI 设计](../../docs/design/tui.md) |
| 产品绑定 | 业务对象、真实值、合法动作及原有服务接线 | 各端控制器和执行契约；非交互输出见 [CLI 契约](../../docs/api/claude-cli.md) |

通用控件不反向导入领域组合，也不持有执行循环、凭据或历史权威。组合接受原所有者的状态和动作，展示状态不替代业务结果。

## 首批 GUI 控件合同

首批合同见[按意图选择控件](controls.md#gui-就近合同)。合同邻接生产实现，参数与导出仍从类型读取，合同不扩大 GUI Base 准入。

产品中如何组合这些控件见[桌面工作台](../products/workbench/README.md)。

## 一份合同对应一个实现所有者

跨端选择依据由本目录维护。组件参数、导出与类型归实际代码，GUI 的控件尺寸与组合接线见[组件指南](../../clients/gui/DESIGN_SYSTEM.md#公共组件与试点组合)。同一事实不再抄成另一份 Props 表或手工组件名单。

新增或改变公共组件时，在原实现附近维护用途、适用与不适用条件、必要状态、键盘和焦点行为，以及生产示例。已有集中合同逐项整理，迁出后原位置改为引用。当前 [GUI registry](../../clients/gui/design-system/registry.json)仍拥有本端组件索引，不能把登记当作实际导出或运行准入证明。

示例使用生产实现。GUI 的[开发预览](../../clients/gui/renderer/src/design-system/main.tsx)与 [Base 候选](../../clients/gui/design-system/base.md)分别记录可查看状态与已准入范围；共享目录不将所有已有组件自动列为稳定设计系统成员。
