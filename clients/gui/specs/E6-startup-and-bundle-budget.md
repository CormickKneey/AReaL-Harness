# E6（P1）：启动性能与按需加载预算

## 1. 背景与当前问题

- Renderer 的依赖里有多个重量级库：`shiki`、`@streamdown/mermaid`、`katex`、`@codemirror/*`、`@xterm/xterm`、`lexical`、`@pierre/diffs`、`@modelcontextprotocol/*`（见 [renderer/package.json](../renderer/package.json)）。
- 目前没有包体积预算，也没有看到首屏加载这些库的按需策略（这是推断，需要用构建产物分析确认）。
- 仓库已有 `test:startup`（[startup-timing-smoke.mjs](../scripts/startup-timing-smoke.mjs)）测量冷启动，但它没有接入 CI，也没有阈值。
- 这里最大的不确定性是**没有基线**：不知道当前首包有多大、冷启动要多久、哪些库在首屏加载。

## 2. 目标与非目标

目标：

- 建立可重复的启动和包体积基线。
- 首屏不加载、首次交互才需要的库改为按需加载。
- 用预算防止倒退。

非目标：不更换 Markdown、编辑器、终端等核心库；不改变 GUI 首次展示和后台就绪的判定逻辑（见 [架构文档](../../../docs/design/architecture.md) 的"状态与执行"一节）。

## 3. 架构决策

| 决策 | 状态 | 选择与理由 |
| --- | --- | --- |
| D1：先测量后优化 | 已定 | 第一个 PR 只做测量，不做优化 |
| D2：按需加载候选 | 已定（具体名单待测量确认） | mermaid、katex、shiki 的语言包、xterm、CodeMirror、diff viewer，统一改为首次使用时 `import()`，配合 Suspense 和已有的加载状态组件 |
| D3：预算形式 | 已定 | `clients/gui/bundle-budget.json`：初始 chunk 大小、总 JS 大小、每个懒加载 chunk 的上限；构建后脚本对比并阻断超预算 |
| D4：预算数值 | **待测量后决定** | 在基线基础上设定，第一版预算 = 优化后的实测值 + 5% 容差 |

## 4. 确定性路径

1. 构建后生成产物分析（chunk 列表、大小、每个 chunk 包含的模块），保存为 CI 构件。
2. 实现 `scripts/bundle-budget.mjs`：读取构建产物，对比 `bundle-budget.json`。
3. 按 D2 名单逐个改成按需加载；每改一个库，记录初始 chunk 大小的变化。
4. 预算检查接入 GUI CI（构建本来就在 macOS job 中进行；如果 E5 的 Linux job 能构建 renderer，就放到 Linux）。

## 5. 不确定性路径

| 未知项 | 方法 | 判定 |
| --- | --- | --- |
| 当前冷启动耗时和波动 | 在固定机型上用 `test:startup`（`AREAL_STARTUP_ROUNDS=10`）测量，记录 p50/p90 和测量环境 | 作为基线；CI 机器上的测量只用于看趋势，不作为硬门禁（波动太大） |
| 首屏到底加载了哪些重库 | 产物分析 + 启动时的网络和模块加载记录 | 只有确实在首屏加载的库才进入按需改造名单 |
| 按需加载对体验的影响 | 首次打开含 mermaid 或代码块的消息时的延迟 | 首次渲染延迟超过 300ms 时，考虑空闲时预加载（`requestIdleCallback`） |

停止条件：如果测量发现首屏 JS 已经很小（比如初始 chunk 低于 1 MB）、冷启动的主要耗时在 Core 连接和恢复而不是 Renderer，就停止 Renderer 侧的优化，提交报告，转而建议优化启动恢复链（另开 spec）。

## 6. 实施切片

1. PR-1：产物分析和基线报告（只测量）。
2. PR-2：预算脚本，用当前值作为初始预算（防倒退）。
3. PR-3 起：逐个库改为按需加载，每个 PR 收紧一次预算。

## 7. 验收标准

确定性：

- [ ] 构建产物分析作为 CI 构件可以下载。
- [ ] 超出预算时，预算检查失败并输出超标的 chunk。
- [ ] 按需加载的库不出现在初始 chunk 中（脚本可以校验）。
- [ ] 相关 smoke（消息渲染、终端、文件预览、diff）全部通过。

不确定性：

- [ ] 固定机型上的冷启动 p50/p90 前后对比报告；改善目标在基线确定后由人设定。
- [ ] 首次打开重内容的人工体验复核（加载状态显示正确，没有布局跳动）。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md`：新增体积超过 100 KB（gzip 后）的 Renderer 依赖时，必须说明是否在首屏加载，并默认按需加载 |
| L2 Skill | `.agents/skills/gui-change/SKILL.md`：新增依赖的检查步骤（体积、许可证、是否按需） |
| L3 Lint | 对 D2 名单中的库禁止静态 `import`，只允许 `import()`（`no-restricted-imports`，仅限 `renderer/src`，懒加载封装模块除外） |
| L4 CI | 预算检查必跑；产物分析作为构件保留 |
| L5 棘轮 | `bundle-budget.json` 本身就是棘轮：数值只能收紧，放宽需要在 PR 中说明 |

## 9. 风险与回滚

- 按需加载导致首次使用时闪烁或报错：每个库的懒加载封装都要处理加载失败（展示原文或降级视图）。
- 回滚：每个库的改造独立，可以单独回退，同时放宽对应预算。
