# G0（P0）：GUI 健康指标与棘轮基础设施

## 1. 背景与当前问题

GUI 的结构性问题（巨型文件、无类型的 Main、低设计系统采用率、平台硬编码）都是逐步累积起来的，过程中没有任何机制报警。仓库里已有的唯一棘轮是 [literal-baseline.json](../design-system/literal-baseline.json)（设计字面量只允许减少），说明这种模式可行，但只覆盖了一个维度。

当前基线（在仓库根执行，`clients/gui` 为工作目录）：

| 指标 | 当前值 | 复现命令 |
| --- | --- | --- |
| Main 进程源码行数（不含 `vendor`） | 28080 行 / 99 个文件 | `find app/src -path app/src/vendor -prune -o \( -name '*.cjs' -o -name '*.js' \) -type f -print \| xargs cat \| wc -l` |
| 启用类型检查的 Main 文件 | 0 | `grep -rl '@ts-check' app/src \| wc -l` |
| `renderer/src/App.tsx` 行数 / hook 调用数 | 5052 / 132 | `wc -l renderer/src/App.tsx`；`grep -oE '\buse(State\|Ref\|Effect\|Callback\|Memo\|Reducer\|LayoutEffect\|Context)\b' renderer/src/App.tsx \| wc -l` |
| 超过 1000 行的源码文件 | `App.tsx`、`preview.cjs`(3863)、`LexicalChatInput.tsx`、`worktrees.cjs` 等 | 见下文脚本 |
| 引用 `@areal/ui` 的生产 tsx 比例 | 70 / 237 | `grep -rlE "from ['\"]@areal/ui" renderer/src --include=*.tsx \| wc -l` |
| 引用 `@areal/ui/wip` 的文件 | 56 | `grep -rl '@areal/ui/wip' renderer/src \| wc -l` |
| CSS 行数：renderer / `packages/ui` | 6953 / 1695 | `find renderer/src -name '*.css' \| xargs wc -l` |
| 设计字面量存量 | 390（颜色 145、圆角 163、字体 82） | `literal-baseline.json` |
| 硬编码 `/private/tmp` 的脚本 | 104 | `grep -rl '/private/tmp' scripts \| wc -l` |
| `package.json` 中的 `test:*` 脚本 | 97，没有注册清单 | `grep -c '"test:' package.json` |
| Renderer 单元测试文件 | 0 | `find renderer/src -name '*.test.*' \| wc -l` |

## 2. 目标与非目标

目标：

- 用一个脚本统一产出上表全部指标（JSON），作为后续所有 spec 的验收数据来源。
- 用一个基线文件承载棘轮：每个指标声明改善方向，CI 拒绝倒退。
- 在 Linux CI 上运行（指标只做静态统计，不需要 macOS）。

非目标：不在本任务内修复任何指标；不替换现有的 `literal-baseline.json` 机制，而是读取并汇总它。

## 3. 架构决策

| 决策 | 选择 | 备选与理由 |
| --- | --- | --- |
| 指标脚本位置 | `clients/gui/scripts/gui-health.mjs`，纯 Node、零依赖 | 用 oxlint 插件实现：跨文件统计不适合放在 lint 里 |
| 基线文件 | `clients/gui/health-baseline.json`，格式 `{metric: {value, direction: "down"\|"up", owner}}` | 每个指标单独一个文件：分散，难以审阅 |
| 更新方式 | `node scripts/gui-health.mjs --write` 只允许朝改善方向写入；朝倒退方向需要加 `--allow-regression=<metric>`，并且必须在 PR 正文写明理由 | 自由覆盖：棘轮形同虚设 |
| 新文件规则 | 新增源码文件超过 800 行直接失败；存量大文件按棘轮只降不升 | 统一上限：会让存量立刻全部失败 |
| CI 落点 | `gui.yml` 新增 Linux job `gui-health`，路径过滤复用 `scripts/ci-scope.py` | 放进 macOS job：成本高、排队慢 |

## 4. 确定性路径

1. 实现 `gui-health.mjs`，输出第 1 节全部指标，外加：
   - `largeFiles`：超过 1000 行的源码文件及行数（排除 `generated/`、`vendor/`、`i18n/messages/`）。
   - `lintDisables`：`eslint-disable` / `oxlint-disable` 注释数量，防止用注释绕过 L3。
   - `unregisteredTests`：`package.json` 中不在测试清单里的 `test:*`（清单由 E5 引入；E5 落地前此项输出 `null`）。
2. 生成初始 `health-baseline.json`。
3. 实现 `--check`：对比基线，任一指标倒退即退出码非 0，输出"指标、基线值、当前值、方向"。
4. 新增 CI job，并在 [自动化说明](../design-system/automation.md) 和 [GUI 指南](../README.md) 中补充入口。
5. 为脚本本身写 `node --test` 单测：用临时目录夹具覆盖计数、方向判断、`--allow-regression`。

## 5. 不确定性路径

本任务不确定性低，只有一个需要观察的点：

- 假设：基于行数和 grep 的指标足以反映趋势，不会被琐碎改写刷分（比如把代码挤到一行）。
- 证伪观察：格式化工具 `vp fmt` 已强制格式，压行会被 fmt 检查拦下。如果后续发现刷分现象，就改用 AST 统计（比如以函数、组件为单位计数）。

## 6. 实施切片

1. PR-1：脚本 + 单测 + 初始基线（只报告，不阻断）。
2. PR-2：CI job 启用 `--check` 阻断，加上文档入口。

## 7. 验收标准

确定性：

- [ ] `node clients/gui/scripts/gui-health.mjs` 输出 JSON，包含第 1 节全部指标，数值与复现命令一致（误差为 0）。
- [ ] 人为让任一指标倒退（比如在 `App.tsx` 加一行），`--check` 失败，并输出该指标名。
- [ ] 新建一个 801 行的源码文件，`--check` 失败。
- [ ] `gui-health` job 在 Linux 上运行，单次耗时少于 1 分钟。
- [ ] 脚本单测通过。

不确定性：无。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md` 的 GUI 段落加一句：GUI 结构指标由 `health-baseline.json` 棘轮约束，放宽基线必须在 PR 中单独说明 |
| L2 Skill | `.agents/skills/gui-change/SKILL.md` 的收尾步骤：运行 `gui-health.mjs --check`，并在 PR 里贴出指标变化 |
| L3 Lint | 无（跨文件统计不放在 lint 层） |
| L4 CI | `gui-health` job 必跑，失败即阻断合并 |
| L5 棘轮 | 本任务本身 |

## 9. 风险与回滚

- 误报阻断开发：先以只报告模式运行一个 PR 周期，确认无误报后再开启阻断。
- 回滚：删除 CI job 即可，不影响产品代码。
