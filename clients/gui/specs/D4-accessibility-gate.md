# D4（P1）：无障碍自动门禁

## 1. 背景与当前问题

- 代码里有一定的无障碍意识：`aria-*` 属性约 1260 处，37 个文件使用 `focus-visible`，[theme.ts](../packages/ui/src/theme.ts) 的 `readableForeground` 按 WCAG 相对亮度选择前景色。
- 但没有任何自动门禁：仓库中没有 axe-core、对比度矩阵或键盘路径检查；`prefers-reduced-motion` 只在 7 个文件中出现。
- 风险点：主题支持自定义 background、foreground、accent 和 contrast，而大量颜色由 `color-mix` 派生（见 [D3](D3-semantic-tokens-and-literal-debt.md)）。低对比度组合很容易出现，而且只在特定主题下才会暴露。
- 产品的核心交互（审批、Ask User、停止 Turn、Composer）都需要键盘可达；这些路径一旦回归，用户会被卡住。

## 2. 目标与非目标

目标：

- 三类自动检查：DOM 规则（axe）、Token 对比度矩阵、核心键盘路径。
- 先覆盖 Base 成员和核心界面，再逐步扩展。

非目标：本任务不做全站无障碍整改，只建立门禁并修复门禁发现的严重问题；不覆盖 Gen UI 和 MCP Apps 中第三方生成的页面内容。

## 3. 架构决策

| 决策 | 状态 | 内容 |
| --- | --- | --- |
| D1：DOM 规则检查 | 已定 | 在现有 `test:design`（隔离 Chrome）中集成 `@axe-core/playwright`，扫描设计系统预览页的全部 Base 组合和状态；严重级别 serious、critical 阻断 |
| D2：对比度矩阵 | 已定 | 纯脚本（不需要浏览器）：对默认浅色、默认深色和一组代表性自定义主题，在 contrast 的最小、默认、最大三档下，计算每对"文本 Token × 表面 Token"的对比度。正文要求 ≥ 4.5:1，大字和非文本 UI 要求 ≥ 3:1；例外需要登记 |
| D3：键盘路径 | 已定 | 用 Playwright 脚本断言：Composer 输入 → 发送；审批卡片的批准、拒绝都能用 Tab 和 Enter 完成；Ask User 选项可以用方向键选择；Esc 按面板归属停止；设置页的 Tab 顺序与视觉顺序一致 |
| D4：减弱动效 | 已定 | 所有动效 Token（`motion-*`）在 `prefers-reduced-motion: reduce` 下都要降为 0 或无位移；用 CSS 检查脚本验证 |
| D5：门禁节奏 | 已定 | 先以报告模式运行，修完存量严重问题后开启阻断；中、低级别问题进入棘轮跟踪 |

## 4. 确定性路径

1. 实现对比度矩阵脚本，依赖 D3 的语义层（D3 完成前，先直接读取 `paletteVariables` 的输出）。
2. 在 `test:design` 中集成 axe，输出按组件分组的报告。
3. 编写 D3 中的键盘路径测试，作为端到端 smoke 登记到 [E5](E5-test-system-and-cross-platform.md) 的测试清单。
4. 实现减弱动效检查。
5. 修复存量的 serious、critical 问题，然后开启阻断。
6. 在 [治理](../design-system/governance.md) 的完成条件中加入无障碍检查结果。

## 5. 不确定性路径

| 未知项 | 方法 | 处置 |
| --- | --- | --- |
| 存量问题规模 | 报告模式运行一轮，统计各级别问题数量 | 存量太多时，按组件分批修复，并先对新代码开启阻断 |
| 自定义主题的边界 | 自定义颜色是用户输入，无法穷举 | 对比度不足时，在主题设置界面给出提示或自动调整前景（已有 `readableForeground` 思路），而不是在门禁中穷举；这一点需要产品决策 |
| 屏幕阅读器的真实体验 | 自动检查覆盖不了朗读顺序和语义是否合理 | 每个发布周期由人用 VoiceOver 按固定清单抽查核心旅程（发送、审批、停止、设置），记录结果；不作为 CI 门禁 |

## 6. 实施切片

1. PR-1：对比度矩阵脚本（报告模式）。
2. PR-2：axe 集成（报告模式）。
3. PR-3：键盘路径测试。
4. PR-4：减弱动效检查。
5. PR-5 起：修复存量问题，然后开启阻断。

## 7. 验收标准

确定性：

- [ ] Base 成员的全部预览状态，axe 的 serious、critical 问题为 0。
- [ ] 对比度矩阵在默认浅色和默认深色的全部 contrast 档位下通过；自定义主题的结果作为报告输出。
- [ ] D3 中列出的键盘路径测试全部通过。
- [ ] 全部动效 Token 都遵守减弱动效设置。
- [ ] 以上检查并入 `test:design` / `verify:design`，在 CI 中执行。

不确定性：

- [ ] 首次 VoiceOver 抽查记录。
- [ ] 自定义主题对比度不足时的产品处理方式由人决策。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md` 的 GUI 设计入口段落：交互组件必须键盘可达并有可见焦点；新增颜色组合必须通过对比度矩阵 |
| L2 Skill | `.agents/skills/gui-change/SKILL.md` 的验收步骤加入：运行 axe 和对比度检查，并在 PR 中贴出结果 |
| L3 Lint | 启用 JSX 无障碍规则（oxlint 的 `jsx-a11y` 插件）：`alt-text`、`click-events-have-key-events`、`no-static-element-interactions`、`label-has-associated-control` 等，增量阻断 |
| L4 CI | axe、对比度矩阵、键盘路径、减弱动效检查必跑 |
| L5 棘轮 | `a11yModerateIssues`（down）、`contrastExceptions`（down） |

## 9. 风险与回滚

- axe 误报阻断开发：例外在配置中按规则和选择器登记，并写明原因。
- 回滚：门禁可以切回报告模式，不影响产品代码。
