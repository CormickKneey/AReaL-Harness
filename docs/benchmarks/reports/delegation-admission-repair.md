**中文** | [English](delegation-admission-repair.en.md)

# 委派准入、并发和权限修复

本报告记录 [Standard122 差距分析](standard122-execution-gap.md) 后的确定性契约修复与上游实现对照。原始分数、失败和预算记录保留；没有重跑该矩阵，也没有据此声明整体 Agent 能力提升。

## 问题类别与证据

全量 244 份 AReaL 最终原生状态显示：Astra 的 122 题全部创建子任务，共 134 个子线程、132 个失败；121 题出现 Bubblewrap uid-map 不可用。Qwen 仅一题创建两个子任务，两者失败。父任务多数正常结算，父 DONE 不能说明子任务成功。该统计属于最终尝试，不是全部 HTTP 尝试或完整费用账本。

Core 没有按题目自动派发的规则；模型选择调用 agent_spawn。原指令以委派独立工作开头，后面才说简单任务适合单个作者。每题都委派不符合“按需”的原设计，也没有单变量证据证明指令是唯一原因。

近端故障链是：inspect 选择 sharedReadOnly → 子配置收窄文件/网络权限 → Runtime 将 Scope 判为 Restricted → full-access 部署仍进入原生 OS 沙箱 → 容器不允许所需 user namespace → 第一个文件工具失败。此前共享子任务先开始模型工作，到第一个工具才创建 Scope；只有部分隔离修改路径预检了可用性。

另有两类并发缺陷：全局委派创建锁跨隔离探针持有，阻塞无关父会话；探针结束后的隔离额度预留没有再次检查与旧 spawn API 竞争后的累计子任务数。

## Codex、DSH 与 AReaL 的控制方式

参照的是被测版本的源码，不能把其中可选机制都视为本轮已启用。

| 问题 | Codex 0.163.0 | DSH 0.2.0-rc.2 | AReaL 的处理 |
|---|---|---|---|
| 谁决定拆分 | 模型调用 spawn 工具；默认 V1 工具说明要求用户或适用指令明确请求委派，并把关键路径留在本地；可被配置 usage hint 覆盖 | 模型调用独立/继承上下文的 subagent 工具；按 provider 能力注册，鼓励同时启动已经确定独立的任务 | 模型决定可分离工作，Core 按意图、写集合与能力选择策略；明确可选，无委派配额目标 |
| 创建容量 | 创建前预留线程名额；另有可选 residency/执行容量机制 | 深度验证与 activation 准入；默认 maxDepth=1、maxActiveSubagents=8 | 保留 Thread、活动 Turn、模型请求和累计子任务的独立限额；创建按父会话串行，探针后复查额度 |
| 权限继承 | 继承父当前 Turn 的 cwd、approval、sandbox；角色可收窄工具/能力，角色文件不能覆盖父 OS sandbox 或 approval | 捕获父显式 sandbox override；进程内路径可继承 full-access preset；子 approval 固定 never，工具限制相交 | 保留父 Profile/工具/预算边界；inspect 仍收窄 OS Scope，不用扩大权限规避错误；创建前验证真实执行能力 |
| 不可用与拒绝 | 配置和容量校验在创建前执行；权限由实际执行策略落实 | provider 不支持所要求能力时拒绝；子任务不能自行扩大权限或反复申请审批 | scope.check 明确不可用即拒绝，无子模型请求和子 Thread；失联、UNKNOWN 不作为安全降级证据 |
| 等待与取消 | 控制面维护所属任务和执行状态 | activation/inbox 维护所属关系、排队和关闭 | 保留父子所有权、等待释放模型/工具许可、取消和清理结算；TaskRun 延续原跨 Turn 语义 |
| 单响应工具并行 | tool_supports_parallel 与读写锁 | parallel-safe 池和独占屏障，默认池上限 10 | 仍按模型顺序执行同响应工具；跨任务有原有工具槽。安全读并行作为性能候选，未直接改默认 |

AReaL `Limits::default` 的模型请求并发为 32、活动 Turn 上限为 256、每 Turn 累计子任务上限为 64、深度上限为 8；部署可以覆盖。64 不表示同时运行 64 个子任务，也不是模型必须用满的目标，不能直接与 DSH 的 8 个活动子任务比较。本轮保留这些默认值：当前证据证明了能力准入和锁/额度缺陷，尚未证明某个新宽度能提高同预算交付率。

本轮冻结启动脚本实际将 AReaL 的 `max_children_per_turn` 设为 **3**，Codex 的 `agents.max_threads` 设为 **4**（含主任务）；64 是库默认值，不是本轮有效扇出。三者父执行都显式使用 full-access / danger-full-access。因而这次差异是 AReaL 为 inspect 额外增加受限 Scope，而不是已证明另外两者在同一容器中成功建立了只读嵌套沙箱。

权限差异解释了本轮失效方式：另两者的子任务并不必然因为“分析任务”而切换成新的一层只读 OS 沙箱。AReaL 的隔离更明确，但缺少对应可用性准入；不能直接把别人的父 full-access 继承方式替换进来，同时继续宣称原有只读保证。

Codex 的默认 V1 工具说明还明确区分“要求分析深入”和“请求委派”，并要求不要把当前阻塞步骤交出去后等待。这比 AReaL 原来的开头更保守；但可配置 usage hint 或其他角色提示会改变它，不能仅凭源码宣布本轮每个请求都使用该默认说明。AReaL 这次采纳按需、独立工作和关键路径原则，没有添加按任务文本猜复杂度的自动分解器，也没有把子任务存在当作执行质量指标。

Codex 依据官方 commit `83086188ae0614bd882818ff1aa23f3194962012` 的[委派工具说明](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)、[创建](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/control/spawn.rs)、[子配置](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/child_config.rs)和[工具并行](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/parallel.rs)。DSH 依据实际发布包 [dsh-subagent](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent/v/0.2.0-rc.2)、dsh-tool-subagent、dsh-subagent-in-process-driver 与 dsh-agent-loop；关键位置包括权限捕获与组合、resolveChildDepth、activation 准入和 parallel/exclusive 调度。没有用当前旧版 upstream pin 替代被测包。

## 已实现的共享边界修复

1. **Runtime 能力事实。** 握手返回 restrictedScopes；Linux 实际探测 Bubblewrap namespaces，macOS 实际探测 Seatbelt。scope.check 验证父权限与收窄边界，不创建 Scope 或任务进程；scope.create 和实际原生启动仍复核。受限能力不可用不影响原本可运行的 full-access 父路径。
2. **Core 提前准入。** 共享子任务使用最终冻结配置，在持久化和首个模型请求前检查 Scope；拒绝不留下子 Thread、累计子任务占额或空 scratch。旧 Runtime 不支持检查时提示升级，保留父控制通道。
3. **并发与额度。** 幂等创建锁改为父会话所有；慢探针不阻塞无关会话。隔离预留前再次检查累计额度。原有模型/活动 Turn/工具容量、共享独占写租约和取消归属不变。
4. **模型操作接口。** 统一模型委派只暴露 executionId 作为控制身份；客户端和持久记录保留完整身份。失败 spawn 的工具 success=false；读取失败子任务的结果仍保留原失败事实。旧 threadId 调用兼容。
5. **路径和错误表达。** 模型环境事实及 task_state 明确 workspacePath、workspaceUri、commandCwd 和 scratchPath。Scope 尚未创建时明确的 UNSUPPORTED/权限拒绝记录成未派发的工具失败；UNKNOWN 仍停止，不能重放副作用。
6. **控制面与策略一致性。** task_state 改为 Core 查询，不再为读取本地事实先创建 Runtime Scope；恢复 executionId 的有界投影与客户端诊断分开。工作区事实冻结在现有指令快照中，避免逐轮累积。原生准入、命令和 Linux seccomp 共用有效 Scope 策略，修复 full-access 父标记导致受限子执行漏用 syscall 过滤的问题。

具体契约见 [Runtime API](../../api/runtime.md#权限与去重)、[Core Agent 工具](../../api/core.md#agent-tools)、[委派设计](../../design/multi-agent.md)及[工具指南](../../guides/tools.md)。

## 验证层级与边界

无模型回归覆盖：不可用受限 Scope 的只读检查不产生执行；父 full-access 仍可运行；子 Scope 不扩权；旧 Runtime 拒绝不破坏控制连接；子模型请求为零且无子 Thread/空 scratch；请求幂等；慢探针跨父会话并发；旧 API 与隔离预留竞争不突破累计额度；模型只凭 executionId 完成等待和结果整合；已知准入拒绝仍能查询实际工作区。已有所有权、取消、深度、等待、UNKNOWN 和真实 macOS 原生沙箱测试一并验证。

命令入口为 `cargo test --locked -p areal-engine`、Runtime 各 crate 测试、`npm --prefix runtime/sdk-typescript test`、相关 crate 的 all-targets Clippy、统一委派原生 smoke 与 `python3 scripts/check-docs.py`。完整尝试和未通过项在本地修复证据中保留；Linux 外层容器的原生负向场景需在可运行 Docker/CI 的环境验证，macOS 通过不能替代这项验证。

最终 Core 回归 466 项通过、10 项按原配置忽略；Runtime 回归 81 项通过，TypeScript SDK 9 项通过。格式、Clippy、机器 schema 与中英文档检查通过。macOS 原生 smoke 验证并发隔离候选的组合交付、契约拒绝与取消清理、重启后身份及回执恢复，未调用真实模型。忽略项包含显式模型回放、容量/磁盘基准与需额外配置的原生 Workgroup 测试，不计入通过数。

集成验证还补齐了已有 server/recovery 接口缺失的响应 schema，使严格客户端可完成能力核对。回环 HTTP fixture 按开发指南保留原 NO_PROXY 并追加 localhost/127.0.0.1；首次代理超时、缓存不一致和修复过程的失败日志均保留，不删除不利结果。

验证指导使用现有、默认关闭的 execution_tracking 候选：要求以独立小样本/预期检查计算，并从最终路径回读完整交付集合。路径事实、能力准入和额度不变量属于契约修复；这类模型行为指导及并行性能策略的任务收益仍需同预算开发对照与来源隔离确认。不能声称已证明避免所有自检盲区，或已把 122 题分差回收。

浏览器 bridge 的等价公开接入属于评测配置修订，必须给三方一致的协议和版本；没有改动被冻结的任务包、隐藏评分器或单方预算。现有完整原文、CAS、UNKNOWN、不自动重放与权限收窄继续保留。
