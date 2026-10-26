# GUI 工程化与设计系统整改 Spec 包

本目录把 GUI Electron 架构与设计系统评估中的 P0/P1 问题拆成可独立交接给编码 Agent（如 Codex）执行的任务 spec。每份 spec 写清当前问题与证据、架构决策、确定性与不确定性两条执行路径、验收标准，以及防止同类问题复发的约束（规则 / Skill / Lint / CI / 指标棘轮）。

本 Spec 包只描述整改目标与约束，不代表已实现能力；实际行为仍以 [GUI 指南](../README.md)、[设计系统](../design-system/README.md) 与 [架构文档](../../../docs/design/architecture.md) 为准。

实施前核查与原 spec 存在差异时，先读取[源码核查与实施决定](implementation-decisions.md)。该记录保留原目标，明确已有机制、错误假设及尚未取得的验收证据。

## 任务索引

| ID | 级别 | 任务 | 依赖 | 主要不确定性 |
| --- | --- | --- | --- | --- |
| [G0](G0-guardrails-and-health-metrics.md) | P0 | GUI 健康指标与棘轮基础设施 | 无 | 低 |
| [E1](E1-macos-launch-without-python.md) | P0 | macOS 启动链去除 `/usr/bin/python3` 硬依赖 | G0 | **高**：依赖的根因未记录 |
| [E2](E2-main-process-typing-and-ipc-contract.md) | P0 | Main 进程类型化与 IPC 契约单一来源 | G0 | 中 |
| [E3](E3-renderer-app-decomposition.md) | P0 | Renderer `App.tsx` 拆分与领域状态层 | G0、E5 第一阶段 | 中高：没有单元测试兜底 |
| [E4](E4-main-responsibility-split.md) | P1 | Main 职责下沉：预览与浏览器自动化拆分 | E2 | 中高 |
| [E5](E5-test-system-and-cross-platform.md) | P1 | GUI 测试分层、注册与跨平台 CI | G0 | 中 |
| [E6](E6-startup-and-bundle-budget.md) | P1 | 启动性能与按需加载预算 | E5 | **高**：缺少基线 |
| [D1](D1-ui-entry-points.md) | P0 | `@areal/ui` 入口分层（拆分 `wip`） | G0 | 低 |
| [D2](D2-design-system-adoption.md) | P0 | 设计系统采用率与包外样式迁移 | D1、D3、E5 第一阶段 | 中：视觉回归 |
| [D3](D3-semantic-tokens-and-literal-debt.md) | P1 | 语义 Token 补齐与字面量债务 | D1 | 中 |
| [D4](D4-accessibility-gate.md) | P1 | 无障碍自动门禁 | E5 第一阶段 | 中 |
| [D5](D5-design-rule-consolidation.md) | P1 | 设计规则来源收敛与文档减重 | D1 | 中：效果需 Agent 实测 |

推荐顺序：G0 → (E1 阶段 0、E2、D1、E5 阶段 1 并行) → D3 → (E3 + D2 按界面联动) → E4、E6、D4、D5。

## 方法：确定性与不确定性两条路径

所有 spec 都把工作拆成两类，执行方式与约束形式不同。

| | 确定性问题 | 不确定性问题 |
| --- | --- | --- |
| 判断标准 | 解法已知；结果可用命令和阈值机械判定 | 根因未知、方案需权衡，或收益要观测才知道 |
| 执行方式 | 直接实施，按切片合并 | 先 spike：写假设、证伪条件、时间盒和停止条件，产出证据与决策记录 |
| 验收形式 | 命令退出码、指标阈值、棘轮不倒退 | 证据报告 + 人工决策点；未达门禁的方案保留为显式候选，不默认启用 |
| 约束落点 | Lint、CI、类型检查、棘轮基线 | Skill（流程）、评审清单、观测指标；只给出趋势，不硬阻断 |
| 演进 | 稳定不变 | **收敛后升级为确定性约束**：spike 得出结论后，把结论写成 lint / CI 规则 |

不确定性路径的硬性要求：

1. 先写假设，不先写实现。每个假设给出能证伪它的观察。
2. Spike 代码不进生产路径；用独立分支或 `scripts/spikes/`，结论写入决策记录后删除。
3. 到达时间盒或停止条件时，提交证据并停下，交由人决策，不自行扩大范围。
4. 保留失败尝试与不利结果，不只报告成功路径。

## 约束层级（防复发）

每份 spec 的"防复发约束"一节都按下面五层给出具体条目。原则是：**能机械判定的放在越下层越好，越下层越难绕过**。

| 层 | 载体 | 适用 | 失效方式 |
| --- | --- | --- | --- |
| L1 规则 | 仓库根 `AGENTS.md`、`clients/gui/AGENTS.md`（按需新增） | 简短、普适、需要判断力的原则 | Agent 或人没有读到 |
| L2 Skill | `.agents/skills/<name>/SKILL.md`（Codex 从 cwd 到仓库根逐级扫描该目录） | 多步流程：开工顺序、spike 模板、验收证据格式 | 没有触发 |
| L3 Lint | `clients/gui/vite.config.mts` 的 lint 规则，通过 `pnpm --dir clients/gui check` 增量执行 | 单文件内能静态判定的模式：禁止导入、禁止字面量、文件长度 | 被 disable 注释绕过，需要 CI 统计 disable 数 |
| L4 CI | `.github/workflows/gui.yml` 中的 job 与脚本 | 跨文件一致性、构建产物、测试注册、平台矩阵 | job 被跳过；用 `ci-scope.py` 保证相关路径必跑 |
| L5 棘轮指标 | `clients/gui/health-baseline.json`（G0 新增） | 存量债务：只允许改善，不允许倒退 | 基线被手动放宽；放宽必须在 PR 中单独说明理由 |

## 根因与护栏总表

这些问题之所以能一路积累，原因可以归为六类。每类根因都对应至少一条确定性护栏，让同类问题无法再悄悄发生。

| 根因 | 表现 | 确定性护栏（L3–L5） | 不确定性护栏（L1–L2） |
| --- | --- | --- | --- |
| 没有尺寸和复杂度上限 | `App.tsx` 5052 行，`preview.cjs` 3863 行 | `max-lines` / `max-lines-per-function`；`largeFiles` 棘轮（G0、E3、E4） | Skill 要求开工先确认状态和职责归属 |
| 类型边界没有覆盖高风险代码 | Main 28080 行无类型，IPC 契约手写 | `typecheck` 覆盖 `app/src`；契约一致性测试；`mainTsCheckedFiles` 棘轮（E2） | `electron-main-change` Skill 的契约先行检查表 |
| 平台假设隐含在代码里 | `/usr/bin/python3`、`/private/tmp` | 禁止平台专属字面量的 lint；宿主依赖清单校验；`hostInterpreterSpawns`、`privateTmpHardcodes` 棘轮（E1、E5） | `spike` Skill：新依赖先查根因、写 ADR |
| 稳定性语义没有落在代码里 | `wip` 同时表示实验品和领域组合 | 入口分层；Base 成员与导出的一致性校验；实验入口名单（D1） | Skill 中的入口选择顺序 |
| 机制被文档代替 | 约 470 KB 设计文档，采用率 30% | 采用率、CSS 行数、字面量棘轮；规则 ID 校验（D2、D3、D5） | 收敛前后的 Agent 对照实验 |
| 测试没有注册和分层 | 97 个散落的 `test:*`，Renderer 没有单测 | 测试清单校验；Linux CI；`unregisteredTests` 必须为 0（E5） | `gui-test` Skill 的分层决策表 |

## 需要新增的 Skill（`.agents/skills/`）

| Skill | 触发场景 | 内容要点 | 来源 spec |
| --- | --- | --- | --- |
| `gui-change` | 修改 `clients/gui` 下的页面、组件、样式、状态 | 状态归属 → 入口选择 → Token 决策顺序 → 新依赖检查 → 验收（`gui-health`、`verify:design`、axe、截图证据） | E3、E6、D1–D5 |
| `electron-main-change` | 修改 `app/src`、preload、IPC 契约 | 契约先行 → 来源校验 → 结构化错误 → 一致性测试 → 是否真的需要 Electron API → UNKNOWN 不重放 | E2、E4 |
| `gui-test` | 新增或修改 GUI 测试 | 分层决策表、临时目录 helper、清单字段、flaky 处理规则（不允许跳过或删除测试） | E5 |
| `spike` | 根因未知或方案需要权衡的任务 | 假设 → 证伪方法 → 时间盒 → 证据记录 → ADR → 停止条件 | E1、E4、E6 |
| `design-system-maintain` | 修改设计系统本身（Token、准入、规则） | 规则 ID 登记、准入流程、归档规则 | D3、D5 |

Skill 只写流程，引用 spec 和规则 ID，不复制规则内容，避免出现新的重复来源。

## 交接给 Codex 的通用约定

- 开工前读 [AGENTS.md](../../../AGENTS.md)、[GUI 指南](../README.md)、[设计系统开工顺序](../design-system/README.md#开工顺序) 和对应 spec 全文。
- 一个切片一个 PR；PR 按 [模板](../../../.github/PULL_REQUEST_TEMPLATE.md) 填写，标题和正文用英文；这些任务不改变 Agent 行为，"Generalization evidence" 一节写明不适用及原因。
- 不改变 Core/Runtime 的执行、历史、UNKNOWN 不重放和收据核对语义；涉及这些边界时停下来询问。
- 用户可见变更按 [完成条件](../design-system/governance.md#完成条件) 提供证据；静态检查通过不等于视觉验收。
- 文档影响在同一 PR 内更新；`docs/` 下的文档需要中英配对，并运行 `python3 scripts/check-docs.py`。
- 如实报告未执行的检查。macOS 专属验证在 Linux 环境中做不了时，明确写出由谁在何处补验。

## 每份 spec 的结构

1. 背景与当前问题（带可复现的证据命令）
2. 目标与非目标
3. 架构决策（已定 / 待 spike 决定）
4. 确定性路径
5. 不确定性路径
6. 实施切片
7. 验收标准
8. 防复发约束（L1–L5）
9. 风险与回滚
