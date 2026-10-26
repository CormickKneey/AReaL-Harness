# E2（P0）：Main 进程类型化与 IPC 契约单一来源

## 1. 背景与当前问题

- Main 进程（`app/src`，不含 `vendor`）有 99 个文件、28080 行，全是 `.cjs` / `.js`。没有任何文件开启 `@ts-check`，也没有 `tsconfig` 用 `checkJs` 覆盖它们（仓库内的 tsconfig 只覆盖 `renderer` 和若干 `packages`）。
- 这部分代码承担的正是风险最高的职责：IPC 来源校验（[main.cjs](../app/src/core/main.cjs) 第 262 行附近的 `senderFrame` 和 `areal-ui://` 校验）、生命周期与换代、`submission-recovery.cjs` 的收据核对、Remote Gateway、插件认证。
- IPC 契约 [desktop-contract.cjs](../packages/workbench/client/desktop-contract.cjs) 有 1628 行，是手写的校验器（`validateCommand`、`validateCommandResponse` 等）；Renderer 侧只能通过同目录 `.js` 薄壳的 JSDoc typedef 间接引用它的类型。契约变更没有编译期保护。

后果：重命名字段、改返回结构、漏处理错误分支，都只能靠 smoke 测试在运行时发现，而这些 smoke 大多只在 macOS CI 上跑。

## 2. 目标与非目标

目标：

- Main 全部模块纳入 TypeScript 类型检查（`checkJs`），按风险顺序推进，棘轮只增不减。
- IPC 契约成为唯一的类型来源：Renderer、preload、Main 三方从同一份定义推导类型，契约变更会在编译期暴露所有受影响的调用点。

非目标：本任务不把 `.cjs` 改写成 `.ts`、不引入 Main 的构建步骤；不改变 IPC 的通道数量和语义。

## 3. 架构决策

| 决策 | 状态 | 选择与理由 |
| --- | --- | --- |
| D1：类型化方式 | 已定 | `checkJs` + JSDoc，保持 Electron 直接加载 `.cjs`。备选"改写成 TS 再加构建步骤"会改变打包、源码映射和崩溃栈，收益相同但风险高，以后可以单独评估 |
| D2：推进方式 | 已定 | 新增 `app/tsconfig.json`（`allowJs`、`checkJs: false`、`noEmit`、`strict`），按文件用 `// @ts-check` 逐个开启；开启名单作为棘轮。全部开启后改为 `checkJs: true`，并删除逐文件注释 |
| D3：推进顺序 | 已定 | ① IPC 边界：`preload.cjs`、`main.cjs` 的 handler 注册与来源校验；② 恢复与生命周期：`submission-recovery.cjs`、`lifecycle*.cjs`、`project-connections.cjs`、`history-observation.cjs`；③ Remote：`remote-*.cjs`；④ 其余模块 |
| D4：契约类型来源 | **待 spike 后决定** | 候选 A：保留手写校验器，用 JSDoc 为每个命令写出 `@typedef`，用 `tsc --declaration --emitDeclarationOnly` 生成 `.d.ts` 给 Renderer 使用。候选 B：把命令定义改写成 schema（zod 已是 renderer 依赖），由 schema 同时推导类型和校验器。偏向 A（改动小、不在 Main 新增依赖）；只有当 A 写出来的类型无法和校验逻辑保持一致时才选 B |
| D5：契约一致性 | 已定 | 不论选 A 还是 B，都要有一个测试保证"类型声明里的命令集合 = 校验器里的命令集合 = Main 注册的 handler 集合 = Rust `desktop_registered_methods_have_dispatch_routes` 覆盖的集合" |

## 4. 确定性路径

1. 新增 `app/tsconfig.json`，并加入 `pnpm --dir clients/gui typecheck`（`types-suite`）。
2. 为 Electron、Node 类型配置 `types`，确认空跑通过。
3. 按 D3 的顺序逐批开启 `@ts-check`，每批一个 PR，修复类型错误。规则：
   - 只能补 JSDoc 类型或修正真实缺陷，不能改变行为。
   - 不允许 `@ts-ignore`；必要时用 `@ts-expect-error` 并写明原因，数量计入 G0 指标。
   - 修复中发现的真实缺陷单独列在 PR 正文里，并补回归测试。
4. 实现 D5 的一致性测试（`node --test`），加入 `test:regressions`。

## 5. 不确定性路径

Spike（时间盒 2 个工作日）：契约类型的可表达性。

- 假设 H1：手写校验器的结构足够规整，可以用 JSDoc 为每个命令写出精确的请求和响应类型，而且不会和校验逻辑漂移。
- 验证方法：选 5 个最复杂的命令（包含联合类型、可选字段、错误分支），用候选 A 写出类型，再写一个类型级测试（`tsd` 风格，或 `// @ts-expect-error` 断言）检查错误输入会被拒绝。
- 证伪条件：同一个命令需要在类型和校验器两处各写一遍、手工保持同步，并且没有办法用测试捕获漂移，这时转向候选 B。
- 产出：在本 spec 下追加 spike 结论（选定方案、样例、被否决方案的原因）。

需要观察的风险：开启类型检查后暴露出大量存量问题，导致单批 PR 过大。应对：把批次切得更细（单个文件），并允许先用 `@ts-expect-error` 标注存量问题，进入棘轮跟踪。

## 6. 实施切片

1. PR-1：`app/tsconfig.json`、typecheck 接入、G0 指标 `mainTsCheckedFiles`。
2. PR-2：spike 结论和 5 个样例命令的契约类型。
3. PR-3：契约全量类型化，生成 `.d.ts`，Renderer 改为从生成的类型导入；一致性测试。
4. PR-4…N：按 D3 顺序逐批开启 `@ts-check`。
5. 最后一个 PR：切换为 `checkJs: true`，删除逐文件注释。

## 7. 验收标准

确定性：

- [ ] `pnpm --dir clients/gui typecheck` 覆盖 `app/src` 并通过。
- [ ] `mainTsCheckedFiles` 最终等于 Main 文件总数（不含 `vendor`）；中间每个 PR 只增不减。
- [ ] `@ts-ignore` 数量为 0；`@ts-expect-error` 数量在 G0 中跟踪，且最终降到 0。
- [ ] 一致性测试通过：故意在校验器里删掉一个命令，或在 Main 里多注册一个 handler，测试都会失败。
- [ ] 故意修改契约里某个响应字段的名字，Renderer 的 typecheck 失败。
- [ ] 现有 GUI CI（macOS job）全部通过，行为无变化。

不确定性：

- [ ] spike 结论经人确认后再进入 PR-3。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md`：Main 进程新增或修改的模块必须通过类型检查；IPC 命令的增删只能修改契约这一处来源 |
| L2 Skill | `.agents/skills/electron-main-change/SKILL.md`：修改 Main 或 IPC 时的检查表：契约先行 → 来源校验（`senderFrame`、URL 前缀）→ 结构化错误 → 一致性测试 → UNKNOWN 不重放 |
| L3 Lint | 禁止 `@ts-ignore`（`ban-ts-comment`）；在 `renderer/src` 中禁止直接访问 `window.<bridge>`（已有约定：只有 `main.tsx` 可以读取 preload 对象），用 `no-restricted-globals` / `no-restricted-properties` 固化 |
| L4 CI | `typecheck` 必跑；契约一致性测试进入 Linux 可运行的 `test:regressions` |
| L5 棘轮 | `mainTsCheckedFiles`（up）、`tsExpectErrors`（down） |

## 9. 风险与回滚

- 修类型时顺手改了行为：PR 规则要求行为变更单独列出并附测试；评审时重点看非注释的 diff。
- 回滚：类型检查只影响开发期，回滚单个 PR 即可，不影响产物。
