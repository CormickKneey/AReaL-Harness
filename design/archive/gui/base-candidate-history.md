# Base 候选实验历史

以下保留早期候选输入、取舍与验收边界。当前版本与准入以 [Base](../../../clients/gui/design-system/base.md)和 [registry.json](../../../clients/gui/design-system/registry.json) 为准。

## 候选快照的探索题

[设置迁移题](exercises/settings-reflow.md)固定 `269ab4ec` 为输入，试用问题到证据的记录方法。它检验现有设置组合承受新内容的能力；候选快照固定仅用于实验复现，不表示 Base 已正式冻结、用户已接受视觉效果或正式阶段 C 已完成。

<!-- rule:R-BASE-010 -->
候选 `0.1.1` 的设置切片收敛：SettingsSelect 使用既有 control 尺寸和 navigation 圆角；设置预览与题目使用默认 Switch。输入快照 `0.1.0` 的对照暴露了紧凑档选择歧义，此处在公共所有者修正，不增加页面 CSS。当前仍保留窄容器上下排列的既有布局规则，未据参考的单一宽度更改断点。

<!-- rule:R-BASE-011 -->
候选 `0.1.2` 按[设置说明题](exercises/settings-contrast.md)核对明暗与对比度端点后，仅修订深色设置说明默认层级；保留本产品对比度斜率、明亮主题较强说明角色、禁用和已完成过程信息。自定义颜色通过原偏好归一化和派生，不增加消费者覆写。

<!-- rule:R-BASE-012 -->
[内容/决策迁移题](exercises/decision-transfer.md)固定候选0.1.2作为输入，组合现有 CollapsibleText 与 ApprovalRequest。长内容、窄容器、大字号与回执/失败/未知的探索不增加生产样式；窄卡正文沿用内部滚动，页脚动作留在滚动区外。该题保留候选版本，不因新增fixture提升Base版本，也不据一个额外题目声称通用性或盲测通过。

候选`0.1.3`将Messages、TurnProgress、TurnExecution和ToolEvent的过程/阅读切片纳入组合层，依据[动态信息流题](exercises/conversation-flow.md)。共享所有者统一phased/legacy过程收敛，工具详情保持挂载；正常终态与工具失败、UNKNOWN、未结算分别验证。正文增长时的可见锚点及显式返回通过生产阅读逻辑处理；预览尺寸只约束题目容器，不添加产品设计值。完整P-CONVERSATION仍在候选范围外，资源宿主返回、重连、真实执行及桌面验收未覆盖。

<!-- rule:R-BASE-013 -->
候选0.1.4协调当前生产设置变体与共享输入布局；SettingsSelect使用其既有sm，主满屏资源输入显式compact，Side默认布局不被祖先改变。较早题目的0.1.1/0.1.3尺寸与图片展开方式属于对应快照，不能覆盖当前生产所有者。该修订不冻结视觉基线，不将整个SidePane或完整资源生命周期纳入Base准入。

## 0.3 与 0.4 的迁移记录

0.3.0 新准入已有 SettingsSearchInput 的 search-lg 有限状态，并收敛插件管理路径，未新增生产组件或 Token 源。0.2.0 的独立输入 `c98af14e00faad1b28164f660629b57c4bccea6e` 与当时结果保留；既有消费者在 0.3.0 上的运行属于迁移回归，不再次称为独立盲试。

0.4.0 只扩展 Messages 的同窗口 Renderer 阅读恢复合同，不增加成员、模式或 Token。已加载段落、偏移、草稿、原执行和显式跟随选择分别验证；完整应用重启与未加载历史不在范围内。0.2 与 0.3 的固定输入和历史结果保留，既有消费者的同题复验仍属于迁移回归。
