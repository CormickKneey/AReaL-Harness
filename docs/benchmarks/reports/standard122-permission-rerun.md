**中文** | [English](standard122-permission-rerun.en.md)

# Standard122 权限修复后复验

PR [#96](https://github.com/areal-project/AReaL-Harness/pull/96) 已合入准入、并发和本地工具修复。Arena 不可变候选的源码为 `0831f3d060ad84cfa8b4e007c4be612c066e1243`，生产路径与合并提交 `e5c07f25b07772bead92fae821d12ac79f776082` 相同，后续提交只修改包布局测试；全部适用合并门禁通过。本报告记录两个模型各 122 题的一次独立运行及其失败重试，只作历史描述性对比，不证明稳定排名或泛化。

## 冻结执行口径

244 个正式 Task 沿用原 Case/Reward 引用及共同原生适配器，每 Job 并发 12。仅 AReaL 重跑，DSH/Codex 使用历史结果。失败重试从 3 次增为 5 次，最多 6 次尝试；DONE 正常零分不重跑。每次尝试仍为 128 次物理模型请求、4,194,304 已知加预留 tokens、131,072 上下文窗口、32,000 单次输出，模型 HTTP 重试策略和任务截止时间不变。失败按零计入固定分母，四领域各 25%，域内逐题等权。

## 平台分数

| 模型 | Harness | 最终分 | 首尝试 | 前四次尝试 | DONE | 正常零分 | 终态失败 | 重试题 | 总尝试 |
|---|---|---|---|---|---|---|---|---|---|
| astra | AReaL final | 80.51% | 78.24% | 79.38% | 122 | 23 | 0 | 3 | 128 |
| astra | areal previous | 72.15% | 61.16% | 72.15% | 120 | 27 | 2 | 19 | 150 |
| astra | dsh previous | 74.68% | 59.63% | 74.68% | 122 | 26 | 0 | 24 | 149 |
| astra | codex previous | 78.04% | 41.32% | 78.04% | 117 | 20 | 5 | 65 | 246 |
| qwen | AReaL final | 72.78% | 61.90% | 71.92% | 114 | 26 | 8 | 24 | 191 |
| qwen | areal previous | 74.05% | 64.16% | 74.05% | 113 | 24 | 9 | 24 | 175 |
| qwen | dsh previous | 79.06% | 64.53% | 79.06% | 108 | 16 | 14 | 35 | 197 |
| qwen | codex previous | 77.31% | 69.69% | 77.31% | 120 | 25 | 2 | 16 | 149 |

首尝试视图将发生失败重试的题按首尝试失败零分计；前四次尝试视图将最终尝试晚于第四次的题按此前四次失败零分计。它们描述已发生的尝试，不模拟旧策略，也不消除路由/负载漂移。终态计数仅对应最终分列。

| 模型 | 比旧 AReaL 变化 | 提高题 | 降低题 | 同分题 | 超过四次尝试题 | 第四次之后贡献 |
|---|---|---|---|---|---|---|
| astra | +8.36 pp | 21 | 4 | 97 | 1 | 1.14 pp |
| qwen | -1.27 pp | 15 | 16 | 91 | 9 | 0.86 pp |

## 四领域拆分

| 模型 | Harness | 软件工程49题 | 浏览器22题 | 文档22题 | 数据29题 |
|---|---|---|---|---|---|
| astra | AReaL final | 63.27% | 69.09% | 99.24% | 90.46% |
| astra | areal previous | 59.18% | 65.45% | 80.30% | 83.68% |
| astra | dsh previous | 65.31% | 65.80% | 81.97% | 85.63% |
| astra | codex previous | 65.31% | 68.18% | 87.42% | 91.26% |
| qwen | AReaL final | 61.22% | 75.45% | 79.39% | 75.06% |
| qwen | areal previous | 57.14% | 82.73% | 72.88% | 83.45% |
| qwen | dsh previous | 57.14% | 80.00% | 98.18% | 80.92% |
| qwen | codex previous | 57.14% | 77.27% | 82.88% | 91.95% |

## 机制验收

本地 macOS 子任务原本可以创建，Git 工具链发现和 Bash 3.2 here-document 临时文件兼容是独立的运行缺陷。最终实现保留原生只读边界，固定可信 Git 资源，并分发带完整对应源码的 Bash 5.3.20；Git/源码写入、越界与网络负例仍按权限模式执行。硬编码 `/bin/bash` 仍是系统 shell。原生权限、取消/重启、真实协作、GUI、搬迁发行包及安装/升级验证通过，详见[设计与验证报告](inspection-permissions-v2.md)。

Arena 保持默认强制只读。Runtime 报告有效受限 Scope 是否确实可执行，Core 收窄不可用委派，并在子模型工作前再次核对显式创建请求。没有启用默认扩权。隐藏工具不等于远端容器已具备沙箱能力；未启动子任务时，子任务成功率不适用。

| 模型 | 可核验最终状态/题 | 缺失 | 受限能力不可用 | 启动子线程 | 子线程失败 | 中断 | 未结算 | uid-map错误回执 |
|---|---|---|---|---|---|---|---|---|
| astra | 122/122 | 0 | 122 | 0 | 0 | 0 | 0 | 0 |
| qwen | 122/122 | 0 | 122 | 0 | 0 | 0 | 0 | 0 |

原 Astra 的 122 题全部创建子任务：134 个子线程、132 个失败，121 题有 uid-map 错误。本轮检验的是能力准入，不能据此声称模型在能力可用时已更善于判断委派。每父会话创建锁、探针后额度复查、显式继承候选和写租约由机制回归覆盖。模型继续负责是否拆解，Core 不按题号派发，也无子任务配额目标。DSH/Codex 对照与权限保证见[准入报告](delegation-admission-repair.md)。

## 成本与证据缺口

八个最终失败均为 Qwen：两个单次输出长度上限、四个本地根预算拒绝、两个原生超时。这是观察到的终端条件，不是单变量根因归属；这些题均未启动子任务。累积回执中的预算标记不能代替当前尝试的时间归属证据。

| 模型 | 题目 | 尝试 | 观察到的终端停止 |
|---|---|---|---|
| qwen | tb2-adaptive-rejection-sampler | 6 | output_length_limit |
| qwen | tb2-mailman | 6 | root_budget_rejected |
| qwen | tb2-make-mips-interpreter | 6 | native_timeout |
| qwen | tb2-schemelike-metacircular-eval | 6 | output_length_limit |
| qwen | bx-browser-priority | 6 | native_timeout |
| qwen | bx-browser-dependencies | 6 | root_budget_rejected |
| qwen | bx-browser-subtasks | 6 | root_budget_rejected |
| qwen | bx-browser-import | 6 | root_budget_rejected |

| 模型 | 尝试 | 已知请求下界 | 已知token下界 | 用量不完整题 |
|---|---|---|---|---|
| astra | 128 | 2674 | 70929417 | 8 |
| qwen | 191 | 7065 | 246990046 | 24 |

已核验请求按记录去重并归入唯一的平台尝试时间区间。最终日志可能包含早期重试，不能直接逐回执累加；恢复早期请求不补齐缺失原生状态。预算核对未在可核验记录中发现超限，覆盖未知仍单列。历史下载可能把最终字节返回给早期尝试，原数据与最多一次只读补取均保留，不宣称全量历史字节或完整消费已知；无价表时 USD 未知。

| 候选资格 | 题数 | 已知token下界 | 计入正式分 |
|---|---|---|---|
| v1 | 2 | 550144 | 否 |
| v2 | 2 | 946607 | 否 |

V1 因 TLS 依赖和持久身份边界修正而退役，两个资格结果保留；V2 重新资格核验，得分不作为门禁。共同工作区还观察到独立的原子写兼容现象：nobody 所有的 sticky 目录、丢弃 capabilities 的 uid0、条件替换 EPERM，但 shell 覆盖成功；它符合 [Linux rename 的 sticky 目录限制](https://man7.org/linux/man-pages/man2/rename.2.html)，但未捕获该次失败 syscall。没有为跑分增加 CAP_FOWNER、移除 sticky 位或静默降级非原子写入；该题也存在功能/自检错误，不能把零分单归因于权限。

## 解释范围与证据

题目已用于开发，每个模型题目只有一次独立样本，重试不构成独立重复。本轮只跑 AReaL，历史同时有三 Harness；即使单 Job 并发相同，网关竞争仍不同。历史模型别名不固定真实路由/权重身份，主线也包含权限修复之外的变更。因此不能作单变量归因或晋级默认策略；平台自动分也不等于独立语义/视觉验收。正式优越性仍须[方法规定](../methodology.md)的独立重复与来源隔离确认。

两个模型的路由配置指纹在本轮前后及历史 r3p12 准入快照中一致；实际权重字节不可取得，没有证据将本轮分差归因于路由变化。

[可校验 JSON](standard122-permission-rerun.json) 保留精确分数、逐题提高/降低、源码/包绑定及审计边界。仓库不公开完整原始轨迹；私有归档为 `AReaL-Harness-Standard122-v1.0/04_质量审计与复验证据/finalization-arena-v1/candidate-v2`，原失败、UNKNOWN 和额外资格开销均保留。

Harness: `standard102-native-areal@1.1.0-5a8b6d192fe5`; SHA-256: `da6effdb801aad675e6baa50458c1edacb9e902db396373596ee7e5888833897`.

收尾的实时GUI依赖审计还要求将Vite固定为7.3.7、MCP client/core固定为2.3.0，依据为[MCP公告](https://github.com/advisories/GHSA-6prh-2h8m-c8cw)及[Vite公告](https://github.com/advisories/GHSA-587h-7wmj-h5pm)。Core/Runtime源码输入哈希保持`46659ac6a0834207e30437023ddba531b55671a7351ae08ba305824aa309ce44`，Arena不可变运行包未改动。GUI审计、类型、正式构建及109项公共验证通过，3项原配置跳过。这项后续修复仅变更GUI依赖，没有替换Solver或重选Benchmark样本。

### Arena Jobs

- [astra / swe24](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-swe24-2610210432)
- [astra / terminal12](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-terminal12-2610210432)
- [astra / transfer8](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-transfer8-2610210433)
- [astra / files41](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-files41-2610210433)
- [astra / browser17](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-browser17-2610210433)
- [astra / workday20-browser5](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-workday20-browser5-2610210433)
- [astra / workday20-files14](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-workday20-files14-2610210433)
- [astra / workday20-script-object1](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-workday20-script-object1-2610210433)
- [qwen / swe24](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-swe24-2610210433)
- [qwen / terminal12](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-terminal12-2610210433)
- [qwen / transfer8](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-transfer8-2610210433)
- [qwen / files41](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-files41-2610210433)
- [qwen / browser17](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-browser17-2610210433)
- [qwen / workday20-browser5](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-workday20-browser5-2610210433)
- [qwen / workday20-files14](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-workday20-files14-2610210433)
- [qwen / workday20-script-object1](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-workday20-script-object1-2610210433)
