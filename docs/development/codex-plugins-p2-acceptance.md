**中文** | [English](codex-plugins-p2-acceptance.en.md)

# Codex 插件 P2 验收矩阵

2026-10-14 的候选验收，固定 Codex 0.162.1 / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`。当前基于 `75e449a` 的本地改动；各实际运行 manifest 记录其源码文件摘要、diff 摘要和 Core 二进制摘要。P0 与 [P1/P3 历史记录](codex-plugins-p1-p3-acceptance.md)不被本批结果覆盖。**P2 与最终完整兼容尚未关闭。**

## 当前矩阵

| 要求 | 当前证据 | 状态/剩余 |
|---|---|---|
| 原包 hooks 声明、overlay、matcher/alias、typed MCP 模板 | 包测试 37 项通过，包含 hooks5 与 sources4 | 本地通过；Windows 真机未验 |
| 用户/项目 JSON 与 TOML 累加、全局 gate | 实际 Core 验证两来源须独立信任、无包环境；hooks=false 同时禁用包/配置 | 本地通过；managed/profile/session 完整配置栈未实现 |
| 独立信任、CAS、撤权、可见审阅 | Core stale digest 拒绝；真实 Electron 显示命令和双摘要、checkbox 门禁、丢失响应用原收据恢复 | 本地源码桌面通过8项；分发包未验 |
| Pre deny/exit2/rewrite、Post 保留真实副作用 | 实际 Runtime 写入/拒绝断言；输出6项边界检查 | 本地通过；原生文件工具完整 Codex 输入映射未对照 |
| PermissionRequest 独立于 Pre、不突破权限 | 实际允许/拒绝路径，无 tool_use_id；部署/只读 gate 保留 | 本地通过；真实供应商/全部审批模式未验 |
| 用户输入/steer 去重、Stop 同 Turn 多次继续 | 同 key 并发拒绝与成功仅执行一次；Stop 三次采样，active=false/true/true，无 Prompt 递归 | 本地通过；同连接 direct/queue steer 上传及同键去重也已通过 |
| MCP handler 与真实人工等待 | 原始 stdio 连接、模型前 block；1秒预算等待人工1.4秒后继续；MRTR4项通过 | 本地通过；远程服务/HTTP上传条件沿用 P1/P3 缺口 |
| 手动压缩 owner、Pre/Post/Start compact | 实际 MCP 三种事件各一次，真实 compaction owner | 本地通过；自动压缩/恢复/全部 attach 组合未全验 |
| UTF-8 spill、严格输出和已知失败 fail-open | head/tail 与完整保存文件可恢复；输出6项通过 | 本地通过；保留文件使用 Core 数据目录，未照搬 Codex OS temp 路径 |
| 后台并发、安全点、清理后代、SessionEnd | Runtime56项通过；实际 Core21项包含普通命令释放后台 hook、下一 Turn 上下文、确认后代退出和 End 一次 | 本地显式可写子任务通过；默认完整矩阵仍开放 |
| SubagentStart/Stop 和 agent_type | 真实 sharedWrite 子任务发出 Start/Stop，根 session_id 与子任务身份准确 | 显式可写默认角色路径通过；只读语义与自定义角色映射仍缺 |
| 固定 Codex 二进制对照 | 真正 codex-cli0.162.1：UserPromptSubmit exit2→0模型请求；Stop→2请求/active=true | 两事件通过；仅自有本地 hook+loopback模型，非整包/全部事件对照 |
| 管理提交人工等待与日志容量 | 真实 MRTR 上传外层持久提交 RED timeout→GREEN；近7.5MiB三请求响应 RED超限→GREEN重启/不重放 | 修复通过；实际同连接 hook steer 上传已通过 |
| schema 生成与失败保护 | 标准 `make desktop-schemas` exit0；故障/非法JSON/成功发布5项通过 | 当前命令通过，历史 SIGKILL 原因 UNKNOWN |

## 可重复命令与证据

从本任务 worktree 根、固定 Rust toolchain 和隔离 target 执行。实际 GUI 通过 Playwright CDP 驱动源 Electron，模型端点是 loopback fixture。MCP/Runtime 使用真实子进程；没有真实模型供应商、远程 OAuth 或签名/公证分发声明。

```sh
cargo test --locked -p areal-plugins
cargo test --locked -p areal-mcp
cargo test --locked -p areal-engine --test codex_plugins --test plugin_hook_output --test plugin_mcp_runtime --test plugin_mcp_subscriptions
AREAL_TEST_BIN_DIR=/absolute/bin-dir node scripts/plugin-hooks-smoke.mjs
AREAL_CORE_BIN=/absolute/bin-dir/areal node clients/gui/scripts/plugin-p2-hooks-smoke.mjs
make desktop-schemas
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui run verify
python3 scripts/check-docs.py
```

`plugin-hooks-smoke.mjs` 默认执行完整矩阵；`--defer-concurrency --defer-readonly-child` 是明确的独立子集，manifest 记录 deferred 和 `completeMatrix:false`，`--writable-child` 执行并发与生命周期，子任务明确选择 sharedWrite，也记录 `completeMatrix:false`。子集或选择不同策略后通过均不代表默认矩阵通过。

- 有界组 Runtime56项：`/private/tmp/areal-p2-hook-write-lane/final-green.log`；冻结七文件增量 SHA256 `1ab41b6414b71e3936a51c2cad4946fba08bd134f8e2820c20b07de2bc155f39`。实际 Core21项：`/private/tmp/areal-plugin-hooks-3no58f/manifest.json`，Core `0eed11f6…`，运行期间未替换。
- 独立子集16项：`/private/tmp/areal-plugin-hooks-E8XvmY/manifest.json`；包含真实人工等待、压缩与同连接 direct/queue steer 上传及同键去重。
- 原生 GUI8项与可见命令/摘要截图：`/private/tmp/areal-plugin-gui-537du4/manifest.json`、`hook-review.png`，Core `0eed11f6…`；确认运行后未被替换。
- Codex 基线：`/private/tmp/areal-codex-hooks-baseline/REPORT.md`；二进制 SHA256 `61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70`。
- Core 上传锁与容量 RED/GREEN：`/private/tmp/areal-p2-submission-upload-{red,green}.log`、`/private/tmp/areal-p2-submission-budget-{red,green}.log`。
- 包37项：`/private/tmp/areal-p2-plugins-final.log`。Engine 独立28项：`/private/tmp/areal-p2-engine-group-final.log`，明确 skip 下述已失败探针，不能称整个 suite 通过。
- MCP：39项通过、1项跨进程探针失败、2项外部条件忽略；`/private/tmp/areal-p2-mcp-plugins-regression.log` 和 `areal-p2-mcp-remaining.log`。
- 当前标准 schema：`/private/tmp/areal-p2-desktop-schemas-group-final.log`；故障出版保护：`/private/tmp/areal-p2-schema-publication-tests.log`；历史诊断：`/private/tmp/areal-p2-schema-diagnosis/README.md`。

## SIGKILL 分类

历史 service-schema 调用被 kill9，原 Make 重定向把快照截成0字节。现在先在同一文件系统暂存三个输出，全部生成及JSON object校验成功后逐文件原子替换；生成失败保留全部旧文件。三次 rename 不是跨文件事务。直接未改动的缓存 generator 与标准 Make 均通过，历史 killer 仍无法确认。

本批另有直接 Rust 子进程两处 kill9：Engine `mcp_only_discovery_trust_and_revocation` 的重启 epoch probe、MCP `cross_process_refresh_serializes`。无 stdout/stderr；签名检查和 OS 查询未提供因果事件。保留为未通过，不用换启动父进程、改签名、loader/EDR 设置绕过。另一个 rust-objcopy `SIGABRT` 有明确 `@rpath/libLLVM.dylib` 布局缺失，是独立工具链问题，不证明它造成 SIGKILL。未修补机器工具链。

标准生成还暴露原先 native-host-v2 的 search schema 漂移，与当前 hooks 无关；已恢复该文件，不将邻近漂移带入本次提交。areal-core-v1 的 hooks/steer schema 属于当前改动。

## 已批准的 Runtime 写入语义

此前重叠路径 lease 冲突已由类型化任务组解决；没有开启全局 concurrent_writes 或使用 hook: 字符串前缀跳过准入。

已实现：由可信 Core/Runtime task-scope owner 受理 Ordinary/Hook 类型；按 Runtime epoch+验证过的任务 Scope 分组，每个成员仍保留自己的路径授权。同组至少一方是 Hook 时允许重叠，ordinary/ordinary 仍串行，跨组继续独占。跨组 FIFO 单位改为有界组 generation：首次受理设置固定截止，不随新成员延长；封口后新 generation 排在外部等待者之后。清理 UNKNOWN 不释放占用。路径扩张不得越过更早的外组等待者。

这会允许同任务 hook 与普通工具实际并发写入，也会改变现有公平性的单位，用户已批准且已实施。窗口为1–min(task进程wall limit,60000)毫秒，Core 使用该界限允许的最大值。权限源是当前 connection root，Task/parent 祖先由 Runtime 验证。五项 Supervisor 集成场景及真实 Native 路径覆盖受理、伪造 metadata、封口/FIFO、扩张/取消及 UNKNOWN；没有宣称所有故障均做了原生注入。固定组界限无法保证任意长期依赖循环都无等待，不能同时宣称无限同组重入和跨组无饥饿。详细只读分析与九类失败契约保存在 `/private/tmp/areal-p2-hook-write-analysis/README.md`。

只读 hook gate 暂未移除；宽泛移除尝试被自动审批审查拒绝，因为会削弱既有只读安全边界。限定 scope 的新方案必须独立验证和明确授权，不能把写入组选择视为该授权。

## 限定只读子任务方案（尚未启用）

下一改动只涵盖 Profile 已允许 plugin Skills 的普通只读子 Session。Side、research、nativeTaskAgent 和禁用 plugin Skills 的 Profile 继续排除。单独的“只读 command hook”明确授权绑定包/来源摘要、定义摘要和 scope 类型；既有可写 hook 信任本身不能放行。该路径仅受理 command handler，MCP handler 等待独立权限设计。

Core 准入与当前定义检查必须使用同一谓词。runner 仅授予子任务可读工作区与已审阅包的读取权限，只允许写入子任务私有 scratch 和该包数据目录，禁止网络及继承 provider 秘密。Runtime 须确认强制隔离，不采用 full-access fallback 或扩大权限；写入组 anchor 只提供调度身份。撤销、UNKNOWN、后代清理沿用原所有者。

实现前定义真实 Core/Runtime 验收：在实际只读子任务执行 SubagentStart/Stop；拒绝工作区/host/其他包数据写入与网络；确认无秘密、私有数据写入可用、过期/撤销信任拒绝，Side/research/Profile 排除不变。这是在原先禁止 hook 执行的 Session 增加单独同意的执行能力，须与已批准写入组区分，也不代表只读 MCP 已兼容。

## 关闭最终兼容的条件

补齐只读子任务政策与角色输入、自动压缩/恢复/attach、全部12事件原包对照、Windows/Linux 实际执行与包、真实 OAuth/HTTP上传/指定服务和 OpenAI 私有 catalog/sharing 合法条件。现有 [P1/P3 矩阵](codex-plugins-p1-p3-acceptance.md)中的开放项继续保留；本次未发布、签名、公证或 push。
