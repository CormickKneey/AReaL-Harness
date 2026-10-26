# E3（P0）：Renderer `App.tsx` 拆分与领域状态层

## 1. 背景与当前问题

- [App.tsx](../renderer/src/App.tsx) 有 5052 行。其中 `AppContent`（第 461 行起）是一个约 4600 行的单一组件，含 47 个 `useState`，hook 调用总计 132 次。
- 状态混在一起，跨越多个互不相关的领域：
  - 启动与后台：`themeReady`、`shellReady`、`initialPresentation`、`startupDelayed`、`restoration`、`backendActionPending`、`quitProgress`
  - 项目与会话：`selectedProject`、`projectId`、`threadId`、`workspaceHistory`、`archived`、`rename`、`forkIntent`
  - 面板与工作区：`panel`、`panelTabs`、`previewFileTab`、`workspaceView`、`filesOpen`、`dirtyFiles`、`terminalOpen`
  - 任务与插件：`taskSurface`、`taskScope`、`taskNotification`、`pluginsOpen`、`pluginMarketRequest`
  - 外观与布局：`dark`、`theme`、`uiFontSize`、`sidebar`、`sidebarWidth`、`collapsedProjects`
  - 通知：`notices`、`dismissedNotices`、`trajectoryAttention`
- Renderer 没有任何单元测试文件，回归全部靠 Electron 端到端 smoke。
- 后果：任何 GUI 改动都容易碰到这个文件，冲突多；任意一个状态变化都可能触发整棵树重渲染；代码评审无法聚焦。

## 2. 目标与非目标

目标：

- `App.tsx` 只保留装配：Provider、顶层布局、路由。最终不超过 800 行。
- 状态按领域拆进独立 store，组件按需订阅。
- 拆分过程中补齐领域 store 的单元测试。

非目标：不改变任何用户可见行为和视觉；不改变 Desktop 投影协议（`state-projection`）和 Core 交互语义；不在本任务内迁移样式（样式迁移见 [D2](D2-design-system-adoption.md)，但两者可以按界面联动推进）。

## 3. 架构决策

| 决策 | 状态 | 选择与理由 |
| --- | --- | --- |
| D1：状态层实现 | 已定 | 基于 React 内置 `useSyncExternalStore` 的轻量领域 store（每个领域一个模块，暴露 `getSnapshot`、`subscribe`、命令函数和 selector hook）。不引入新状态库：Desktop 投影本来就是外部数据源，`ProjectionReader` 天然适合作为外部 store；也避免新依赖带来的评审和许可证成本 |
| D2：领域边界 | 已定 | 按第 1 节的六个领域拆：`startup`、`navigation`（项目和会话选择）、`workspace`（面板、标签、文件）、`tasks`、`appearance`、`notices`。插件和搜索这类短生命周期的 UI 状态，放回对应组件内部 |
| D3：权威边界不变 | 已定 | store 只保存 UI 状态和投影缓存；执行、历史、收据仍由 Core/Desktop 持有。store 里不能出现"重发请求"的逻辑；UNKNOWN 核对继续走原有控制器 |
| D4：拆分顺序 | 已定 | 先拆依赖最少、行为最容易验证的：`appearance` → `notices` → `startup` → `workspace` → `tasks` → `navigation`（最复杂，最后拆） |
| D5：持久化 | 已定 | 现有的偏好持久化（application preferences、localStorage）保持原位置和键名，store 只是包装原有读写 |

## 4. 确定性路径

1. **先建立特征测试网**（依赖 [E5](E5-test-system-and-cross-platform.md) 阶段 1 提供的单元测试 runner）：
   - 为每个即将拆出的领域，先写针对当前行为的测试，比如外观偏好的读写和默认值、通知去重和关闭规则。
   - 列出受影响的现有 smoke（例如 `test:startup`、`test:lifecycle`、`test:history-navigation-ui`、`test:composer`），作为每个 PR 的必跑集合。
2. 每个领域一个 PR：
   - 新建 `renderer/src/state/<domain>.ts`（store）和 `renderer/src/state/<domain>.test.ts`。
   - 把 `AppContent` 里对应的 `useState` / `useEffect` 迁过去；子组件通过 selector hook 订阅，不再层层传 props。
   - 被拆出的视图块（比如侧栏、面板容器）同时移到独立组件文件。
3. 每个 PR 在正文中给出 `App.tsx` 的行数和 hook 数变化（G0 指标）。

## 5. 不确定性路径

| 风险点 | 假设 | 观察方法 | 处置 |
| --- | --- | --- | --- |
| 隐性耦合 | 某些 `useEffect` 依赖多个领域的状态，拆分后时序会变（例如恢复完成后才挂载工作台） | 拆分前先给每个跨领域 effect 画依赖表（读哪些状态、写哪些状态），写进 PR 正文 | 跨领域 effect 先留在 `App.tsx`，作为"编排层"单独标注，最后统一处理 |
| 渲染性能 | 选择性订阅会减少流式输出时的重渲染 | 用 React Profiler 记录"一次流式 Turn（固定夹具，约 200 个增量）"期间的 commit 次数和总耗时，拆分前后各测一次 | 如果没有改善甚至变差，检查 selector 的引用稳定性；性能数据只作为观察项，不作为合并门禁 |
| 行为回归 | 没有单测时，端到端 smoke 可能漏掉边缘状态（窄窗、恢复失败、退出确认） | 拆分 `startup` 和 `navigation` 时，人工对照 [GUI 指南](../README.md) 的生命周期章节逐项验证 | 发现回归就补测试，再修复 |

停止条件：某个领域拆分后，必跑 smoke 连续两次以无法解释的方式失败，就停下来提交依赖分析，交由人判断领域边界是否要调整。

## 6. 实施切片

1. PR-0：依赖 E5 阶段 1（单元测试 runner 可用）。
2. PR-1 至 PR-6：按 D4 顺序每个领域一个 PR。
3. PR-7：处理剩余的跨领域编排，`App.tsx` 降到 800 行以下；更新 [架构文档](../../../docs/design/architecture.md) 中 Renderer 状态的描述。

## 7. 验收标准

确定性：

- [ ] `App.tsx` 不超过 800 行；单个组件函数不超过 300 行。
- [ ] `App.tsx` 中的 `useState` 不超过 5 个。
- [ ] 每个领域 store 都有单元测试，覆盖默认值、命令和持久化读写。
- [ ] 第 4 节列出的必跑 smoke 全部通过；`typecheck` 通过。
- [ ] 渲染层对 bridge 的访问仍然只在 `main.tsx`（E2 的 lint 规则通过）。

不确定性：

- [ ] 流式 Turn 的 Profiler 数据（拆分前后）写进最后一个 PR，供人判断性能是否达到预期。
- [ ] 窄窗、深浅主题、UI 字号、恢复失败、退出确认等状态经过人工视觉复核，证据按 [完成条件](../design-system/governance.md#完成条件) 提交。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md` 的 GUI 段落：新增全局 UI 状态必须进入对应领域 store，不允许在 `App.tsx` 中新增 `useState` |
| L2 Skill | `.agents/skills/gui-change/SKILL.md`：开工时先确认状态归属（哪个领域 store、Core 还是组件本地）；附领域边界表 |
| L3 Lint | 对 `renderer/src/**` 启用 `max-lines`（800，跳过空行和注释）和 `max-lines-per-function`（300）；存量超标文件进入豁免名单，名单只能缩减 |
| L4 CI | `gui-health` 检查 `App.tsx` 行数和 hook 数的棘轮；单元测试在 Linux 上运行 |
| L5 棘轮 | `appTsxLines`（down）、`appTsxHooks`（down）、`rendererUnitTestFiles`（up）、`largeFiles`（down） |

## 9. 风险与回滚

- 拆分 PR 容易和其他功能 PR 冲突：每个领域 PR 控制在 1–2 天内合并，开工前在 PR 列表里公告正在拆的领域。
- 回滚：每个领域 PR 独立，可以单独回退。
