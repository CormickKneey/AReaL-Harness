**中文** | [English](complex-workflow-repair.en.md)

# 复杂协作工具链、交接与收尾修复

本轮修复隔离执行环境缺项、无法取得隔离结论、已恢复错误触发重派和取消后重复收尾。固定八个已见任务双方各五次，共 80 次真实运行已结算。结果必须将机制正确性、正常结束和最终产物分别判断；本轮不证明整体效率追平 Codex。

## 机制与边界

| 问题类别 | 共享边界修复 | 反例与兼容性 |
|---|---|---|
| 隔离命令缺少 Node/运行库，父授权网络未传递 | Runtime 投影可信启动 PATH、只读软件资源和公共 TLS；NativeFactory 传递父 Runtime 实际网络上限 | 不继承凭据；父禁网、子 Scope deny 和源码只读仍生效；旧 Runtime 未声明能力先确认清理再拒绝/准入前选择共享 |
| 隔离任务只返回标题与状态 | Core 保存已提交 agent_report/消息，按任务与 generation 持久化，8 KiB UTF-8 分页 | 32 MiB 序列化上限；来源变化从 0 重读；阶段报告不证明完成、交付或清理；旧任务无报告返回 source=none |
| 成功 worker 仍被旧失败标记重派 | ProgressModel 失败状态限于当前模型调用 | 新失败仍保留；重试与 UNKNOWN 用量不清零；503 后同 worker 恢复，无重复文件创建或新 generation |
| 已读取消/失败回执再次触发 final | generation 仅认可本 Turn 可信 coordination 的同版本完整回执，以 provider call_id 关联 | 歧义 ID、伪造正文、新错误、未释放、UNKNOWN 和未读分页不得确认 |
| 工具契约不明确 | writes 明确精确文件并指出错误项；回执声明 sendInput 与 frozen/live | 隔离输入仍冻结，不伪装支持追加上下文；非法 writes 不启动 worker/probe |
| Responses 动态状态被提升为系统指令 | 以原时序、带来源的 user 数据投影 areal_context | 真 system 规则保留；旧历史不猜测迁移；稳定前缀不保证缓存或费用收益 |

实现位于 [Runtime 环境](../../../runtime/host-tools/src/environment.rs)、[原生 worker](../../../core/engine/src/workgroup/native.rs)、[交接存储](../../../core/engine/src/workgroup/handoff.rs)、[统一回执](../../../core/engine/src/delegation.rs)、[收尾](../../../core/engine/src/generation.rs)与 [Responses](../../../core/engine/src/model.rs)。契约见 [Core](../../api/core.md#agent-工具)、[Runtime](../../api/runtime.md)与[多 Agent 设计](../../design/multi-agent.md)。未新增题目识别、解题脚本、隐式补跑或默认性能启发式。

## 固定对照

源码基线 `213ee69691d8e4ce501d9abfa764aaabf3fb9886` 加冻结 overlay，补丁 SHA-256 `52f610560e3f7faef14810342362cc58a41e2c7508a48e051f9e4f1fd9a6ffb4`。测试对象为独立完整包；原始脏工作区及运行中的 GUI 未改动。Codex CLI 为 `0.163.0-alpha.10.2`；设计参考为冻结 0.163.0 源码，二者不声称精确源码同一。

AReaL 为 macOS arm64 debug/dev 包，关闭调试符号、未改变优化级别；Codex 为官方发行二进制。profile 不同，本轮只描述冻结制品、工具与模型的实际组合，不作为同优化条件下的 Runtime 性能排名。

模型 `gpt-6.1-sol / xhigh`，相同题面、初始资产、共同协议转发器和外部累计上限：每根 1200 秒、所有根/子/辅助请求合计 160、已观测 input 5M/output 160k；最多四根并行。正式矩阵使用双方生产默认 HTTP/SSE 恢复策略。旧单次与供应商重试显式为0的先导分开；该参数不关闭 AReaL Core 网络看门狗。不估计仅由补丁造成的因果提速。

| 产品 | 正常结束 | 语义产物通过 | 原始评分通过 | 正常且语义/网页通过 | 全尝试墙钟中位秒 | input / output 已观测下界 | 完整 usage 请求 | UNKNOWN 请求 |
|---|---|---|---|---|---|---|---|---|
| AReaL | 31/40 | 36/40 | 32/40 | 30/40 | 933.4 | 67,985,251 / 2,042,518 | 2239/2421 | 182 |
| Codex | 37/40 | 37/40 | 36/40 | 37/40 | 582.2 | 58,253,921 / 1,337,278 | 2437/2885 | 448 |

中位数包含停止/失败，不能单独代表正确交付速度。双方正常正确并完成网页检查的配对为 30/40，覆盖 8/8 题；任务等权 AReaL/Codex 墙钟几何比 1.298，任务聚类描述性 95% 区间 `[1.1864143823201687, 1.4066118207648977]`。这一条件统计有成功筛选偏差，必须与固定分母一起看。缺失 usage 不补零，请求覆盖率不是 token 覆盖率，不能据此推算精确费用。

| 任务 | AReaL 正常且产物通过 | AReaL 墙钟中位秒 | Codex 正常且产物通过 | Codex 墙钟中位秒 |
|---|---|---|---|---|
| 01-agent-chatroom | 3/5 | 1,081.4 | 5/5 | 788.4 |
| 02-durable-dag | 4/5 | 941.1 | 5/5 | 565.4 |
| 03-ticket-api | 5/5 | 702.5 | 5/5 | 535.2 |
| 04-release-pipeline | 5/5 | 875.8 | 5/5 | 540.1 |
| 05-ledger-reconcile | 5/5 | 679.7 | 5/5 | 657.2 |
| 06-incident-forensics | 4/5 | 678.0 | 5/5 | 582.0 |
| 07-release-handoff | 2/5 | 1,201.3 | 3/5 | 577.7 |
| 08-ops-portal | 2/5 | 1,201.2 | 4/5 | 744.2 |

账本原评分误把保留“缺汇率且金额明确未知”的订单行当成失败。原 verify.py、原产物和原评分保留；语义 v2 对双方全部新旧产物在影子工作区统一重评，同时增加逐订单金额检查。两项正控制、九项有效负控制通过；未将排序提前拦截的重复 mutation 计为额外规则覆盖。模型未接触隐藏评分反馈，其他题的规则未放宽。

取证 r5 的 AReaL 在根目录交付完整 report.md，脚本能复算正确的 CSV 和指标，但不将叙述报告一并生成到 --output。原评分与语义 v2 仍保留失败；公开题面对报告是否必须由脚本生成不够明确，因此另计公开复算契约 UNKNOWN（AReaL 1，Codex 0），不能称为已确认缺失报告或直接改判通过。双方新旧同类产物统一在影子工作区核验，原工作区摘要保持不变。

## 验证与保留的不利结果

完整 `make verify` 通过：Rust 1094 passed / 14 ignored，格式、静态、文档、SDK、Python、launcher 与 smoke 均通过。冻结正式包的原生交接/503/取消回归另连续五次通过。真实 Node 启动/回环监听、父禁网与子 Scope deny、公共 TLS 读取和私钥/相邻配置拒绝通过。Linux 未实机验证。

首轮完整检查与并行构建重叠时发生 rustdoc crate 载入失败，顺序重跑结果独立保留；开发期间命名冲突、call_id 关联错误、OpenSSL 资源缺项与代理失败均保留。先导四次未完整通过：AReaL 两次墙钟停止，Codex 两次网络中断。先导四份 completed worker 锁存旧 transport/unavailable 并被重派，额外 26 请求，input 至少 402836/output 21529，三请求用量未知。正式结果和全部先导消耗不混为同一组。

正式运行检查了 57 份 AReaL completed worker 记录，残留旧失败标记为 0，相同正文重复 final 为 0。Codex 不暴露前一内部字段，不能用无文件计数零证明其内部状态。80 次根模型轨迹均最多一次 final_answer；没有复现不等于所有循环已消除，交接可回取也不等于模型高效利用。

## 尚存限制与解释

聊天室 r3 的 AReaL 先请求未配置的可信验收，再显式选 requiresCurrentEnvironment，产生三个 sharedExclusive 作者。整个 Turn 的写租约使作者串行：后端约 92–701 秒，页面约 701 秒后才开始；主任务约 190 秒写另一文件时等待同一租约，直到墙钟上限。该机制与已修复的隔离 worker 重派不同。细粒度共享写入必须覆盖真实路径、命令、hooks、外部工具和未退出进程，不能简单删锁。Codex 参考配置继承父执行环境；本轮没有复制其整套任务生命周期。

另有任务在实现后继续长时间复查或缺少必需验证文档；产物通过但没有正常 final 仍算未正常收尾。HTTP 请求区间包含网络、上游排队、推理与消费；裁剪到根生命周期的并集已单列，不能将剩余差距全部解释为本地调度或纯模型计算。已检查管道配对的历史均 append-only，返回的 encrypted reasoning 进入下次输入，未支持“丢推理状态”的归因。

正式交接 r2/r5 同批次遇到上游 503：Codex 在可见重连到 5/5 后分别约 203、509 秒失败；AReaL 既有网络看门狗恢复当前推理直到两次约 1202 秒的外部上限，四次均未通过交付。该组用量未知请求分别为 AReaL 100、Codex 67。连续模型请求恢复与 worker 新 generation 重派不同；两边失败及资源消耗均保留，不把服务不可用直接当作能力或本地速度差异。本轮未修改默认恢复策略。

八题均属已见开发/回归集，五次重复不增加独立来源数，不满足四领域各 25% 的泛化门禁。仅据本轮落实有确定性证据的契约修复，不宣称整体速度、成本或能力提升。官方设计参照：[子 Agent](https://learn.chatgpt.com/docs/agent-configuration/subagents)与[配置](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 证据

[机器可核验摘要](complex-workflow-repair.json)保留逐次成败、停止、用量缺口、配对、源码身份、完整检查和全部候选尝试。完整本地材料归档于 `/Users/louis/Desktop/Agent训练数据与Benchmark/AReaL-Harness-ComplexWork8-v1.1`：`04_质量审计与复验证据/report.html` 含逐线程时间线、浏览器截图和原始 HTTP/SSE；`candidate-v2` 含冻结源码差量、完整包、固定排程与前后完整性。原始材料未随仓库公开，不能据摘要声称第三方已取得完整复现材料。
