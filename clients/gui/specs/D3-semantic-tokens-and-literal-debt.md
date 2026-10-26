# D3（P1）：语义 Token 显式化与字面量债务

## 1. 背景与当前问题

- [tokens.json](../packages/ui/tokens.json) 只声明了约 72 个叶子 Token：foundation 约 67 个（字号、间距、圆角、阴影、动效、层级，以及少量状态色），theme 只有 4 个输入（background、foreground、accent、contrast）。
- 实际的颜色语义层在 [theme.ts](../packages/ui/src/theme.ts) 的 `paletteVariables` 里**以代码形式在运行时派生**，共 49 个 `--color-*` 变量。存在的问题：
  - 语义层和组件层混在一起：既有 `--color-surface`、`--color-border` 这样的语义角色，也有 `--color-history-comment`、`--color-result-card`、`--color-composer-catalog`、`--color-settings-card` 这样绑定具体组件的变量。
  - 派生参数是魔法数，比如 `mix(2100 / 231)`、`69.5 + contrastDelta * 0.15`；还有针对特定参考色的分支，比如 `p.accent === "#3a83f7"`、`p.background === (dark ? "#181818" : "#ffffff")`。注释写的是"Captured Codex user-message roles""observed dark hierarchy"，说明数值来自参考截图，不是来自规则。
  - 这一层不在 `tokens.json` 和 `registry.json` 的视野里：Token 速查、目录生成和审计都看不到这 49 个变量的派生关系。
- 状态语义不完整：`foundation` 里只有 `destructive`、`warning`、`success`、`muted`、`ring` 等少数颜色，产品里大量使用的运行中、待关注、UNKNOWN、已结算等状态没有统一的语义色（UNKNOWN 是整个产品的核心概念）。
- 字面量存量 390 处（颜色 145、圆角 163、字体 82），由 [literal-baseline.json](../design-system/literal-baseline.json) 棘轮约束，只增不减的保证已经有了，但没有主动下降的机制。缺少合适的语义 Token 是业务代码继续写字面量的原因之一（推断，需要在第 5 节验证）。

## 2. 目标与非目标

目标：

- 三层 Token 结构显式化：参考值（palette 输入）→ 语义角色 → 组件 Token。派生规则用数据声明，不再散落在代码里。
- 补齐状态语义色。
- 字面量存量按计划下降。

非目标：本任务不改变任何颜色的最终计算结果（视觉零变化）；新的语义角色在本任务内只定义并接入，不重新设计配色。

## 3. 架构决策

| 决策 | 状态 | 内容 |
| --- | --- | --- |
| D1：三层结构 | 已定 | 参考层：4 个 palette 输入；语义层：surface（base、raised、overlay、sunken、shell、navigation）、text（default、subtle、subtlest、inverse）、border（default、hover、focus）、interaction（hover、selected、pressed）、status（running、success、attention、unknown、error、settled）；组件层：只能引用语义层，不能直接 mix 参考值 |
| D2：派生规则声明化 | 已定 | 在 `tokens.json` 的语义层中，用结构化字段声明派生方式（例如 `{"mix": {"from": "foreground", "into": "background", "percent": ...}}`），由生成脚本产出 `paletteVariables`；`theme.ts` 只保留执行器 |
| D3：魔法数和参考色分支 | 已定 | 每个魔法数都需要写明来源（参考截图编号或规则）；针对特定参考色的分支（如 `#3a83f7`、`#181818`）改为声明式的"默认主题覆盖"，与自定义主题的通用规则分开 |
| D4：组件变量的去留 | **待逐项判断** | 对 `--color-history-comment`、`--color-result-card` 等组件变量，逐个判断是否能映射到某个语义角色。能映射的改为引用语义角色；确实特有的保留为组件 Token，并登记到组件合同 |
| D5：视觉零变化的保证 | 已定 | 用"计算样式快照"作为回归基准：对默认浅色、默认深色和 3 套自定义主题，在每种 contrast 取值下，导出全部 `--color-*` 的计算值；重构前后必须完全一致（D4 中明确批准的变化除外） |

## 4. 确定性路径

1. 先建立 D5 的快照测试：遍历主题 × contrast（至少取最小、默认、最大三档），输出全部变量的计算值，存为基准文件。
2. 在 `tokens.json` 中加入语义层和派生声明；生成脚本输出与现有 `paletteVariables` 等价的结果，快照测试必须完全一致。
3. 新增状态语义色（D1 的 status 组），并在 Token 速查和 `registry.json` 中登记。
4. 字面量下降：
   - 从 `literal-baseline.json` 中按文件列出字面量，给每处标注"可替换为某 Token / 需要新 Token / 合理例外"。
   - 按 [D2](D2-design-system-adoption.md) 的界面顺序逐个清理；合理例外需要在基线文件中逐条写原因。
5. 更新 [Token 速查](../packages/ui/src/generated/tokens.md) 的生成逻辑，让它展示三层关系；同步更新 [基础规则](../design-system/foundations.md) 和 `design/foundations/tokens.md`。

## 5. 不确定性路径

| 未知项 | 假设 | 验证方法 | 处置 |
| --- | --- | --- | --- |
| 字面量根因 | 业务代码写字面量主要是因为缺少合适的语义 Token | 抽查 50 处字面量，按"有现成 Token 没用 / 没有合适 Token / 合理例外"分类 | 如果大多数属于"有现成 Token 没用"，问题出在可发现性，要加强 Skill 和 lint；如果属于"没有合适 Token"，优先补语义层 |
| 状态色在自定义主题下的可读性 | 由 palette 派生的状态色在任意自定义背景下都能保持足够对比度 | 交给 [D4](D4-accessibility-gate.md) 的对比度矩阵检查 | 达不到就为状态色引入独立的参考值，而不是从 foreground 派生 |
| 组件变量映射 | 大部分组件变量可以映射到语义角色 | D4 逐项判断后统计比例 | 映射后视觉有变化的，需要单独的视觉评审 |

## 6. 实施切片

1. PR-1：计算样式快照测试。
2. PR-2：语义层声明化和生成脚本（快照完全一致）。
3. PR-3：状态语义色和登记。
4. PR-4：组件变量的映射判断（D4），每个变化附视觉证据。
5. PR-5 起：字面量按界面清理，与 D2 并行。

## 7. 验收标准

确定性：

- [ ] 快照测试覆盖全部 `--color-*`，PR-2 前后完全一致。
- [ ] `theme.ts` 中不再出现颜色字面量和未注明来源的魔法数（脚本检查：数字常量都要有对应的来源注释或来自 `tokens.json`）。
- [ ] 组件 Token 只引用语义 Token（生成脚本校验依赖方向）。
- [ ] 字面量：阶段 1 ≤ 250，阶段 2 ≤ 120；剩余每一条在基线中都有例外原因。
- [ ] `verify:design` 和 `test:design` 通过。

不确定性：

- [ ] 字面量根因抽查报告。
- [ ] 组件变量映射后的视觉变化经设计负责人确认。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md` 的 GUI 设计入口段落：颜色只能引用语义或组件 Token；新的颜色需求先加到 `tokens.json` 的语义层 |
| L2 Skill | `.agents/skills/gui-change/SKILL.md`：需要颜色时的决策顺序（语义角色 → 组件 Token → 申请新 Token），附三层结构图 |
| L3 Lint | 已有的设计审计字面量检查继续增量阻断；新增规则：`packages/ui/src/theme.ts` 以外的 TS/TSX 中禁止 `color-mix(` 和十六进制颜色字面量 |
| L4 CI | 计算样式快照测试和 Token 依赖方向校验并入 `verify:design` |
| L5 棘轮 | `literal-baseline.json`（down）；新增 `themeMagicNumbers`（down） |

## 9. 风险与回滚

- 生成结果和原代码存在细微差异（浮点、color-mix 的写法）：快照测试是硬门禁，必须完全一致才能合并。
- 回滚：PR-2 之前的 `theme.ts` 保留在 git 历史中；生成脚本可以回退为手写。
