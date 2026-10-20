**中文** | [English](inspection-permissions-v2.en.md)

# 分析子任务权限、并发与回归证据

最终方案将工作职责、权限保证、执行能力和并发准入分开。`inspect/report` 表示分析并交回证据；可信配置决定是否强制源码只读；Runtime 验证部署能否落实所需策略；Core 管理容量、写入互斥、取消与结算。默认保留强制只读，新增显式的父权限继承候选，没有修改用户的全局配置或部署权限。

## 三者比较与需要纠正的认识

比较依据为被测 Codex 0.163.0、DSH 0.2.0-rc.2 的冻结实现及原启动配置，不将可选功能假定为本轮已启用。

| 问题 | Codex | DSH | AReaL 修复后的边界 |
|---|---|---|---|
| 是否委派 | 模型调用 spawn；工具和指令提供职责、限制与时机 | 模型调用 subagent 工具，执行层做深度和活动准入 | 模型决定有无可分离工作；Core 不按题号拆解，不要求每题派发 |
| 普通分析的权限 | 子任务继承父 Turn 的有效 sandbox/approval，不统一为分析自动加只读沙箱 | 继承父 preset/显式 sandbox override，工具限制相交，子 approval 为 never | 默认强制只读；可信部署可显式选择 inherit，父/Profile 限制仍有效 |
| 角色限制的含义 | 角色可改模型、指令和部分能力/工具；该版本角色文件不能覆盖父 OS sandbox/approval | 工具过滤和执行策略分别生效 | Profile/allowlist/deny 与 Runtime 边界分别执行；行为要求不冒充 OS 保证 |
| 只读保证 | 父策略本身可只读；不能据“reviewer”名称认定单个子任务获得新的只读 OS 边界 | 工具过滤只在所有副作用入口均受控时才构成有效限制 | read-only、父/Profile 已有只读、旧 sharedReadOnly 和研究 Agent 均保留硬限制 |
| 并发控制 | Thread 准入、模型/执行容量与工具并行各有职责 | activation、深度与 parallel/exclusive 工具调度分开 | 保留原容量；共享作者互斥，继承分析者只在首次潜在写入时取得写租约 |

Codex 的关键优点是**普通协作不偷偷改变执行权限模型**。这不证明 full-access 子任务最安全，也不表示任意角色都能另配强制只读。只隐藏编辑工具或提示“不要修改”，在仍能执行任意 shell 时不能保证不可写。需要硬只读的协作仍必须有实际执行边界。

原评测实际设置 AReaL 每 Turn 累计子任务上限为 **3**，Codex Thread 上限为 **4**（含父任务）；AReaL 的库默认 64 不是该次运行的有效扇出。三者父路径均为 full-access / danger-full-access。另两者没有同样的“分析即额外收窄”前提，不能据其成功推断它们在原容器中成功启动了相同的嵌套只读沙箱。

Codex 依据 [child_config](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/child_config.rs)、[role](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/role.rs) 和 [OpenAI 子任务文档](https://learn.chatgpt.com/docs/agent-configuration/subagents#approvals-and-sandbox-controls)。DSH 依据实际发布的 [subagent 包](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent/v/0.2.0-rc.2)及同版进程内驱动。完整的原失效链与创建锁/额度修复见[前一份报告](delegation-admission-repair.md)。

## 实现的最终策略

```toml
[delegation]
inspection_permissions = "read-only" # 默认，保留强制只读
# inspection_permissions = "inherit" # 显式继承，不承诺子任务无法写源码
```

环境变量为 `AREAL_HARNESS_INSPECTION_PERMISSIONS`。这是部署启动策略，修改后需安全重启。模型只能选择职责、交付和任务约束，不能通过工具参数提高部署权限。已有父只读或可信 Profile 仍取交集；旧显式 `workspaceMode="sharedReadOnly"` 与研究 Agent 不变。配置、兼容性与协议见[配置](../../guides/configuration.md#分析子任务的权限策略)、[设计](../../design/multi-agent.md)和[Core API](../../api/core.md#agent-tools)。

| 场景 | 行为与保证 |
|---|---|
| 强制只读且部署支持 | 子 Scope 收窄源码写入和网络，scratch 仍独立可写；OS 限制实际生效 |
| 强制只读但部署不支持 | 模型工作、空子 Thread 和 TaskRun worker 注册之前拒绝；父任务可继续，不静默扩权 |
| 显式 inherit，父本身为 full-access | 不额外增加分析专用的只读/禁网要求，逻辑 Scope、预算和生命周期仍存在 |
| inherit，但父/Profile 已只读 | 只读仍有效；若部署无法落实，仍拒绝，不能用 inherit 绕过 |
| 可写继承者只做可信原生读取 | 模型、read_file、image_read、fs_read/list/stat、search_files 可与父任务读取协作 |
| 首次命令、写文件、外部工具或带 hooks 的操作 | 先取得工作区独占租约，保留至 Turn 进程清理和持久结算后才释放 |

普通 shell 即使只想执行搜索，也不能仅凭命令文本认定无副作用。这类操作会进入保守的写租约路径；系统没有宣称所有分析命令都可并行。同名外部 `read_file` 也不能冒充原生读取。等待租约可取消；协调查询不占普通执行租约；这类可写分析者不能递归委派或启动超出 Turn 生命周期的开发服务。

`read_file` 使用固定 Python 助手，是可信读取入口，不能因底层启动进程就误占整轮写锁。最终实现和原生协作测试专门覆盖了这条路径，并以同名外部工具作为反例。租约覆盖 yield 后仍活跃的命令，避免只锁一次工具调用而在后台进程尚未结束时允许其他作者进入。

没有新增自动规划器、另一套模型循环、额外模型预算或隐式重试。是否值得委派仍由模型判断；按父会话的创建锁、探针后的额度复查、共享 Goal 账本和取消归属继续回归。外部工具的远端副作用仍由其宿主负责，工作区租约不构成远端事务。

## Bubblewrap 问题实际解决到哪一层

本机 Linux 默认 Docker 安全配置能运行父命令，但不能建立所需 namespace；只解除外层 seccomp 后，完整沙箱仍会因挂载 `/proc` 被拒绝。说明“能执行一次简化 bwrap”不足以证明实际后端可用。

采用仓库已有 CI 支持的临时容器配置 `seccomp=unconfined`、`systempaths=unconfined`、`apparmor=unconfined` 后，完整 Runtime 的只读文件读取和写入拒绝通过。不需要 privileged、SYS_ADMIN 或修改全局 sysctl。此设置只用于测试容器；没有将原线上故障容器宣称为已修好。

因此两条方案各自成立：需要硬只读时提供能实际落实的部署/后端；普通可信协作可显式继承已有父策略，避免不必要的额外沙箱前提。后者不是硬只读的替代品。无论哪条路径，能力不可用都提前拒绝，不先启动子模型再反复撞墙。

## 验证与实模边界

回归入口为 `cargo test --locked -p areal-config -p areal-protocol -p areal-engine -p areal-server`、Runtime 各 crate、`make delegation-permissions-smoke`、`make unified-execution-smoke`、Clippy、schema 和双语文档检查。原生权限测试覆盖 macOS、默认 Linux 容器和支持沙箱的 Linux 容器；脚本模型不计入真实模型成功率。

真实模型使用两个原失败开发 case，各做 read-only/inherit 一次同条件尝试；根预算固定 128 次物理请求、4,194,304 tokens、单次输出 32000、600 秒及三个子任务额度，模型为 gpt-6-astra / medium。Solver 只挂载公开材料，隐藏机械判据在结束后单独执行；语义检查使用匿名独立上下文。当前订阅模型路由不同于原 Arena 网关，不是原 122 题矩阵的等价重跑。

最终读取分类修正另做一次相同原 case 的固定预算回归。所有成功、失败、UNKNOWN、适配器准入失败及评审尝试均保留，不替换原结果。精确结果和成本由本地证据中的 `validation-summary.json`、`live-summary.json`、逐次状态、请求账本与评审回执给出。

相关 Rust 完整矩阵 **612 项通过、10 项原配置忽略**；最终读取分类和测试夹具收尾修正后，Engine library/委派复验 **252 项通过、4 项忽略**，与完整矩阵重叠，不累加为独立测试。Runtime **94 项通过**，TypeScript SDK **9 项通过**。Clippy、格式、机器 schema 与 **223 份 Markdown** 检查通过；三种原生环境各验证两种权限模式，原有 macOS/Linux 隔离交付、取消与重启 smoke 通过。

| 原 case | 模式/范围 | 终态 | 机械与独立语义 | 子任务 | 秒 | 物理请求 | 已知 token 下界 / 未知请求 |
|---|---|---|---|---:|---:|---:|---|
| 015-benchmark-report | read-only，对照 | completed | 均通过 | 0 | 210.1 | 10 | 157719 / 0 |
| 015-benchmark-report | inherit，对照 | failed | 缺失输出，未复审 | 0 | 105.8 | 7 | 57718 / 1 |
| 011-release-notes | inherit，对照 | completed | 均通过 | 1，完成 | 285.7 | 21 | 336367 / 0 |
| 011-release-notes | read-only，对照 | completed | 均通过 | 0 | 187.4 | 11 | 159587 / 0 |
| 011-release-notes | inherit，最终构建回归 | completed | 均通过 | 1，完成 | 202.2 | 19 | 282231 / 0 |

五次 Solver 共 **68 次物理请求、993622 已知 token 下界、1 次未知请求**，墙钟合计 **991.2 秒**。未知请求按 163072 预留记账，含预留的 charged 值为 1156694，不能把它写成实际总 token。唯一 Solver 失败是已受理流中途断开，发生在创建子任务前；两次实际子执行都完成，原输入五次均保留。

另保留 **8 次适配器资格失败**（实际模型上游调用为零；其中 16 次本地 relay 准入不等于物理模型请求）。初次独立评审有两次因缺少实测文件回执而 UNKNOWN、一次 HTTP 502；统一补充公开输入 hash 与实际文件清单后，三份原成品和最终构建成品各取得一次有效语义通过，未编辑提交迎合评审。测试日志保留早期配置遗漏、夹具预算/取消错误、沙箱探针不完整、代理影响及 MCP 重开目录锁偶发失败；后者只在测试中有界等待已完成任务释放锁，没有增加生产重试。

权限准入故障得到机制修复，不能据此声称继承模式更省资源：同一已见发布说明题的原配对中，inherit 使用更多时间和 token。最终构建回归不替换这条不利结果，也不证明差值来自读取分类。默认保留强制只读和按需委派，有来源隔离证据后再评估策略推广。

默认不晋级 inherit。需要未参与调优的来源确认和可比资源下的质量/成本证据，才能讨论默认策略或整体能力；这些已见开发 case 与机制回归不能证明补回 122 题分差，也不能保证模型永不做低收益委派。

## macOS 本地工具兼容与方案收敛

本地子任务创建与远端 namespace 失败分开处理。macOS 原生共享只读子任务可以创建，但系统 Git 和 Bash here-document 存在运行期兼容缺陷；这不支持“本机所有子任务也创建失败”的结论。最终保留本报告的默认只读、显式 inherit、按需写租约，并与模型工作前的能力准入融合；不通过切换 inherit 或扩大权限掩盖工具失败。

Git 的 `/usr/bin/git` 是 Apple 工具链入口，需要读取沙箱外的选择状态。直接解析真实 Git 后，系统/用户配置仍可能访问 Scope 之外。Runtime 现在在可信宿主解析并校验 CLT/Xcode Git，提供固定程序和资源读取，受限环境默认隔离 ambient Git 配置；不开放整个工具链或用户目录。Git 的 status、log 和 diff 可读，索引与配置写入仍被拒绝。

Bash 3.2 的 [here_document_to_fd](https://github.com/apple-oss-distributions/bash/blob/main/bash-3.2/redir.c) 调用临时文件函数时未设置 `MT_USETMPDIR`；[tmpfile.c](https://github.com/apple-oss-distributions/bash/blob/main/bash-3.2/lib/sh/tmpfile.c) 因而不使用 TMPDIR。仅调整环境变量或 `/dev/fd` 元数据不能修复这一分支。macOS 完整 Runtime 改为提供 SHA-256 锁定的独立 Bash 5.3.20，标准 Bash/sh 入口和 PATH 使用私有程序，继续在原 Seatbelt 内执行。程序、GPL-3.0-or-later 许可证、全部对应源码与补丁、构建方法一起分发，不开放共享 `/tmp`，也不改写任务脚本或系统 shell。嵌套硬编码 `/bin/bash` 或系统 shebang 仍使用系统旧版本；依赖私有临时目录时应使用 Runtime 入口或 `env bash`。

修复位于 [Runtime 命令层](../../../runtime/exec-native/src/lib.rs)、[可信工具发现](../../../runtime/host-tools/src/lib.rs)与完整包资源；Core 不新增规划或预算。GUI 资源校验覆盖 shell、许可证和源码，正式签名入口包含新增程序。构建及兼容契约见 [Runtime API](../../api/runtime.md#macos-受限命令的系统工具)和[发行要求](../../development/releasing.md)。

| 验证层级 | 观测及范围 |
| --- | --- |
| 原故障原输入回放 | 只读 Git 与 here-document 从失败变为成功；源码写入及网络仍拒绝；共享作者、inherit 均能按权限读写 |
| 原生沙箱反例 | Git 索引/配置字节不变；大小 here-document、scratch 写入成功；源码、外部临时文件读写拒绝；覆盖 native 及 full-access 父后收窄路径 |
| Core/Runtime 子任务 | 默认只读、继承、共享独占作者、隔离交付，以及只读父任务拒绝可写子任务均符合契约；并发组合、取消和重启回归通过 |
| 真实模型 | gpt-6-astra / medium，显式要求一个只读核验子任务；父子均完成，7 次命令无失败；8 次请求、60581 已知 tokens、0 UNKNOWN，60.7 秒；源码与 `.git` 文件字节不变 |
| 当前 workspace 回归 | Core 相关 crate 649 通过、11 原配置忽略；Runtime 101 通过；打包单测 11 通过、GUI 资源完整性 3 通过；格式、Clippy 和文档检查另留日志 |
| 搬迁完整包 | 含空格目录内通过 Core/Runtime 两种子任务权限验证，签名和源码清单核验通过；独立 owned/TUI release smoke 首次遭 SIGKILL，未重复该启动路径，不能据前述通过宣称发行包整体验收完成 |

真实模型使用新建公开 Git 夹具并显式要求委派，用于验证工具链，不测试模型自主判断是否应并发，也不证明整体提分。开发树包含其他会话工作，回归数字属于当前共享 workspace；本次修复另保留增量补丁和文件摘要。完整证据归档为 `readonly-tools-repair-v1`，原本地诊断、失败构建及打包启动失败均保留。已安装 GUI 未替换，原 Arena 镜像/部署和 122 题矩阵未更新重跑。

## 最新主线上的方案收敛

收敛版本以主线 `5ad7c336` 为基线，合入能力预检、每父会话准入和默认只读工具兼容修复；保留主线新增的任务参与 Scope、插件 hooks 和子结果消费逻辑。前述 649/101 等数字与首次 TUI 失败属于较早开发树，不能替代收敛版本验收。终端启动采用主线现有的前台进程组交接与恢复实现，不并存另一套入口；搜索测试也采用主线已有的 Python 原生启动桥接。

融合时暴露两项交叉问题并保留原失败回归：精简 executionId 模型回执后，自动收尾比较必须使用同一公共视图，否则会重复请求最终答复；继承分析者的插件生命周期 hooks 可能先于首个工具执行，因此存在冻结 hooks 时提前取得整轮写租约，无 hooks 的可信读取继续延迟准入。取消后必须释放租约，不能依赖模型自觉互斥。

能力呈现与请求准入分别验证。Runtime 明确不支持受限 Scope 时，隐藏研究只读创建；普通创建只呈现可用意图，父任务不可写时隐藏。查询、等待与取消保留，显式兼容请求仍在子模型工作前核对最终 Scope。macOS 私有 Bash 固定最低 15.0 编译目标，并核对实际 Mach-O 元数据，不以本机新系统可运行代替兼容证据。

Arena 复验沿用冻结的 122 题、原 Reward 和公共原生适配器，两个原模型各一轮；只有 AReaL 运行包更新。Task 失败重试从 3 增至 5，正常 DONE 0 分不重试；每次根预算和模型 HTTP 重试不变。该复验用于工程验收与历史描述性对比，不能将重试当作独立重复。正式策略优越性仍要求每侧至少五轮独立重复、可比资源与未见来源确认；本轮不据单轮历史差值晋级 inherit 或声称稳定排名。

收敛源码的完整 Rust workspace 回归为 **1082 项通过、14 项按原配置忽略**，Clippy、三份桌面 schema、SDK/脚本与 GUI 资源回归通过。含空格目录中的完整 macOS 包通过 owned release smoke 与全屏 PTY 测试。原生 Runtime 与共享服务端到端夹具的直接 Mach-O 启动暴露本机入口差异，按产品和既有搜索夹具采用系统 Python 父进程；没有改写沙箱、跳过执行或把响应管道丢失当作成功。失败日志与修正后的验收分开保留。

真实 Core/Runtime 的最终权限矩阵在本机通过：强制只读和显式继承各产生 11 次子模型 fixture 请求，父子均结算；Git 读取、大小 here-document 和 scratch 正例成功，源码/Git 配置写入、外部读取及网络负例符合各模式授权。YOLO、ASK 的一次/会话/项目授权、重启、撤销、取消和父只读规则通过。共享服务故障、崩溃恢复与多窗口生命周期也完成真实验证；脚本 fixture 不计为真实模型能力结果。
