# Base 设计系统 beta

`R-BASE-001` 此处是[架构阶段 B](architecture.md#bbase-设计系统)的最小基础切片。复用已有生产角色和组件，以实际挂载上下文验证；独立模拟题目属于阶段 C。准入集的数据维护在 registry.json，下面的区块由 design:sync 生成。

<!-- BEGIN GENERATED: base -->

候选 ID：`desktop-core`；版本：`0.4.1`；状态：`candidate`。

来源快照：待最终验收后记录；冻结与兼容所有者：[design-system/base.md](../design-system/base.md)。

完整准入归 [registry.json](registry.json) 的 `baseCandidate`。

### 成员准入

| 成员 | 合同 | 证据ID |
| --- | --- | --- |
| Button | [合同](../packages/ui/src/components/button/button.md) | E-CONTROLS, E-PLUGINS |
| ActionButton | [合同](../renderer/src/components/ui/action-button.md) | E-CONTROLS |
| Switch | [合同](../renderer/src/components/ui/switch.md) | E-CONTROLS, E-PLUGINS |
| Select | [合同](../renderer/src/components/ui/select.md) | E-CONTROLS |
| Feedback | [合同](../renderer/src/components/ui/feedback.md) | E-CONTROLS, E-PLUGINS |
| SettingsPage | [合同](../renderer/src/settings/SettingsPageParts.md#settingspage) | E-SETTINGS |
| SettingsSection | [合同](../renderer/src/settings/SettingsPageParts.md#settingssection) | E-SETTINGS |
| SettingsGroupCard | [合同](../renderer/src/settings/SettingsPageParts.md#settingsgroupcard) | E-SETTINGS |
| SettingsRow | [合同](../renderer/src/settings/SettingsPageParts.md#settingsrow) | E-SETTINGS |
| SettingsSelect | [合同](../renderer/src/settings/SettingsPageParts.md#settingsselect) | E-SETTINGS |
| SettingsSegmentedTabs | [合同](../renderer/src/settings/SettingsPageParts.md#settingssegmentedtabs) | E-SETTINGS, E-PLUGINS |
| SettingsDisclosure | [合同](../renderer/src/settings/SettingsPageParts.md#settingsdisclosure) | E-SETTINGS, E-PLUGINS |
| DecisionCard | [合同](../renderer/src/DecisionCard.md#decisioncard) | E-DECISION |
| ApprovalRequest | [合同](../renderer/src/DecisionCard.md#approvalrequest) | E-DECISION |
| CollapsibleText | [合同](../renderer/src/CollapsibleText.md) | E-DECISION |
| Messages | [合同](../renderer/src/Messages.md#messages) | E-CONVERSATION, E-RECOVERY |
| TurnProgress | [合同](../renderer/src/Messages.md#turnprogress) | E-CONVERSATION |
| TurnExecution | [合同](../renderer/src/Messages.md#turnexecution) | E-CONVERSATION |
| ToolEvent | [合同](../renderer/src/Messages.md#toolevent) | E-CONVERSATION |
| SettingsSearchInput | [合同](../renderer/src/settings/SettingsSearchInput.md) | E-PLUGINS |

证据见 [Base索引](base-evidence.md)。

### 验收条件

完整准入条件归 [registry.json](registry.json) 的 `baseCandidate.acceptance`。

### 边界

范围与限制归 [registry.json](registry.json) 的 `baseCandidate.limits`。冻结历史验收不能由当前生成索引扩张。

<!-- END GENERATED: base -->

## 使用与变更

`R-BASE-002` Base beta 是阶段 C 使用的固定 GUI 输入快照，尚不承诺稳定公共 API，也不代表全 GUI 已准入。`baseCandidate` 标识保留；`candidate` 表示等待验收，`frozen-beta` 表示完成列明验收并记录精确源码提交。冻结与兼容规则归本文件；成员、来源和状态归 registry.json；证据归 [base-evidence.md](base-evidence.md)。来源快照记录实际生产实现的完整提交；独立题目另外记录承载本合同与生成入口的完整冻结提交，不用会随分支移动的名称。

`R-BASE-003` 阶段 C 的独立题目通过生成的 [base-components.ts](../renderer/src/design-system/base-components.ts) 复用真实成员。该入口只服务开发验证，不建立发布包，也不改变正式应用版本。生产 Props、数值 Token 与样式仍归原源码所有者，目录不复制它们。路径检查不解析 JSX 证明调用关系；实际导出由类型检查验证。

`R-BASE-004` 删除已准入成员或改变已准入行为，需要提升 Base 版本并迁移消费者。新增验证夹具或补充同一合同的证据不提升版本，也不能悄悄改写已冻结快照的验收范围。新公共成员必须先有真实生产消费者、就近合同、有限变体和状态、可重复检查与可归属运行证据。未在成员表中的生产组件继续由原所有者维护。

`R-BASE-005` 历史探索题及其候选版本保留，以复现当时输入。Base 内部版本与应用发布、发行渠道和安装包版本独立。当前以 GUI 为先，后续 Web 需另行验证；CLI/TUI 不在此准入范围。P-RESOURCES 只准入插件目录、详情、当前项目启停、原提交核对及任务返回；真实文件与 Diff 返回证据单独保留，完整资源生命周期继续按真实任务准入。

0.3 与 0.4 的输入快照和迁移回归边界见[冻结记录](../../../design/archive/gui/base-candidate-history.md#03-与-04-的迁移记录)；当前候选的准入范围仍归上方 registry 索引。
## 复验入口

```sh
pnpm --dir clients/gui verify:design
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui design:build
pnpm --dir clients/gui test:design
pnpm --dir clients/gui test:design --conversation-exercise
```

`R-BASE-008` 现有测试保存源码 SHA、工作树差异摘要、构建入口资产摘要、浏览器/viewport/DPR、状态条件、计算样式、原始截图哈希及失败诊断。设计状态和键盘/布局断言只证明列明的 fixture；截图不自动成为用户认可的视觉基线。

设置组合的挂载前提见 [SettingsPage 生产上下文](../packages/ui/src/settings/settings-page/settings-page.md#生产上下文)。

## 候选快照的探索题

固定输入与早期候选修订见[候选实验历史](../../../design/archive/gui/base-candidate-history.md#候选快照的探索题)。
