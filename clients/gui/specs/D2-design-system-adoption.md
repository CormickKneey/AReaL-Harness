# D2（P0）：设计系统采用率与包外样式迁移

## 1. 背景与当前问题

- 237 个生产 tsx 文件中，只有 70 个引用 `@areal/ui`，约 30%。
- 样式归属：renderer 下 37 个 CSS 文件共 6953 行，`packages/ui` 的 CSS 只有 1695 行，约 80% 的样式在设计系统之外。
- 字面量存量集中在包外：`renderer/src/workbench.css` 144 处，`settings/SettingsWorkspace.css` 45 处，`settings/MobileSettings.css` 44 处（见 [literal-baseline.json](../design-system/literal-baseline.json)）。
- 治理侧投入很大：`design/` 和 `design-system/` 共约 470 KB 文档，`scripts/` 下有 20 个 `design-system-*.mjs`。但这些投入只覆盖了少数界面。新功能大概率继续写本地 CSS，设计系统越来越"写在纸上"。

## 2. 目标与非目标

目标：

- 按用户旅程和界面优先级迁移，而不是按文件平均推进：先迁移用户最常看到、最常改动的界面。
- 新增 UI 不再产生包外样式和字面量。
- 采用率和包外样式量成为可追踪的指标。

非目标：不重新设计视觉；不扩大 Base 准入（准入走 [治理](../design-system/governance.md) 流程）；不迁移 Gen UI 和 MCP Apps 的隔离页面。

## 3. 架构决策

| 决策 | 状态 | 内容 |
| --- | --- | --- |
| D1：迁移顺序 | 已定 | ① 对话（`Messages`、`Composer`、审批、过程组，生产已部分采用）→ ② 工作台外壳（`workbench.css`，字面量最多）→ ③ 设置（`SettingsWorkspace`、`MobileSettings`、`PluginCenter`）→ ④ 其余面板（任务中心、预览、终端外壳） |
| D2：与 E3 联动 | 已定 | [E3](E3-renderer-app-decomposition.md) 拆出某个领域的视图时，同一界面的样式迁移放在相邻 PR 里，避免同一批文件改两遍 |
| D3：本地样式的合法形态 | 已定 | 允许保留的包外样式只有业务布局（网格区域、特定面板尺寸），必须使用 Token，不能有颜色、圆角、字体字面量；文件名改为 `*.layout.css` 以便统计 |
| D4：新增 UI 的规则 | 已定 | 新增的生产 tsx 要么使用 `@areal/ui` 组件，要么在 PR 中按 [完成条件](../design-system/governance.md#完成条件) 说明例外；新增 CSS 文件只能是 `*.layout.css` |
| D5：迁移完成的定义 | 已定 | 某个界面迁移完成 = 该界面相关的 CSS 字面量为 0、组件来自 `@areal/ui`，并且通过该界面的视觉比对 |

## 4. 确定性路径

1. 在 [G0](G0-guardrails-and-health-metrics.md) 指标中加入：`uiAdoptionRatio`、`rendererCssLines`、`nonLayoutCssFiles`。
2. 为每个界面建立迁移清单（列出涉及的 tsx、CSS 文件、当前字面量数、可替换的组件），作为 PR 正文的一部分。
3. 每个界面一个或多个 PR：替换组件，删除被替代的本地 CSS，字面量改为 Token；如果缺少需要的 Token，先走 [D3](D3-semantic-tokens-and-literal-debt.md)。
4. 每个 PR 运行 `verify:design`、`test:design`，以及受影响界面的 smoke。

## 5. 不确定性路径

| 未知项 | 假设 | 验证方法 | 处置 |
| --- | --- | --- | --- |
| 视觉回归 | 替换组件后会出现细微的尺寸、间距、颜色差异 | `test:design` 截图加计算样式比对，覆盖深浅主题、UI 字号、宽窄窗口；关键界面在真实 Electron 中截图 | 差异分为"客观偏差、产品约束、主观润色"三类（按 [自动化说明](../design-system/automation.md) 的方法），只修客观偏差，其余记录在案由人裁决 |
| 组件能力不足 | 某些本地样式实现了包内组件不支持的变体 | 迁移清单中逐项标记"包内已有、需新增变体、业务特有" | 需新增变体的走 Base 准入流程；业务特有的保留为 `*.layout.css` |
| 迁移收益 | 迁移后同类改动的成本会下降 | 观察迁移后该界面相关 PR 的 diff 规模和返工次数 | 只作为观察项，不作为门禁 |

停止条件：某个界面的视觉差异超过 5 处无法归类，或者需要新增超过 3 个组件变体时，停下来提交差异报告，由设计负责人裁决后再继续。

## 6. 实施切片

1. PR-1：指标接入和全部界面的迁移清单（只有文档和脚本）。
2. PR-2 至 PR-N：按 D1 顺序迁移，每个界面 1–3 个 PR。
3. 最后：开启 D4 的阻断规则（新增 CSS 只能是 `*.layout.css`）。

## 7. 验收标准

确定性（分阶段目标）：

| 指标 | 当前 | 阶段 1（对话 + 工作台） | 阶段 2（全部 D1 界面） |
| --- | --- | --- | --- |
| `uiAdoptionRatio` | 30% | ≥ 45% | ≥ 70% |
| `rendererCssLines` | 6953 | ≤ 5500 | ≤ 3500 |
| `workbench.css` 字面量 | 144 | 0 | 0 |
| 非 `*.layout.css` 的 renderer CSS 文件 | 37 | ≤ 25 | ≤ 5 |

本轮经用户确认按真实样式归属收敛。控件采用率≥70%、工作台字面量为0，并完成现有公共DOM规则迁移；必要域样式的来源、消费者与退出条件登记在 [style-exceptions.json](../design-system/style-exceptions.json)。本轮CSS上限按仓库格式器规范化后的10061行、25份非布局文件设棘轮（同格式迁移前12429行；9094是此前部分格式化的中间读数，迁移完成、格式化前为5313行）；原阶段2的3500行/5份保留为后续目标，不把业务样式改名为布局或搬进无真实消费者的组件。新增renderer CSS仍只能是Token化的`.layout.css`，新增字面量仍阻断。

- [ ] 每个迁移 PR 的 `verify:design`、`test:design` 和受影响 smoke 都通过。
- [ ] 各项指标只朝改善方向变化（棘轮）。

不确定性：

- [ ] 每个界面迁移后的视觉对照证据（深浅主题、字号、宽窄窗口）经人复核，区分预览、源码 Electron 和安装包三种验证范围。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md` 的 GUI 设计入口段落：新增 UI 必须优先使用 `@areal/ui`；新增 CSS 只允许 `*.layout.css`，且不能出现颜色、圆角、字体字面量 |
| L2 Skill | `.agents/skills/gui-change/SKILL.md`：开工时先查 `dist/components.json` 和 Token 速查；找不到合适组件时的处理路径（提变体需求，而不是写本地样式） |
| L3 Lint | 新增 CSS 文件名必须匹配 `*.layout.css`（在增量检查中实现）；现有 `design-system-audit.mjs` 的字面量检查保持增量阻断 |
| L4 CI | `verify:design` 必跑；`gui-health` 检查采用率和 CSS 行数棘轮 |
| L5 棘轮 | `uiAdoptionRatio`（up）、`rendererCssLines`（down）、`nonLayoutCssFiles`（down）、字面量（沿用 `literal-baseline.json`） |

## 9. 风险与回滚

- 大面积视觉变化影响用户：每个界面单独 PR、单独验收；发现问题回退该界面的 PR 即可。
- 与功能开发冲突：迁移 PR 小步快合；E3 联动时提前协调。
