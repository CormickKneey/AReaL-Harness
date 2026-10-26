# E5（P1）：GUI 测试分层、注册与跨平台 CI

## 1. 背景与当前问题

- `clients/gui/package.json` 有 97 个 `test:*` 脚本，每个都是独立的 Node 脚本或 `node --test` 调用。没有统一 runner，没有分层，也没有清单说明每个测试测什么、能在哪个平台跑。
- 104 个测试脚本硬编码了 macOS 专属的 `/private/tmp`（例如 `scripts/architecture-smoke.mjs`、`scripts/startup-timing-smoke.mjs` 里的 `mkdtemp('/private/tmp/...')`），在 Linux 上直接失败。
- Renderer 没有单元测试文件（`find renderer/src -name '*.test.*'` 为 0）。
- [gui.yml](../../../.github/workflows/gui.yml) 的 GUI 构建和契约检查只在 `macos-15` 上运行。Linux 上 Core 已经可以用，但 GUI 完全没有在 Linux 上验证过。
- 后果：macOS runner 成本高、排队慢；没有分层就无法"改什么跑什么"；后续 E3、D2 这类大规模重构缺少快速回归网。

## 2. 目标与非目标

目标：

- 三层测试：单元（毫秒级、无 Electron）、契约（Node 级、无 GUI）、端到端（Electron + Playwright）。
- 所有测试登记到清单，声明层级、平台和覆盖领域；CI 按清单选择要跑的测试。
- 测试脚本在平台无关的前提下可移植；Linux CI 跑单元、契约和一组核心旅程的端到端 smoke（xvfb）。

非目标：不重写现有 smoke 的断言逻辑；不追求 Linux GUI 的发行（Linux 包发布另行决定）。

## 3. 架构决策

| 决策 | 状态 | 选择与理由 |
| --- | --- | --- |
| D1：单元测试 runner | 已定 | Renderer 和 `packages/*` 使用 vite-plus 自带的测试命令（Vitest 兼容，与现有 `vp` 工具链一致）；如果当前 vite-plus 版本不提供，就直接用 Vitest。Main 的 `.cjs` 纯模块继续用 `node --test` |
| D2：测试清单 | 已定 | 新增 `clients/gui/scripts/test-manifest.json`，每项包含 `script`、`layer`（unit/contract/e2e）、`platforms`（darwin/linux）、`areas`（如 lifecycle、composer、browser）、`requires`（如 core-binary、native-helper）。`package.json` 里的 `test:*` 必须全部出现在清单中 |
| D3：临时目录 | 已定 | 新增共享 helper `scripts/support/temp.mjs`，统一用 `os.tmpdir()` 加 `realpath`（macOS 上 `/var/folders` 是 `/private/var/folders` 的软链接，必须 realpath，以免路径比较失败）。只有确实依赖 `/private/tmp` 语义的测试才保留，并在清单里标记为 darwin 专属 |
| D4：CI 选择 | 已定 | 在 `scripts/ci-scope.py` 的路径过滤基础上，按 `areas` 选择端到端 smoke；单元和契约全量运行 |
| D5：Linux 端到端范围 | **待验证** | 先挑 5 条核心旅程：启动和恢复、发送消息与流式输出、停止 Turn、设置页、退出时保留草稿。能否在 Linux（xvfb）稳定运行需要实测 |

## 4. 确定性路径

1. 实现 `temp.mjs`，批量替换 104 处 `/private/tmp`。每批 PR 跑一遍 macOS CI，确认没有回归。
2. 建立测试清单，补齐 97 个脚本的元数据；写一个校验脚本：`package.json` 的 `test:*` 集合必须等于清单集合，平台和层级字段合法。
3. 接入单元测试 runner，在 `renderer` 和 `packages/ui` 各写一个示例测试，作为 [E3](E3-renderer-app-decomposition.md) 和 [D2](D2-design-system-adoption.md) 的基础。
4. `gui.yml` 新增 Linux job：单元测试、契约测试、清单校验、`gui-health`（来自 [G0](G0-guardrails-and-health-metrics.md)）。
5. 更新 [测试文档](../../../docs/development/testing.md)（中英配对）和 [GUI 指南](../README.md) 的测试章节。

## 5. 不确定性路径

| 未知项 | 假设 | 验证方法 | 处置 |
| --- | --- | --- | --- |
| Linux 端到端可行性 | 核心旅程不依赖 macOS 专属能力，可以在 Ubuntu + xvfb 上稳定运行 | 5 条旅程各在 Linux CI 上连续跑 10 次，记录通过率 | 通过率 ≥ 95% 的进入必跑集；不达标的写清原因（平台依赖或 flake），保留在 macOS |
| flake 基线 | 现有 smoke 存在一定比例的不稳定 | 对 macOS 上的端到端 smoke 各重复 5 次，记录通过率 | 低于 95% 的测试标记 `flaky: true`，单独建清单跟踪；不允许跳过或删除测试来提高通过率 |
| 平台专属测试的识别 | 部分测试依赖原生 helper、DMG、Seatbelt | 逐个检查 `requires` 字段 | 标记为 darwin 专属，并写明原因 |

## 6. 实施切片

1. PR-1：`temp.mjs` 和第一批替换（阶段 1，E3 和 D2 依赖这一阶段）。
2. PR-2：单元测试 runner 接入和示例测试（阶段 1）。
3. PR-3：测试清单和校验脚本。
4. PR-4：剩余的 `/private/tmp` 替换。
5. PR-5：Linux CI job（单元、契约、清单）。
6. PR-6：Linux 端到端可行性报告，以及达标旅程进入必跑集。

## 7. 验收标准

确定性：

- [ ] 平台无关的测试脚本中 `/private/tmp` 出现次数为 0；剩余出现都在清单标记为 darwin 专属的测试里。
- [ ] 清单校验通过：`package.json` 的 `test:*` 与清单一一对应。
- [ ] Renderer 和 `packages/ui` 的单元测试可以通过一条命令运行，并在 Linux CI 中执行。
- [ ] Linux job 单次耗时少于 10 分钟。
- [ ] macOS 上现有的 GUI CI 全部通过。

不确定性：

- [ ] Linux 端到端可行性报告（每条旅程 10 次的通过率）和 flake 基线报告经人确认。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md`：新增测试必须登记到测试清单，并声明层级和平台；测试代码不得硬编码平台专属路径 |
| L2 Skill | `.agents/skills/gui-test/SKILL.md`：选择测试层级的决策表（纯逻辑 → 单元；IPC 或协议 → 契约；跨进程用户旅程 → 端到端），附 helper 用法和清单字段说明 |
| L3 Lint | 在 `scripts/**` 中禁止字符串字面量 `/private/tmp`、`/var/folders`（darwin 专属测试用 `oxlint-disable-next-line` 并写明原因，数量计入 G0） |
| L4 CI | 清单校验和 Linux job 必跑；新增的 `test:*` 如果没有登记，清单校验失败 |
| L5 棘轮 | `privateTmpHardcodes`（down）、`unregisteredTests`（必须为 0）、`rendererUnitTestFiles`（up）、`flakyTests`（down） |

## 9. 风险与回滚

- 替换临时目录后，某些依赖 realpath 的路径比较出错：helper 统一做 realpath，并为 helper 本身写测试。
- Linux 端到端不稳定拖慢 CI：不达标的旅程不进入必跑集。
