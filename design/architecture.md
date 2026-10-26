# AReaL GUI 设计系统架构

`R-ARCH-037` [设计地图](README.md)组织以 GUI 为准的设计知识，为后续 Web 复用保留边界。当前已建立设计主题、首组文案建议与桌面工作台说明；[完整工作台候选](products/workbench/candidate.md)提供可操作的本地体验，首条任务视觉切片复用生产组件与执行控制器，其他路径迁移及视觉准入仍按[建设计划](roadmap.md)推进。

## 知识、实现与执行分开

`R-ARCH-038` 主题与实现入口见[设计知识地图](README.md#设计知识地图)。`design/` 维护产品设计知识。`docs/design/` 和 `docs/api/` 继续维护系统执行机制与公共契约。`clients/*` 维护实现、平台专属规则和准入。设计说明不能改变执行权威。

`R-ARCH-039` [共享焦点源](tokens/focus.css)是编译输入，由 GUI 样式构建和 Core 静态资源交付分别消费。它只提供界面默认值，不承载权限、状态或执行逻辑。

运行时由产品绑定组合，组合使用通用控件，控件消费本端基础角色。通用控件不反向依赖领域组合。设计地图、目录与证据属于开发期输入，不进入执行链，也不生成通用页面 DSL。

## 共享语义与平台差异

`R-ARCH-040` GUI 是设计与验收主线。后续 Remote Web、本地 Web 复用适用的设计知识与实现，浏览器权限、导航、响应式布局和原生能力差异由接入方适配。GUI 的设计选择不等待 Web 接入；已有 Web 接线只证明列明的消费范围。当前源码接线与默认值来源见[Token 地图](foundations/tokens.md)，建设范围与实现入口见[客户端地图](README.md#客户端地图)。

`R-ARCH-041` GUI 的 `registry.json` 仍是本端索引。I-*、P-* 和 CONV-* 的定义、生成区块与 surface 合同继续位于 GUI 所有者。共享主题拥有设计解释，平台规则引用该解释后明确本端要求；共享目录不再定义一套同 ID 的正文。

组件参数从类型和实现读取，结构索引由原 registry 维护，生产预览使用真实组件。规则、数值、接口和示例各有一个来源，派生文档或检索格式不反向编辑它们。

`R-ARCH-042` 按 [D-004](decisions/004-local-ui-package.md)，基础值、原纯调色板函数和共享展示实现由私有 [@areal/ui](../clients/gui/packages/ui/README.md)承接，原 GUI registry 继续拥有模式与 Base。包生成 CSS、类型、组件索引和 Agent 入口，原设计站提供独立包示例；[UI 包与架构](../clients/gui/renderer/design-system.html?ui-library)可核对实际来源与产物。共享组件的当前范围见[组件迁移](archive/gui/component-migration.md)，产品适配与Gen UI/MCP Apps宿主继续归原renderer、Electron和Core，不因展示包化而迁移执行权威。

## 文档整理与产品演进

`R-ARCH-043` 目录组织的决定见[D-001](decisions/001-shared-design-knowledge.md)。共享默认值的选择见[D-002](decisions/002-shared-semantics.md)，完整候选与路径迁移的取舍见[D-003](decisions/003-whole-candidate-and-migration.md)。具体任务、产物和进入下一阶段的条件只在[建设计划](roadmap.md)维护。日常修改按[作者流程](contributing.md)选择唯一正文所有者。

`R-ARCH-044` 文档格式版本、输入冻结、组件 API 成熟度、GUI Base 准入和单次运行结果分别记录。一个文档版本不能推出实现、视觉或发布验收已经通过。

## 验证边界

`R-ARCH-090` 证据类型、证明范围与材料要求统一引用[证据分层](../clients/gui/design-system/governance.md#证据分层)。安装包验证包资源、启动与平台集成，源码或预览通过不能代替包验收。

`R-ARCH-046` GUI 使用[既有准入与证据合同](../clients/gui/design-system/governance.md)。Web 在实际接入时独立验证浏览器路径，不用 GUI 结果代替，也不作为当前 GUI 交付的前置条件。设计目录只报告实际覆盖，不扩大 Base 或用户视觉接受范围。
