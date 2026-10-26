# E4（P1）：Main 职责下沉：预览与浏览器自动化拆分

## 1. 背景与当前问题

- [preview.cjs](../app/src/core/preview.cjs) 有 3863 行，其中 `class CorePreview`（第 440 行起）约 3400 行，一个类同时承担：
  - 原生页面生命周期（WebContentsView 创建、按项目和 Thread 驻留、释放）
  - 浏览器自动化命令的规划、观察失效、批量执行和超时（`nativeWithin`、`batchWithin`、`invalidateActionObservation`）
  - 人工输入接管与截图隐私守卫（`captureGuardStartScript`、`captureHumanFrames`）
  - 坐标换算、URL 校验、诊断文本脱敏等纯函数
- Main 进程同时还承载 MCP Apps、Gen UI、Worktree、电脑控制、插件认证等职责（`app/src/core` 下共 92 个模块）。Main 出现未捕获异常或长时间阻塞时，所有窗口和 IPC 一起受影响。
- 仓库里已有 `packages/browser-automation`（ZCode 移植），说明"自动化逻辑与 Electron 适配分离"的方向已经存在，只是没有贯彻到 `preview.cjs`。

## 2. 目标与非目标

目标：

- 把必须调用 Electron API 的部分（视图、`webContents`、窗口）与纯逻辑分开；纯逻辑进入可单元测试的模块。
- `preview.cjs` 降到 1200 行以下，`CorePreview` 只做适配和编排。
- 建立 Main 事件循环延迟的观测，用数据决定是否要把部分逻辑移到 `utilityProcess`。

非目标：不改变 Browser 契约（见 [Browser 契约](../../../docs/api/browser.md)）、审批、控制代次和 UNKNOWN 不重放语义；不改变共享登录态的行为。

## 3. 架构决策

| 决策 | 状态 | 选择与理由 |
| --- | --- | --- |
| D1：拆分原则 | 已定 | 按"是否必须接触 Electron API"划分。WebContentsView 只能在 Main 中操作，因此视图生命周期留在 Main；规划、状态机、脱敏、坐标等纯逻辑移出 |
| D2：纯逻辑落点 | 已定 | 放进 `app/src/core/preview/` 子目录下的独立模块（如 `plans.cjs`、`observation.cjs`、`capture-guard.cjs`、`geometry.cjs`、`diagnostics.cjs`）。和上游同步相关的逻辑优先合入 `packages/browser-automation`，与 ZCode 移植来源保持一致 |
| D3：是否使用 `utilityProcess` | **待观测后决定** | 只有当观测数据证明某段逻辑会阻塞 Main（见第 5 节）时，才把它移到 `utilityProcess`。理由：跨进程会增加序列化和生命周期成本，没有数据支持就不做 |
| D4：可观测性 | 已定 | Main 使用 `perf_hooks.monitorEventLoopDelay` 记录事件循环延迟，写入现有诊断（`diagnostics.cjs`）的有界保留；不上报远端 |

## 4. 确定性路径

1. 先为第 1 节列出的纯函数（`webUrl`、`observationUrl`、`bitmapPoint`、`coordinateTarget`、`boundsWithinWindow`、`safeText`、`diagnosticUrl` 等）补单元测试，然后原样移到 `preview/` 子模块。
2. 把截图隐私守卫相关的脚本生成和状态机移进 `capture-guard.cjs`，补测试：守卫开启、序号不匹配、超时。
3. 把规划与观察失效逻辑（`invalidateActionObservation`、`invalidateDocumentPlans`、批量前缀确认）提取为不依赖 Electron 的状态机，`CorePreview` 只负责把 Electron 事件喂进去。
4. 每一步都要求 `test:browser-contracts` 和浏览器相关 smoke 全部通过，行为不变。
5. 加入事件循环延迟监控（D4）。

## 5. 不确定性路径

观测任务：Main 阻塞的真实来源。

- 假设 H1：浏览器自动化里的截图处理、可访问性树序列化、大页面文本提取会让 Main 的事件循环延迟 p99 超过 100ms。
- 方法：用固定夹具页面（大型 DOM、多 iframe）运行一组浏览器自动化命令，同时运行一条流式 Turn，记录事件循环延迟直方图（p50、p99、max）和渲染层输入延迟。
- 证伪条件：p99 低于 50ms，说明不需要 `utilityProcess`，D3 结论记为"不需要"。
- 证实时：识别出最重的 1–2 个操作，只针对它们设计 `utilityProcess` 方案，另开 spec 评审。不在本任务内顺手实施。

产出：在本 spec 下追加观测数据和 D3 结论。

## 6. 实施切片

1. PR-1：纯函数测试和移动。
2. PR-2：截图守卫模块化。
3. PR-3：规划和观察状态机提取。
4. PR-4：事件循环延迟监控和观测报告。
5. PR-5：`preview.cjs` 降到 1200 行以下；更新 [架构文档](../../../docs/design/architecture.md) 中原生预览的描述。

## 7. 验收标准

确定性：

- [ ] `preview.cjs` 不超过 1200 行；`preview/` 下每个模块不超过 600 行。
- [ ] 移出的模块都开启了类型检查（与 [E2](E2-main-process-typing-and-ipc-contract.md) 一致），并有单元测试，能在 Linux 上运行。
- [ ] `test:browser-contracts` 和浏览器相关 smoke 全部通过。
- [ ] 诊断文件中能看到事件循环延迟的统计。

不确定性：

- [ ] 观测报告给出 p50/p99/max 和测量环境；D3 的结论经人确认。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md`：Main 进程模块只做 Electron 适配和编排；新增纯逻辑必须放在可单元测试、不依赖 `electron` 的模块中 |
| L2 Skill | `.agents/skills/electron-main-change/SKILL.md` 增加一步：判断新代码是否真的需要 Electron API，不需要就放到纯模块 |
| L3 Lint | 对 `app/src/core/preview/**` 等纯逻辑目录禁止 `require('electron')`（`no-restricted-imports`）；Main 文件同样适用 `max-lines` 800，存量豁免名单只能缩减 |
| L4 CI | 纯逻辑模块的单测在 Linux job 中运行 |
| L5 棘轮 | `largeFiles`（down）、`mainPureModuleTests`（up） |

## 9. 风险与回滚

- 状态机提取改变了事件时序，导致观察失效判断出错：先写时序测试（录制现有事件序列作为夹具），再提取。
- 回滚：每个 PR 独立；纯函数移动可直接回退。
