# 维护设计规则

规则元数据位于 [rule-registry.json](rule-registry.json)。`registry.json`通过 `ruleRegistry` 指向它。每个条目记录稳定 ID、标题、唯一 owner、规则强度与正文 SHA-256。正文仍在拥有该决定的文档中，登记表不复制规则全文。

## 定义与引用

`R-RULES-001` 正文用可读的 `R-域-编号` 前缀声明 ID；既有 CONV/SET/WT 等带冒号的 ID 直接作为定义，不重复添加注释。`owner` 指向既有标题锚点。引用使用 ID 和 owner 链接。强度分别记为 `must`、`default` 和 `explore`。改写规则时更新原定义和登记摘要。

`R-RULES-002` 结构化规则使用 `json-pointer` 指向 registry 中的唯一字段。派生表格不形成新的正文定义。既有英文译文以 `translationOf` 标记为同一合同的译文，不独立规定规则强度。

## 文档角色与迁移

`R-RULES-003` [document-inventory.json](document-inventory.json)逐文件登记使用者、维护者、跨产品原则或过程证据。`active`、`generated`、`redirect`、`archived`分别表达现行文档、生成参考、旧入口和历史证据。GUI 专属现行合同迁到 GUI 目录；真实练习、研究和单次结果进入归档。旧路径与标题锚点保留一个迁移周期。当前合同不得为了字节指标进入归档。

## 校验范围

`R-RULES-004` 从 `clients/gui` 运行 `node scripts/design-rules.mjs`。校验拒绝重复 ID、重复定义、不存在的 owner 或引用、正文摘要变化、未分类文档、失效迁移目标和使用者入口超限。规范措辞扫描用于发现遗漏，不替代语义评审。引用、参数、实现和视觉验收仍由原所有者分别维护。

`R-RULES-005` 使用者路径为包说明、生成的 Token 入口和对应组件合同。入口预算只统计前两份，固定为 12,288 UTF-8 字节；组件合同按任务选择，不把所有组件预读成入口。

`R-RULES-006` 活跃设计文档口径固定为 `design/` 与 `clients/gui/design-system/` 下全部 Markdown，排除路径中的 `archive/`。旧入口也计入。基线为冻结的 66 篇、437,997 字节。包含 UI 合同及完整生成 Token 参考的扩展口径另行报告，不用于替换 40% 目标。
