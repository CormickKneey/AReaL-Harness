# 组件与组合

组件承担有限、可重复的呈现与交互职责。先按[控件选择](controls.md)判断意图，再选择 GUI 已有实现。多个组件完成一个用户任务时进入[交互模式](../patterns/README.md)，涉及人的决定、Agent 身份和执行事实时引用[人机协作](../people-and-agents/README.md)。

## 三类职责

| 类别 | 拥有的决定 | 现有实现入口 |
| --- | --- | --- |
| 通用控件 | 标签、有限变体、键盘、焦点、可访问语义与局部展示状态 | [@areal/ui 组件](../../clients/gui/packages/ui/src/components) |
| AReaL 组合 | 消息、输入区、决策卡、设置组和资源入口的布局与呈现合同 | [GUI 组合目录](../../clients/gui/design-system/inventory.md) |
| `R-ENTRY-019` 产品绑定 | 业务对象、真实值、合法动作及原有服务接线 | GUI 原有控制器和执行契约；Web 接入时保留浏览器适配 |

`R-ENTRY-020` 通用控件不反向导入领域组合，也不持有执行循环、凭据或历史权威。组合接受原所有者的状态和动作，展示状态不替代业务结果。

## 分层

GUI 的目录、依赖与实验入口由 [@areal/ui](../../clients/gui/packages/ui/README.md#分层与成熟度)维护。某个区域专用的外观放在该区域的层里，不作为 core 组件的变体：例如输入区发送按钮是 conversation 层的 ComposerActionButton，不是 Button 的一个 variant。

## 成熟度

`R-ENTRY-021` 引用 [@areal/ui 的分层与成熟度合同](../../clients/gui/packages/ui/README.md#分层与成熟度)。本页不再保留已废弃的 `wip` 导出说明。[design-system-maturity](../../clients/gui/scripts/design-system-maturity.mjs)按真实生产消费者检查准入；Base 与 API 稳定性分别由原所有者记录。

## 首批 GUI 控件合同

首批合同见[按意图选择控件](controls.md#gui-就近合同)。合同邻接生产实现，参数与导出仍从类型读取，合同不扩大 GUI Base 准入。

产品中如何组合这些控件见[桌面工作台](../products/workbench/README.md)。

`R-ENTRY-023` 正文、公式、图表与Gen UI/MCP Apps的关系见[对话内容呈现系统](../content/conversation-content-system.md)。它统一展示、阅读和动作合同，保留专用渲染器与原宿主生命周期；目前是设计建议，不表示已增加新的公开组件或完成生产迁移。

## 一份合同对应一个实现所有者

`R-ENTRY-024` GUI 控件选择与后续 Web 复用边界由本目录维护。组件参数、导出与类型归实际代码，GUI 的控件尺寸见各组件合同，组合接线见[输入区与面板组合](../../clients/gui/design-system/patterns.md#输入区与面板组合)与[设置控件与反馈](../../clients/gui/design-system/patterns.md#设置控件与反馈)。同一事实不再抄成另一份 Props 表或手工组件名单。

`R-ENTRY-025` 新增或改变公共组件时，在原实现附近维护用途、适用与不适用条件、必要状态、键盘和焦点行为，以及生产示例。已有集中合同逐项整理，迁出后原位置改为引用。当前 [GUI registry](../../clients/gui/design-system/registry.json)仍拥有本端组件索引，不能把登记当作实际导出或运行准入证明。

`R-ENTRY-026` 示例使用生产实现。GUI 的[开发预览](../../clients/gui/renderer/src/design-system/main.tsx)与 [Base beta](../../clients/gui/design-system/base.md)分别记录可查看状态与已准入范围；共享目录不将所有已有组件自动列为稳定设计系统成员。

## 固定输入的独立复用

`R-ENTRY-027` [交付物核对题](reuse-exercise.md)固定内容、初态、操作结果、语义与代表条件。实现只消费冻结入口与既有生产组件；评估材料与实现输入分离。[本轮结果与归因](reuse-result.md)记录实际输入、运行与边界；单题不扩大所有组件、主题或平台的准入。
