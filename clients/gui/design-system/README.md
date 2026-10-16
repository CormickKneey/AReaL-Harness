# AReaL 客户端设计系统（架构与原型）

内部设计与 Agent 实现合同。目标是让同类任务得到同类页面：先选已有组合与控件，再填入业务内容。适用于桌面 renderer；Remote 复用组件时遵循同一展示合同，原生平台适配仍归各自所有者。

## 当前阶段

先读[设计系统架构](architecture.md)：架构 → Base → 固定题目 → 比较与改进。当前目录和生成校验是可运行的 v1 原型；尚未冻结 Base，也未完成独立做题实验。下列规则作为现有生产约束与候选模式的入口，具体准入按架构阶段执行。

当前最小实现范围见 [Base 候选 0.1.2](base.md)：只准入有真实组件与代表状态验证的基础切片，不把整个目录等同于 Base。

## 开工顺序

新增或修改页面、组件、布局、样式、动效、UI 文案时：

1. 从[页面模式](patterns.md)选择一个模式 ID，在变更说明中写出用户任务和生产参考入口。
2. 读取[基础规则](foundations.md)及 [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md) 中对应控件的规则。从[组件与页面目录](inventory.md)选择生产所有者；找到可复用组件后才编写页面。
3. 声明本次默认、交互、异常状态及宽窄条件。缺少合适模式时，按[变更与证据合同](governance.md)补一个有真实消费者的模式；不临场发明第二套控件或主题。
4. 实现后按该模式验收，并检查 owned diff。完成说明须列出模式、组件、例外、证据和未覆盖项；常规修改不要求另写一份设计提案。

系统级数据维护在 [registry.json](registry.json)，页面级数据按 [结构化实现流程](structured-flow.md) 引用它；[自动化机制与来源](automation.md) 解释生成链和当前检查边界。

## 按问题读取

| 问题 | 唯一规则位置 |
| --- | --- |
| 字体、色彩、层级、尺寸、密度如何选 | [foundations.md](foundations.md) |
| 设置、资源列表、对话、审批、详情怎么组成 | [patterns.md](patterns.md) |
| 已有什么、由谁实现、哪些仍未统一 | [inventory.md](inventory.md) |
| 新变体、例外、截图与验收如何进入 | [governance.md](governance.md) |
| 自动化如何工作、哪些已接入 | [automation.md](automation.md) |
| 如何将结构化目标变成实现与证据 | [structured-flow.md](structured-flow.md) |
| Cindy / Raft 学到什么、Codex 修正依据是什么 | [references.md](references.md) |
| Token 名、组件接口与预览命令 | [现有实现指南](../DESIGN_SYSTEM.md) |

## 权威与冲突

- 本目录规定用途、组合和准入；现有实现指南保留控件语义、长文本及预览操作细节。相同规则只在一个位置维护。
- 精确值与主题派生以生产 CSS 和外观设置为准；组件参数以实际导出为准。文档描述目标不等于代码已迁移。
- Codex 是桌面视觉与交互的第一参考；截图只证明所采状态，不授权复制它的产品能力、品牌或平台尺寸。Cindy / Raft 提供治理方法，不能覆盖本仓执行、权限与历史合同。
- 当前用户决定优先。规范与代码不符时，明确指出差异并修正拥有该事实的来源；不能选一个相近数值、复制局部样式后声称已统一。

## 目录与完成边界

本目录只放内部规范与稳定目录。生产 Token 继续放 `renderer/src/styles.css` 及外观所有者；公共控件继续放 `renderer/src/components/ui/`；组合继续由 `settings/`、Composer、DecisionCard 等既有模块拥有；预览继续放 `renderer/src/design-system/`。原始截图、DOM 与运行 manifest 保存在本地证据目录，不复制用户数据到公开源码。

目录原型提供有限选择和增量迁移约束，不声明 Base 已冻结或全仓视觉已统一。当前缺口集中在[目录状态](inventory.md#覆盖与缺口)；本次不批量重写业务页，不引入另一套组件库或 Token 生成链。
