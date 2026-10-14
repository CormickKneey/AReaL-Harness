**中文** | [English](codex-plugins-p2-acceptance.en.md)

# Codex 插件 P2 验收矩阵

2026-10-14 的候选验收，固定 Codex 0.162.1 / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`。P2 已在 `6c3de0a` 本地提交；此次另行批准的只读改动基于该版本；各实际运行 manifest 记录其源码文件摘要、diff 摘要和 Core 二进制摘要。P0 与 [P1/P3 历史记录](codex-plugins-p1-p3-acceptance.md)不被本批结果覆盖。**P2 与最终完整兼容尚未关闭。**

## 当前矩阵

| 要求 | 当前证据 | 状态/剩余 |
|---|---|---|
| 原包 hooks 声明、overlay、matcher/alias、typed MCP 模板 | 包测试 37 项通过，包含 hooks5 与 sources4 | 本地通过；Windows 真机未验 |
| 用户/项目 JSON 与 TOML 累加、全局 gate | 实际 Core 验证两来源须独立信任、无包环境；hooks=false 同时禁用包/配置 | 本地通过；managed/profile/session 完整配置栈未实现 |
| 独立信任、CAS、撤权、可见审阅 | Core stale digest 拒绝；真实 Electron 显示命令和双摘要、checkbox 门禁、丢失响应用原收据恢复 | 本地源码桌面通过10项，含独立只读同意；分发包未验 |
| Pre deny/exit2/rewrite、Post 保留真实副作用 | 实际 Runtime 写入/拒绝断言；输出6项边界检查 | 本地通过；原生文件工具完整 Codex 输入映射未对照 |
| PermissionRequest 独立于 Pre、不突破权限 | 实际允许/拒绝路径，无 tool_use_id；部署/只读 gate 保留 | 本地通过；真实供应商/全部审批模式未验 |
| 用户输入/steer 去重、Stop 同 Turn 多次继续 | 同 key 并发拒绝与成功仅执行一次；Stop 三次采样，active=false/true/true，无 Prompt 递归 | 本地通过；同连接 direct/queue steer 上传及同键去重也已通过 |
| MCP handler 与真实人工等待 | 原始 stdio 连接、模型前 block；1秒预算等待人工1.4秒后继续；MRTR4项通过 | 本地通过；远程服务/HTTP上传条件沿用 P1/P3 缺口 |
| 手动压缩 owner、Pre/Post/Start compact | 实际 MCP 三种事件各一次，真实 compaction owner | 本地通过；自动压缩/恢复/全部 attach 组合未全验 |
| UTF-8 spill、严格输出和已知失败 fail-open | head/tail 与完整保存文件可恢复；输出6项通过 | 本地通过；保留文件使用 Core 数据目录，未照搬 Codex OS temp 路径 |
| 后台并发、安全点、清理后代、SessionEnd | Runtime56项通过；实际 Core21项包含普通命令释放后台 hook、下一 Turn 上下文、确认后代退出和 End 一次 | 另行同意只读子任务后默认完整矩阵21项通过；任意依赖循环不在承诺内 |
| SubagentStart/Stop 和 agent_type | 真实普通只读子任务发出 Start/Stop，根 session_id 与子任务身份准确 | 限定 command 路径通过；自定义角色映射和只读 MCP 仍缺 |
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
AREAL_TEST_BIN_DIR=/absolute/bin-dir node scripts/plugin-readonly-hooks-smoke.mjs
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

## 本次后续验收证据

前述临时路径是历史运行记录，不保证临时制品仍存在。此次另行批准的只读实现由各新 manifest 绑定真实 Core 二进制和源码摘要。两项 data 重定向 RED 分别保留在 `/private/tmp/areal-readonly-data-red-v2.log` 与 `/private/tmp/areal-readonly-data-parent-red.log`。

原完整矩阵对普通命令设置1–3秒预算，在不同 steer/上传位置出现明确 command `timedOut` 收据；`/private/tmp/areal-readonly-full-matrix-final.log` 保留失败。普通命令夹具现采用有界10秒，并显式拒绝未预期的命令超时；产品/用户超时语义未修改。MCP 的1秒活跃预算与实际1.4秒人工等待不变。10秒运行在 `/private/tmp/areal-plugin-hooks-CFb85O/manifest.json` 通过21项默认场景，包含上传仅执行一次与确认清理；不能据此宣称宿主启动稳定在3秒内，也没有确认历史 SIGKILL 来源。

最终冻结候选：三组验收统一使用 Core SHA256 `fa0e40040ed61fb4d97f095ba522e7dcdd01ece9fb4549a38513f18dba9aecb0`，运行期间不变；独立非作者评审核对行为源码摘要一致，对此限定改动给出 SHIP。

- 只读10项：`/private/tmp/areal-readonly-hooks-86HCiw/manifest.json`，包含工作区/兄弟 data 叶重定向、父重定向预创建拒绝、真正根会话 idle Profile/SessionEnd。idle Profile RED 为 `/private/tmp/areal-readonly-idle-profile-root-red.log`；只测子会话 SessionEnd 的探针已舍弃，因为子会话本来就不发该事件。
- 默认完整矩阵21项：`/private/tmp/areal-plugin-hooks-onHQuW/manifest.json`，无 defer selector，`completeMatrix:true`。
- 源码桌面10项：`/private/tmp/areal-plugin-gui-tu6MJU/manifest.json` 与 `hook-readonly-consent.png`，独立同意 checkbox、丢失响应用原收据恢复和撤权。
- 包37项与 Engine28项：`/private/tmp/areal-readonly-package-accepted.log`、`/private/tmp/areal-readonly-engine-accepted.log`；Engine 明确过滤此前失败的 epoch 子进程探针。Runtime56项在本次后续中先前已通过，源码未再变。GUI 类型/构建/public inventory1125项与公共文档149项通过。
- 标准 schema exit0：`/private/tmp/areal-readonly-desktop-schemas.log`；可选/defaultfalse bool 只保留在本任务 Core schema。workspace 构建成功；已知 rust-objcopy SIGABRT/缺失 LLVM 布局警告仍单独记录。

空闲 hooks 现在使用当前 desktop 配置，仅进行中的 Turn 使用固定配置。研究/nativeTaskAgent 与外部平台/供应商缺口仍按前述源码或未验边界记录。

## SIGKILL 分类

历史 service-schema 调用被 kill9，原 Make 重定向把快照截成0字节。现在先在同一文件系统暂存三个输出，全部生成及JSON object校验成功后逐文件原子替换；生成失败保留全部旧文件。三次 rename 不是跨文件事务。直接未改动的缓存 generator 与标准 Make 均通过，历史 killer 仍无法确认。

本批另有直接 Rust 子进程两处 kill9：Engine `mcp_only_discovery_trust_and_revocation` 的重启 epoch probe、MCP `cross_process_refresh_serializes`。无 stdout/stderr；签名检查和 OS 查询未提供因果事件。保留为未通过，不用换启动父进程、改签名、loader/EDR 设置绕过。另一个 rust-objcopy `SIGABRT` 有明确 `@rpath/libLLVM.dylib` 布局缺失，是独立工具链问题，不证明它造成 SIGKILL。未修补机器工具链。

标准生成还暴露原先 native-host-v2 的 search schema 漂移，与当前 hooks 无关；已恢复该文件，不将邻近漂移带入本次提交。areal-core-v1 的 hooks/steer schema 属于当前改动。

## 已批准的 Runtime 写入语义

此前重叠路径 lease 冲突已由类型化任务组解决；没有开启全局 concurrent_writes 或使用 hook: 字符串前缀跳过准入。

已实现：由可信 Core/Runtime task-scope owner 受理 Ordinary/Hook 类型；按 Runtime epoch+验证过的任务 Scope 分组，每个成员仍保留自己的路径授权。同组至少一方是 Hook 时允许重叠，ordinary/ordinary 仍串行，跨组继续独占。跨组 FIFO 单位改为有界组 generation：首次受理设置固定截止，不随新成员延长；封口后新 generation 排在外部等待者之后。清理 UNKNOWN 不释放占用。路径扩张不得越过更早的外组等待者。

这会允许同任务 hook 与普通工具实际并发写入，也会改变现有公平性的单位，用户已批准且已实施。窗口为1–min(task进程wall limit,60000)毫秒，Core 使用该界限允许的最大值。权限源是当前 connection root，Task/parent 祖先由 Runtime 验证。五项 Supervisor 集成场景及真实 Native 路径覆盖受理、伪造 metadata、封口/FIFO、扩张/取消及 UNKNOWN；没有宣称所有故障均做了原生注入。固定组界限无法保证任意长期依赖循环都无等待，不能同时宣称无限同组重入和跨组无饥饿。详细只读分析与九类失败契约保存在 `/private/tmp/areal-p2-hook-write-analysis/README.md`。

## 已批准的限定只读子任务实现

用户已另行批准普通只读子任务 command hooks。Side、研究任务、nativeTaskAgent、只读根会话和禁用插件 Skills 的 Profile 继续排除；此项同意不给 MCP handler 授权。`allowReadOnlyCommands` 在请求和旧信任元数据中默认 false，绑定受审阅的包/来源与定义摘要，由 CLI 和源码 GUI 独立展示；省略会移除额外能力。Core 过滤继承计划，准入与实时检查复用同一条件。

Runtime 从实际 backend 确认 `restrictedScopeIsolation`。即使部署是 full-access，该路径也必须执行受限 Scope：仅工作区/审阅包读取、私有子任务 scratch/本插件 data 写入，禁止网络与 provider 秘密继承；未验证 backend 返回 false。任务组 anchor 只提供调度身份。

两项真实 RED 复现 data 重定向：规范化叶路径扩大可写授权，以及 Core 在验证前跟随重定向父目录预创建叶目录。修复保留字面授权身份、拒绝重定向根，并复用插件包逐级目录描述符，通过 `mkdirat`/`openat` 与 NOFOLLOW 只创建 data 叶目录。不宣称抵抗所有同 UID 目录对象替换；Runtime 仍公布 `directoryObjectIsolation:false`。

真实 Core/Native 夹具覆盖实际只读子任务 Start/Stop 身份、已存在的兄弟标记、工作区/host/兄弟数据写入与网络拒绝、秘密缺失、私有 scratch/data 写入、过期/撤销/省略信任、确认重启后持久同意、受限 Profile，以及来源本可运行 hooks 的 Side。研究/nativeTaskAgent 排除通过共享源码条件检查；此夹具未创建这些 worker 模式。只读 MCP 完整兼容继续开放。

## 关闭最终兼容的条件

补齐自定义角色输入、自动压缩/恢复/attach、全部12事件原包对照、Windows/Linux 实际执行与包、真实 OAuth/HTTP上传/指定服务和 OpenAI 私有 catalog/sharing 合法条件。现有 [P1/P3 矩阵](codex-plugins-p1-p3-acceptance.md)中的开放项继续保留；本次未发布、签名、公证或 push。
