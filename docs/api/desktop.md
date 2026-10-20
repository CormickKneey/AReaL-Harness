**中文** | [English](desktop.en.md)

# 桌面 API：areal.core.v1

本契约扩展 [Core WebSocket](core.md)，与 Runtime JSONL 和 [CLI stdio](claude-cli.md) 分开。完整请求、响应、通知和持久类型见 [areal-core-v1.json](../../schemas/areal-core-v1.json)；强类型 AReaL 请求拒绝未知字段，Codex 兼容方法保留固定版本的 wire 契约。

`make desktop-schemas` 从 Rust 类型导出插件和 Hook DTO，并纳入[固定 Codex 0.162.1 插件契约](../../upstream/schemas/codex-plugins-0.162.1/methods.json)，各契约来源见[溯源记录](../../upstream/schemas/codex-plugins-0.162.1/provenance.json)。生成时要求请求与响应 schema 成对且覆盖全部广告通知；示例客户端进一步对照运行中 Core 的 capabilities 检查覆盖率。

Web/PWA Remote 使用独立的受限 [areal.remote.v2 契约](remote-control.md)，由桌面后台代理并重新检查设备授权。它不向浏览器提供本契约的通用调用入口或本地 Bearer；Remote 的设计与已实现范围分别标注。

Thread 快照和 Item 通知支持可选 `agentMessage.phase`，生命周期、示例与旧数据兼容规则见 [Core 消息阶段](core.md#agent-message-phase)。此响应字段为兼容性新增，保持 `areal.core.v1` 版本。

## 认证与连接

产品服务监听 loopback，WebSocket 和 Blob 使用启动器认证。可信 Main 从 ready 元数据的 authFile 读取 Bearer token；Renderer 不持有该文件或模型密钥。内置 Web 使用独立的 HttpOnly、SameSite=Strict 会话 Cookie，并验证 Origin；本地启动自动登录见下文。

认证文件 `{version:1,principals:[{id,token,permissions,threadIds?}]}` 必须为 0600。权限为 observe/interact/manage/tools；显式 threadIds 限制观察与交互。客户端名称和 Thread ID 不等于认证。

initialize → initialized → areal/capabilities（可带 apiVersion）。请求 ID 双向独立，item/tool/call 是须应答的服务器请求。恢复用 thread/resume 替换基线；订阅、发送队列与背压见 [Core](core.md)。

<a id="browser-auth"></a>
### 浏览器登录

- `POST /areal/auth/bootstrap`：可信本地客户端携带 `Authorization: Bearer <本地 token>`，不发送 Origin；成功返回 `200 {code,expiresIn:60}`。Cookie 不能签发登录码，带 Origin 的请求返回 403。
- `POST /areal/auth/bootstrap/exchange`：网页发送 JSON `{code}`，Origin 必须与当前服务完全一致；最多 1 KiB，请求拒绝未知字段。成功返回 204 并设置会话 Cookie；无效、过期、已使用或其他服务实例的 code 返回 401，缺失或不匹配的 Origin 返回 403。
- `POST /areal/auth/session`：保留手工 Bearer 登录，成功同样返回 204 并设置独立会话 Cookie；已有 Cookie 不能续签。提供 Origin 时必须匹配服务。

登录码使用 244 位随机熵，60 秒有效且原子消费一次。CLI 将其放入 `/ui#bootstrap=<code>`；片段不进入 HTTP 请求目标，网页先用 `history.replaceState` 清除当前历史记录中的片段，再通过 POST 兑换，不写入 localStorage/sessionStorage。自动登录失败提示重新运行 `areal web` 或手工登录。认证响应使用 `Cache-Control: no-store`；客户端禁用代理和重定向，启动器长期 token 不进入 URL、服务描述、日志或 Cookie。

Cookie 名为 `areal_session_<origin摘要>`，不指定 Domain，使用 `HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`。当前传输仅限 HTTP loopback，不设置依赖 HTTPS 的 Secure 属性。名称区分本机端口，不能将 Cookie 当作对同机不可信进程的隔离边界。独立会话继承原身份权限和 threadIds；服务端保存登录码和会话 ID 的 SHA-256 摘要，1 小时绝对期限到达后拒绝 HTTP/新 WebSocket 并断开已有浏览器连接，不取消后台任务。服务重启使所有登录码和浏览器会话失效。每服务最多保留 64 个有效登录码和 1024 个有效会话；满额返回 429，不驱逐已有会话。

兼容性：原始 Bearer 客户端与认证文件格式不变，旧的 `areal_session=<长期 token>` Cookie 不再接受；升级后重新运行 `areal web` 或手工登录。`areal web --json` 的服务描述保持原样，既不打开浏览器，也不签发登录码。请求/响应类型见 [local-service-v1.json](../../schemas/local-service-v1.json) 的 browserBootstrap / browserBootstrapExchange。

## 方法目录

| 方法（省略 `areal/`） | 权限 | 行为 |
|---|---|---|
| capabilities | observe | 协商 areal.core.v1、方法、事件与实际限制 |
| profile/list/read, skill/list/read | observe | 版本化定义与按需资源读取 |
| thread/start/configure | interact；动态工具另需 tools | 持久受理、空闲时 CAS 配置 |
| plan/read/update | observe / interact | 最多 64 步，expectedRevision 条件更新 |
| permissions/read/forget | manage（不允许 threadIds 限定身份） | 模式、来源、授权记忆查询与撤销 |
| interaction/list/respond | observe / interact（allowProject 另需不限定 Thread 的 manage） | 追问/审批，绑定 Thread/Turn/requestId |
| provider/list/read/upsert/remove/probe | manage | 凭据引用、CAS 写入与显式连通性探测；TOML 托管 ID 的 upsert/remove 返回 `CONFIGURATION_MANAGED`，改用共享配置命令 |
| model/list | observe | providerId/modelId、解析后默认参数、isDefault、能力和可用状态 |
| turn/start/enqueue/submit, queue/list/update/remove/reorder/pause/resume | observe / interact | 持久提交、冻结配置与队列管理 |
| goal/get, goal/create/update/pause/resume/clear | observe / interact | 持久目标、CAS 控制与共享预算；显式创建目标后运行，见 [Goal 契约](core.md#goals) |
| request/read | observe | 按当前身份找回受理收据 |
| process/start/list/get/read/wait/write/resize/closeStdin/terminate | observe / interact | 受管进程与共享终端 |
| process/acknowledgeCleanup | manage | 旧 epoch 的外部清理证据，保留 UNKNOWN |
| thread/closeResources | interact | 等待受管资源回收 |
| agent/delegate, execution/list/read/wait/artifact/cancel/apply | observe / interact | 统一委派与结果交付，见 [Core 契约](core.md#agent-tools) |
| agent/spawn/wait, workflow/list/read/start | observe / interact | 配置化子任务或 Workgroup |
| mcp/list/read/configure/connect/disconnect | manage | 配置、连接和目录 revision 分开管理 |
| thread/inspect, context/read/compact | observe / interact | 权威执行视图、分页和空闲压缩 |
| thread/archive, blob/release | interact | 冷历史与未引用上传释放 |
| server/status/drain/gc | manage | 资源使用、收敛与 Blob 回收 |
| subscription/remove | observe | 退订观察，不撤销工具宿主 |

<a id="submissions"></a>
## 提交、配置与恢复

requestId 是持久业务键，RPC id 只关联响应。相同身份、方法、键和规范参数返回原结果；参数不同冲突。Thread 最多 1024 收据，管理日志 4096；容量满拒绝而不遗忘旧键。重启后 accepted 但无结果的管理记录为 UNKNOWN，不重新执行。

`areal/turn/submit` 是普通会话的原子提交入口，使用 `{requestId,threadId,expectedConfigRevision,intent}`。`intent` 互斥取 `{type:"message",input}`、`{type:"continue",expectedTurnId}` 或 `{type:"edit",expectedTurnId,itemId,input}`，继续分支不接受文本。能力由 `features.ordinaryTurnSubmit=true` 和方法声明共同确认。Core 在 lifecycle、Thread、普通所有权锁内先查收据，再核验配置、归属、归档、压缩、取消结算及 UNKNOWN。Task、Goal、Side 和任务管理会话沿用其既有入口。

Edit 要求 `features.editLastMessage=true`，仅允许编辑空闲普通会话的最后一条用户消息，且队列无 pending/running 项。`expectedTurnId` 必须匹配最新轮次（包括继续轮次），`itemId` 必须匹配最后一条非继续用户消息。Core 展开归档历史，移除该消息及之后的条目/轮次，废弃上下文 checkpoint，并准备替代 Turn；校验、历史和收据一次持久化后才激活，拒绝时原历史保留。同轮追加指令之前的条目保留，已发生的文件和外部操作不回滚。提交后先发送 `areal/thread/edited {threadId,thread}`，明确替换客户端历史基线，再发送 `turn/started`；普通部分 Turn 事件仍按条目合并。掉响应核对原请求收据，不拆成撤回/发送两步，也不自动重发。

Message 保留输入原文。正常活动轮次存在时追加队尾；空闲且没有 pending 时直接创建 Turn。有 pending 时，Message 追加队尾并恢复队列，Continue 只恢复现有队列，均先处理当前权威 FIFO 顺序。没有 pending 的 Continue 在原 Thread 创建新 Turn，写 `continuedFromTurnId`，以可见继续意图承接历史和当前工作区。继续锚点必须是最后一个 `interrupted` Turn，或有明确中断事实、Core recovery UNKNOWN 证据的 `failed` Turn；普通模型失败与已完成轮次不符合条件。未经核查的工具、Hook、插件 UNKNOWN 或资源清理仍阻止执行。

直接执行返回 `{turn}`。排队返回 `{queueItemId,queueRevision,configRevision}`，其中 Continue 的 `queueItemId` 为 null，Message 的 ID 只指向本次新项。Turn、队列与收据在同一个快照提交后才激活或通知调度器。`areal/request/read {threadId,requestId}` 查询同一方法的收据；掉响应或客户端日志清理失败保留原键，不使用新键重放。基础 `turn/start` 和 durable `areal/turn/start` 拒绝越过 retained pending 或 running 项。

turn/start/enqueue 使用 `{requestId,threadId,input,expectedConfigRevision?,interactionMode?}`。队列最多 128 历史项，每项冻结配置；仅成功自动推进，Stop/失败/UNKNOWN/重启/drain 暂停，必须显式恢复。超时后先 request/read 或读权威状态，不能推断没发生副作用。

可选 `turn/start.admissionGuard: {configRevision,ordinarySession:true}` 在冻结配置和持久化 Turn 前原子检查配置版本与普通会话当前所有权。托管子会话、活动或结算中的 Goal、排队/运行/等待中的 Task Run 以及未结算 worker 均拒绝准入；完全结算的历史或仅未来调度不占有 Thread。已归档会话、暂停或未结算队列及既有 busy/UNKNOWN/工具宿主检查仍是准入屏障。Core 保持 Task 预留锁直到持久化激活完成。enqueue 不接受此 guard；`ordinarySession:false` 无效。能力由 `features.turnStartAdmissionGuard` 声明。

可选 `thread/start.admissionGuard: {ordinarySession:true}` 在创建 Thread 或启动 Workflow 前检查实际解析的显式/默认 Profile。绑定 Workflow 的 Profile 返回参数错误 `-32602`，消息以 `UNSUPPORTED_PROFILE:` 开头。已受理的 guarded 创建重放返回原 Thread，不再尝试启动 Workflow。能力由 `features.threadStartAdmissionGuard` 声明。省略 guard 保持既有本地行为；省略字段保持旧收据摘要不变。新 guard 检查之前先查询收据，同参数已受理请求返回记录结果，不重新判定变化后的状态。

`areal/thread/observe` 在 `thread` 旁返回 `ownership: {kind: "ordinary" | "task", taskId?, runId?}`。`features.atomicObserveOwnership=true` 保证所有权、快照与订阅在同一 Thread → Tasks 锁内捕获。判定与普通准入共用：活动/结算中 Goal、受管/子 Thread、排队/运行/等待 Run 或未结算 worker 属于 Task；已结算的暂停/阻塞 Run、历史和未来调度本身不构成所有权。Task/Run 标识遵循既有 Task 与协调会话可见性授权；隐藏或无对应 Task 的所有权仍返回不带标识的 `kind: "task"`。同一 Thread 有多个 Run 预留时，标识只指向当前活动/结算中 Goal 对应的唯一 Run；没有这类 Goal 时，仅唯一候选 Run 可提供标识。无法确定唯一归属时仍返回不带标识的 `kind: "task"`。该投影不持久化到 Thread。

`areal/queue/steer` 使用 `{requestId,threadId,expectedRevision,queueItemId,expectedTurnId}` 将 pending 项原子转为指定活动轮次的引导。Core 在同一 Thread 锁下预留引导容量、校验目标轮次与输入，并将消息、队列状态 `steered` 和请求收据一次持久化后通知执行器；失败保留 pending 项。成功返回 `{queueRevision,queueItemId,turnId,itemId}`。执行沿用活动轮次的模型和模式；队列更新仍保留加入时配置。相同身份、业务键和参数返回原结果，参数变化冲突；`areal/request/read` 带 threadId 查询该收据。未知结果只查询、不自动重发。

Composer 队列在主输入区编辑消息：确认暂停后加载内容，保存更新原位置及附件引用，保留原模型/模式；保存或取消恢复原草稿。只有队列版本与暂停原因仍属于该次编辑时才恢复先前的未暂停状态。外部更新、删除或 UNKNOWN 保留编辑草稿，不自动覆盖或恢复旧状态。现有未发送 File 草稿在当前 GUI 进程内跨任务切换保留，不新增磁盘附件缓存。`pnpm --dir clients/gui run test:queue` 使用隔离 Electron/Core/Runtime 和确定性 HTTP/SSE 模型验证队列路径。

`EffectiveConfig.defaultModelRevision` 是可选的不透明默认模型快照引用。桌面创建会话或显式重选隐式服务默认模型时固定该引用；后续参数、权限等配置更新保留它。没有桌面配置的通用会话仍在 Turn/队列项提交时固定默认版本。显式 Provider 选择保存自己的模型和 Provider 快照。模型版本归数据目录所有，不包含环境凭据值。

服务启动时，旧桌面会话的隐式模型若尚无版本引用，且最后一个已受理 Turn 保存了隐式默认版本，则将该引用恢复到会话并持久化。没有这些历史证据时保留未知。读取历史不重新配置或发送消息。`thread/inspect` 的可选 `modelName` 和 `resolvedParameters` 从已有模型归档投影隐式模型的安全名称与有效参数；缺少历史版本元数据时返回 null，不使用当前默认名称冒充历史。

thread/configure 使用 expectedRevision，仅空闲且不压缩时生效。resetModel=true 清除会话模型覆盖并回到 Profile/服务默认，不能与非空 model 同传；parameters 省略保留，`{}` 按模型默认、Provider 默认依次解析。`parameters.reasoningEffort:null` 清除强度覆盖；客户端需在同一 parameters 对象中带回其他参数才能保留它们，省略字段重新采用默认值。Composer 的“使用模型默认”会带回其他参数。若模型默认是 high，结果仍为 high。`selectedSkills` 可传 Skill 的 `{id,revision}` 列表，空数组清除会话覆盖并恢复 Profile；列表必须属于当前 Profile。features.modelReset 声明支持。

`areal/thread/start` 使用 `{requestId,agentProfile:{id,revision},cwd?,model?,parameters?,dynamicTools?}` 创建按指定 Profile 冻结配置的 Thread。客户端可以用 `--agent id@revision` 传入同一引用；不需要再指定 Workflow。Profile 的 `workflow` 字段是 Agent 属性，创建 Thread 时自动启动一次并在快照 `desktop.workflowRun` 中记录 Workgroup ID 与启动状态；实时状态通过 Workgroup API 查询。相同 requestId 重试和恢复 Thread 不会重复启动；绑定 Workflow 的 Profile 只能在创建 Thread 时选择，不能通过 `thread/configure` 切换。没有 Workflow 的 Profile 不要求 Workgroup policy，仍可使用其 `toolAllowlist` 允许的工具。

`areal/model/list` 的每项 `parameters` 是 Core 按模型默认、Provider 默认合并的参数；`isDefault` 标识新会话的服务默认选择。显式 Profile 模型仍优先于全局默认。Composer 在发送前显示具体模型与有效思考强度，完全未设置强度时显示“供应商默认”，显式 `none` 显示“无”。“使用模型默认”只清除当前强度覆盖，不绕过模型或 Provider 已保存的默认值。新会话只保留本次未发送草稿的选择，创建成功后清除；历史使用会话当前已保存的选择，已有 Turn 快照不变。

`areal/model/list` 还返回本实例的 `lastAcceptedModel`（无记录时为 null）：`{acceptedAt,model,modelId,reasoningEffort}`。`acceptedAt` 为 Core 受理时间（Unix 微秒），`model` 为供应商模型引用或隐式服务默认的 null，`modelId` 为实际模型名；`reasoningEffort=null` 与显式 `"none"` 不同。用户主会话的 `areal/turn/submit` 及显式 `areal/turn/start|enqueue` 将记录与受理收据写入同一 Thread 快照，并在响应/原收据中返回该字段。重复查询不刷新时间，后台执行不更新。桌面服务按时间汇总各项目的记录，持久保存新会话偏好；它不是已有会话配置的所有者。

可选 `parameters.reasoningSummary` 接受 `auto` / `concise` / `detailed`，仅用于 Responses，按 Provider 默认 → Thread 参数合并；Provider/服务默认与 Thread 都未配置时不启用摘要请求。`areal/model/list.parameterCapabilities` 只在 Responses Provider 下包含 `reasoningSummary`，表示适配器支持传参，不保证供应商的每个模型都支持所选模式。`areal/model/list.reasoningEffortOptions` 返回现有 HTTP 适配器允许的 `none/minimal/low/medium/high/xhigh`（其他适配器为空），同样不保证远端每个模型都支持。Composer 从目录读取这些选项，通过原会话配置提交参数。事件与分段规则见 [Core 思考进度](core.md#思考进度)。

options.readOnly 收窄 Scope 写根和网络；toolAllowlist 收窄 Profile；preapprovedTools 不能取消部署强制审批，且只匹配当前工具名；预批准读取工具不会豁免它触发的 hook。maxModelRounds 为 1–1024，最后一轮仅交接，不等于团队请求预算。Profile/Workflow 定义使用不可变 id/revision；Skill 引用不冻结资源内容，见下文。

<a id="skills"></a>
## 模型配置热应用

共享服务提供两个窄方法，能力以当前连接的 `areal/capabilities.methods` 为准。仅经过认证、具有 `manage` 和 `tools`、不受 Thread 范围限制的 `desktop-owner` 可以调用；观察者、普通模型客户端和独立无配置控制器的 Engine 不具有此能力。请求不能指定文件路径、Provider 元数据或任意进程环境。

| 方法 | 请求 | 作用 |
| --- | --- | --- |
| `areal/server/modelConfiguration/read` | `{requestId?,expectedGeneration?}` | 读取实际应用版本，或核查原请求。 |
| `areal/server/modelConfiguration/apply` | `{requestId,expectedGeneration,expectedApplied:{revision,sequence},targetRevision,credentials}` | 读取权威配置并在 Core 准入门内热应用。 |

`credentials` 是目标文件所引用的 `AREAL_CREDENTIAL_` 名称到秘密值的有界映射。只允许追加不可变引用，同引用异值拒绝；旧引用继续供已有任务使用。秘密只在可信请求与执行内存中存在，不写入配置、历史、摘要、日志或回执。普通启动环境变量不能通过此入口更新。

响应包含 `{serviceId,generation,applied:{revision,sequence},modelRevision,credentialStates,operation?}`。`applied.revision` 是实际提交的整个配置文件版本，`sequence` 在本代际成功应用后递增；它们不同于默认模型的 `modelRevision`。首次装配从序号 0 开始。Core 复用同一次受控文件快照进行版本与配置校验，拒绝过期目标、已变化的非模型部署、活动工作和凭据冲突，不调用 drain、不重启 Core 或 Runtime。现有 Thread、Turn 和队列保留原配置与凭据引用。

`operation` 使用原 `requestId`，状态为 `running`、`applied`、`rejected` 或 `unknown`，终态可带脱敏的 `result` 或 `error`。受理后的操作由 Core 持有，断线不取消提交。重复请求返回原结果，不重复发布配置；响应丢失先读取原请求。进程内回执有容量边界，代际改变或记录不可用不证明原请求失败，不能自动重发。客户端可核对新实例的当前就绪状态，但不能将其当成旧请求的回执。

多个 Core 各自应用并确认。已知部分失败可按文件 CAS 补偿，再应用恢复产生的实际版本；未知请求未查清前不得回滚。外部写入或新任务可能阻止补偿，此时必须保留实际应用版本与待应用状态。只有所有项目确认、且权威文件仍为目标版本时，GUI 才报告保存完成。文件监听与显式应用共享已应用基线，非模型配置继续遵循安全重启边界。

## Skill 元信息与资源

可信部署清单的 skills 接受 `{id,revision,root,metadata?:{name,description}}`；root 相对清单目录。省略 metadata 时只解析 SKILL.md 的有界文件头，不扫描附件；显式部署和自动发现使用同一种按需读取行为。

`areal/skill/list` 接受 `{threadId}`；新草稿可用 `{agentProfile:{id,revision}}` 观察已登记 Profile 的技能，两者互斥。Profile 目录查询不创建 Thread、不读取正文；`areal/skill/read` 同样接受两种互斥上下文，以便草稿预览当前 Profile 允许的资源。Profile 读取不登记 Thread 加载状态，发送前仍在所属 Thread 中重新读取。Composer 保存技能引用与来源，发送前读取 SKILL.md 并附加到当前消息；读取失败保留草稿。

`areal/skill/list` 的 data 条目增加 name/description，resources 统一为 null（不再返回完整资源清单），available 和 resourceRoot 保持原意。模型初始提示只注入名称和有界描述；需要正文时调用 skill_read。

`areal/skill/read` / `skill_read` 每次从当前磁盘读取，maxBytes 为 1–8192，使用 offset/nextOffset 分页；sizeBytes 表示该次打开文件时的大小。资源允许超过 256 KiB，二进制返回 dataBase64；并发修改下不保证跨页一致性。资源路径限制与发现告警见[Skill 指南](../guides/skills.md)。

兼容性：Skill revision 不再是内容不可变保证，旧 skillHashes 被忽略；现有 `{id,revision,root}` 清单仍可使用。历史引用必须由可信启动器登记，否则标为不可用。自动发现 revision 改为元信息摘要；Profile/Workflow 定义与会话历史的持久化语义不变。

## 交互与媒体

审批绑定 Thread/Turn/callId、Host generation、有效参数摘要与权限，支持 allowOnce/deny；effectivePermissions.rememberAllowed=true 时另支持 allowSession/allowProject，仍不能扩大 Runtime Scope。问题最多 8 题/题 8 选项、答案 4096 字节、交互历史 256 项；等待不持有模型许可，Stop 优先，迟到或跨 Turn 回答拒绝。

`permissions/read {threadId}` 返回 configuration（mode/allow/ask/deny）、source、sandbox、workspace、session/project 授权条目和 projectFile。`permissions/forget {threadId,project}` 清除会话或项目记忆；目标 Thread 必须空闲。项目批准需要不限定 Thread 的 manage 身份。记忆与规则优先级见[权限配置](../guides/configuration.md#permissions)。旧快照缺少 permissionGrants 时按空数组读取；thread/start/resume 增加 permissionMode 字段，底层 full-access 投影为 dangerFullAccess。

POST `/areal/blobs?threadId=...` 上传原始字节，Content-Type 与签名一致；工具上传另带 callId/hostGeneration 并需 tools 权限。单文件 16 MiB，Thread 上传登记 128 项/64 MiB；不设全局 Blob 累计配额。支持 PNG/JPEG/GIF/WebP、WAV/MP3、PDF、UTF-8 文本。GET 需要认证、threadId 和引用归属；摘要不是令牌。

contentItems 按顺序保存 inputText 或 arealMedia，实际字节进入模型。认证 RPC 拒绝宿主 localImage/localAudio 路径，使用上传返回的 areal://blob URI。不支持的模态明确失败。

`DynamicToolCall.execution.fileBefore` 是可选的 `MediaRef`，保存条件写入 `workspace://repo/` 文件之前的完整字节。Core 在 hooks 与文件版本别名解析后，通过 Runtime 每页读取最多 64 KiB，验证各页的完整 SHA-256、文件大小、连续偏移与最终内容摘要。完整前像最多 8 MiB，MIME 为 `application/octet-stream`，允许空文件和二进制。Core 先保存 Blob 和工具记录中的引用，再提交原 CAS 写入。捕获失败返回 `FILE_BEFORE_CAPTURE_FAILED`，并保留 `dispatch:"not_sent"` 与原始原因；捕获中断不表示文件写入结果未知。提交后的 UNKNOWN 继续禁止自动重放。

前像通过原 Thread 授权的 Blob GET 读取，归档、fork 与 GC 保留其直接历史引用。fork 验证摘要、字节数与 MIME。只有已确认成功的文件写入可以使用此证据重建历史 Diff，后像仍需匹配成功回执的摘要和大小。创建文件无需前像；旧记录缺少该字段时继续使用可验证的完整历史读取，证据不足则显示历史版本不可用，不读取当前磁盘冒充历史。

## 进程与保留

process/start 默认 lifetime=turn；thread 生命周期需 Profile allowThreadProcesses，写服务还需部署 allow-concurrent-writes。输入归因到认证身份，输出游标与清理沿用 Runtime。PTY resize 为实际 ioctl；pipe EOF 关闭 FD，canonical PTY 使用 VEOF，raw mode 不支持。

GUI 终端选择账户中可执行的登录 shell，缺失时依次尝试 `SHELL` 和 `/bin/sh`。桌面适配器提交交互登录会话的具体 argv，并通过字面 `/usr/bin/env` 参数设置 `SHELL`、`USER`、`LOGNAME` 和 `TERM=xterm-256color`。登录和交互初始化文件负责建立用户工具链环境。Runtime 保留现有环境过滤与权限。恢复读取原托管进程 argv。运行中的终端隐藏常规清理诊断，已退出或状态不确定的进程继续显示退出与清理事实。

面向模型的 `development_service_inspect` 只列出当前 Thread 的受管记录，或返回单条记录的 Runtime 当前状态与最多 16 KiB 输出。`development_service_start` 通过同一持久 process/start 所有者提交 thread 生命周期进程，请求身份由可信的 Core Thread、Turn 和工具调用 ID 生成。Core 审批、Profile 权限和 Runtime 写入序列化检查仍然生效。启动结果未知时检查原记录，不自动重发。这两个工具不另建进程执行器，也不推断监听端口。

旧 epoch 句柄为 STALE_HANDLE，不恢复活进程。Thread 进程清理未确认、活动组或压缩阻止 restartSafe。纯历史工具或 Hook UNKNOWN 不阻止停止服务，但原 Thread 继续前仍需检查。归档需空闲且队列/资源结算，释放热历史并保留磁盘和去重键；GC 在 drain 完成后扫描冷热引用，不能删除历史仍引用的 Blob。

事件使用 areal/ 前缀，包括 thread/configured/archived、plan/updated、queue/updated、goal/updated/cleared、interaction/requested/resolved、process/updated、server/draining。各自 revision 不可与输出 cursor 混用。未知模型窗口/usage 保留 null 或缺失，不猜测。示例见[直接协议验收](../examples/desktop-api.md)。

features.goals=true 表示服务支持 Goal，无需单独配置开关；Goal 事件遵循相同的权限与原子订阅边界。drain 关闭自动续轮准入并暂停目标；归档和显式上下文压缩要求先停止 Goal 并等待资源结算。

本地服务发现、独立于窗口的生命周期和 Desktop Main 接入使用[本地服务契约](local-service.md)。`server/status` 与 `server/drain` 新增返回 `activeGoals`（Thread ID 数组）和 `pendingQueueItems`（pending/running 队列项数量）。这是响应字段的向后增量扩展；restartSafe 仍描述执行清理，不代表没有待调度工作。

`server/status` 与 `server/drain` 还返回 `lifecycle={version:1,admission:"open"|"draining"|"closed",ifIdle:{allowed,reasons},settled:{allowed,reasons},executionOutcomes:{uninspectedUnknown}}`。结果摘要是 version 1 的增量字段，统计需要检查的历史工具调用或 Hook 调用，与物理资源结算相互独立。`unresolvedTools` 保留原有检查条目。`restartSafe` 等于 `settled.allowed`。

`reasons` 为 `{code,count}` 数组，code 包括 `activeTurn`、`resource`、`compaction`、`workgroup`、`activeGoal`、`queuedMessage`、`activeTask`。Core 共用观察和准入锁内的操作判定；观察不是停止授权。`ifIdle` 要求没有工作且执行已结算，`settled` 仅描述 cancel 的执行/资源结算后置条件。cancel 保留暂停 Queue 中的输入，不重新套用 pending 必须为零的前提。未检查的历史结果仍保留在 journal 中，并继续阻止原 Thread 续轮，但不阻止服务退出。Hook task scope 不确定、Runtime 观察不可用、活跃 Runtime 进程及未确认清理仍是资源阻塞。超时可能返回 draining，RPC 成功不证明进程已退出。未知版本、原因或缺失许可字段不能推断为允许。

共享服务的 `server/status.configuration` 返回 `{modelRevision,applied,appliedRevision,applySequence,currentFileRevision,credentialStates,pendingApply,restartRequired,error}`，其他部署为 null。`applied={revision,sequence}` 是 Core 已确认的文件版本。GUI 模型配置使用上面的显式热应用接口；普通 CLI 模型热更新缺失环境凭据时可同时返回 `restartRequired=true` 和 `error`，表示需要由持有有效凭据的本地客户端安全重启；其他加载错误不触发自动重启。`areal/server/configurationChanged` 向已订阅会话发布 `{threadId,configuration}`。`server/drain` 增加 `strategy="ifIdle"`：在同一准入锁内检查空闲并关闭准入，忙碌拒绝时保留任务运行。见[配置热更新](../guides/configuration.md)。

### Desktop 适配器生命周期

这是 GUI 适配器协议，独立于 `areal.core.v1`。认证 snapshot 的 `service.lifecycle` 声明 `{version:2,desktopGeneration,capabilities:{request,read,reconcile,kinds},activeRequestId}`，支持 stopDesktop、updateDesktop、stopProject、updateProject、interruptTurn。

`lifecycleRequest` 携带 `{protocol,requestId,kind,mode,expectedDesktopGeneration,expectedTargets,threadId?,turnId?}`；mode 为 ifIdle 或 cancel；targets 每项绑定 projectId/serviceId/generation。interruptTurn 必须指定原 threadId/turnId。`lifecycleRead` 与 `lifecycleReconcile` 只携带 protocol/requestId，后者仅核查原 Host 或原轮次，不调用 ensure、drain 或 cancel。

Desktop owner 在副作用前保存持久回执，记录逐目标 Host requestId 与状态。整体 phase 为 acceptedPending、blocked、partial、admissionUnconfirmed、settlementIncomplete 或 completed。Desktop 停止的目标全部完成后，仅记录 desktopExit=requested；Main 核验原 Desktop 确实退出才显示完成。Main 在写入前持久保存原请求引用，不维护另一份执行权威。响应丢失或换代后读取原回执，已完成目标不重做；未知目标限制相关项目，其他项目保留可用。

普通启动只连接；GUI Main 的 serviceLifecycle 入口只接受 `{operation:update|stop|check}`。check 不改变执行状态。显式 update 先结算原目标并确认原 Desktop 退出，再启动替代部署；失败保留引用。旧适配器缺少上述能力时只读观察，不探测新写入、不跨层代取消。

## Task Mode 接入

GUI 的 `tasks` 只读命令支持 `operation: list | inbox`、可选 `projectId`、`limit`（1 至 1024）、UUID `requestId` 和非负整数 `viewEpoch`。省略 `projectId` 时仍汇总全部已保存所有者。指定时只读取该所有者，响应回传身份与 `owners` 终态；旧后台缺少这些身份时，GUI 要求安全更新后台，不将全局数据当作单所有者结果。每所有者从请求开始计时的 5 秒期限包含启动与全部分页。期限只结束目录读取，底层启动仍由既有生命周期管理；未结束读取跨重试复用，迟到结果不得继续分页或更新投影，失败保留上次完整结果。每页固定并检查 client 与连接 generation，重复游标视为失败。`[operation]` 日志记录 requestId、viewEpoch、projectId、阶段、耗时、页数、行数和终态；renderer 的 `[task-catalog]` 记录接收、提交或视图放弃，不记录任务正文或凭据。taskWatch 回执继续独立决定任务管理是否可用。

`task/create/list/read/pause/resume/cancel/subscribe/unsubscribe`、`channel/read/reply`、`inbox/list` 构成独立于 Thread 的任务控制与通信 API，详见 [Task 契约](tasks.md)。task/updated 通知携带 Task 投影和 channelSequence；客户端通过分页频道读取维护消息。server/status 与 drain 的 activeTasks 统计需要结算的任务工作：定时任务只在 Run 排队、执行、等待输入或子任务时计入，不计仅等待下一次触发的安排；暂停后仍在运行的定时 Run 继续计入。空闲定时安排可安全重启，保留时间、启用状态和历史。GUI/TUI/WebUI 可共享同一 Inbox；现有会话交互面板仍处理同步问题和审批。

可选 `parameters.contextWindowTokens`（1–2000000）声明模型容量，保存在模型默认参数与 Thread 覆盖中。`areal/model/list.contextWindowTokens` 未声明时仍为 null，`effectiveContextWindowTokens` 包含全局兜底。上下文检查增加 budget 字段 windowTokens、outputReserveTokens、inputLimitTokens、targetTokens、windowSource（model/fallback）。模型配置或凭据不可用时仍可查看上下文，budget 返回 null。这些元数据控制本地预检，不改变供应商模型容量。

<a id="turn-fork-开发预览"></a>

## Turn Fork

`areal/capabilities` 默认声明 `conversationDerivationV1`，`preview:false`，并公布六个派生会话方法。Fork 支持主会话或 Fork 中已持久化 Turn 的 `before` / `after` 锚点，以及 `sharedCurrent` 工作区模式。创建、列表、恢复、历史与证据读取均执行现有身份、角色与准入校验；客户端按当前连接公布的方法及能力启用入口。

`areal/thread/fork` 接受 `{requestId,sourceThreadId,anchor:{turnId,boundary:"before"|"after"},workspaceMode:"sharedCurrent",target?}`。可选 `target` 使用 `agentProfile?`、`model?` 和 `parameters?` 选择普通配置；`{}` 使用当前部署默认配置，省略时冻结最后一轮继承历史的配置。`before` 不包含锚点 Turn；`after` 要求锚点已终结。前缀中的工具、Hook 与插件操作必须结算；UNKNOWN 须经来源检查。Core 从已提交来源记录与固定冷段读取锚点前缀；来源也是 Fork 时先扁平化其继承快照。Core 持久化目标自有快照、逐轮来源 ID 和创建收据，再公开一个空闲的独立 Thread/Session；目标本地 `turns` 起初为空，来源 Goal、队列、审批和执行宿主均不继承。创建不启动模型或工具，不修改工作区文件。相同业务键和参数返回同一目标，参数冲突的 `error.data.reason` 是 `REQUEST_CONFLICT`。创建和同键重试仅返回 `turns=[]` 的 Thread 摘要；当前历史通过目标的 read/observe 恢复。目标 `conversation.kind=fork`、`origin` 和 `historySeed` 是内容来源，不是 `parentThreadId` 委派关系。

`areal/conversation/history {threadId,view:"inherited"|"reference",cursor?,maxBytes?}` 按目标授权读取 Fork 继承项或 Side 参考快照，默认页预算 64 KiB、最大 256 KiB（包括整个序列化结果）。游标绑定目标、快照、历史层和位置，跨目标或层复用被拒绝。不存在对应历史层时返回空 data、snapshotId=null 和 complete=true。超大 Item 按 UTF-8 边界分页，fragment.text 是完整条目 JSON 的连续片段，带 offsetUtf8、nextOffsetUtf8、totalBytes；客户端拼接后解析，不产生执行事件。每个完整条目的 `turn` 保存原轮次的状态、错误、耗时与 Goal 展示信息（不含 items）；GUI 按轮次重组后直接复用主消息流，不增加继承历史折叠层。分支与轮次菜单仅在回复结束后和复制按钮一起展示。`areal/context/read` 和目标后续模型请求从持久快照与本地 Turn 构造逻辑历史，不读取来源实时会话。快照上限为配置的历史上限与 64 MiB 中较小者。工具批次、已结算回执、媒体和原始结果引用按历史事实保存，不登记为目标新执行或用量；目标只可读取其快照实际引用的 Blob。目标模型必须支持继承模态与 Provider 原生上下文格式；不支持时创建返回 `MODEL_MODALITY_INCOMPATIBLE` 或 `MODEL_CONTEXT_INCOMPATIBLE`，自动 Workflow Profile 返回 `PROFILE_NOT_SUPPORTED`。旧记录缺少 `conversation` 时仍按普通主会话读取；未知 kind 或不支持的版本拒绝恢复。

<a id="side-chat-开发预览"></a>

## Side Chat

`areal/side/start` 请求 `{requestId,sourceThreadId,anchor?,selection?,workspaceAccess:"none"|"readOnly",input:[{type:"text",text}]}`；`anchor` 可为 `latestCommitted` 或 `{kind:"turn",turnId,boundary:"before"|"after"}`，省略时选取首问受理时最后一个已提交 Turn。`selection` 可为 `{kind:"itemRange",turnId,itemId,startUtf8,endUtf8,textSha256}`，在冻结前缀的单个文本 Item 上按 UTF-8 字节范围及 SHA-256 摘要验证；重复原文按位置区分，边界、范围或摘要失效返回 `STALE_SELECTION`，首问未提交。对尚未落盘或无法精确映射的文本使用 `{kind:"userQuote",text,claimedTurnId?,claimedItemId?}`，持久标记为未确认用户引文，声明的 ID 不证明来源。`turn/after` 接受完成、失败和中断轮次，活动轮次返回 `TURN_NOT_TERMINAL`。空面板不创建 Thread。首问将目标独立 Session、不可变参考快照、首个 Turn 和业务收据一起提交，然后启动模型；同键重复请求在归档、历史移入冷段或重启后仍返回同一个目标与原首轮，不启动执行或取消归档。创建和同键重试返回 `thread.turns=[]`、`turn.items=[]` 的摘要，保留目标与首轮身份、状态和配置；完整历史从目标的 read/observe 恢复。提交后响应丢失时用 `areal/request/read {requestId}` 查找，不能改键重试。重启时已提交但尚未完成的轮次明确中断，不会重发首问。

Side 的 `conversation.kind=side` 与 `policy.kind=sideReadOnlyV1` 是持久角色，`none` 仅允许 Core 固定的 `side_context_read`；`readOnly` 在创建时来源当前配置的工具允许集、身份授权、部署权限与受信任 Runtime 原生 `fs_read`、`fs_list`、`fs_stat` 和 `search_files` 的交集中读取当前工作区。历史锚点配置不扩大此授权；冻结后的工具子集跨模型配置、归档与重启保持不变。`areal/capabilities.features.conversationDerivationV1.sideWorkspaceAccess` 仅在原生路径沙箱、文件助手及搜索能力可验证且无命令 Hook 时公布 `readOnly`；否则创建明确返回 `WORKSPACE_READ_UNAVAILABLE`，用户可另选 `none`。Side Runtime Scope 仅在冻结子集包含文件工具时具有工作区读取根，否则读取根也为空；写入根为空且网络被拒绝；命令、MCP、插件、动态工具、Goal、自动 Workflow 与委派不能获得执行权限。文件读取返回 `source:"currentWorkspace"`、当前 SHA-256 与范围；同一轮次再次读取同路径时若 SHA 改变则返回 `changedSincePreviousPage:true`。目录和搜索也标记为当前工作区观察，不保证跨页原子快照。历史中的指令和工具输出都是参考数据。模型上下文只含有界最近摘录、证据引用和省略数量；追问仍使用创建时快照。`areal/side/context/read {threadId,evidenceRef?,cursor?,maxBytes?}` 受目标身份授权分页读取冻结证据，默认 8192 字节、最大 16 KiB；`evidenceRef` 与 `cursor` 不能同时传。GUI 证据阅读标明快照和确认状态，来源推进或无法查询当前状态时不会声称引用为最新。旧执行入口不能改变 Side 角色或扩权，`thread/list` 默认任务列表排除 Side。`turn/start` 和 `areal/turn/start` 仅接受文本追问，`turn/interrupt` 只停止 Side 当前 Turn；关闭 GUI 面板不发送中断。

已完成轮次的 GUI 选区默认传该轮 `after` 锚点；流式用户引文使用首问受理时的最新持久观察。富文本显示无法直接映射到 canonical 文本时，即使回复已完成，GUI 仍将其标成未确认 `userQuote`。单选区原文超过 16 KiB，或转义后无法装入初始包，返回 `SELECTION_TOO_LARGE`。初始模型包按序列化 UTF-8 字节限制在 32 KiB；证据页的 `maxBytes` 计入整个序列化结果，预算不足时明确拒绝。已有 Side 再从选区发起会打开新草稿，旧快照保持不变。

GUI 可从 Side 的一条回复中选择文字，或显式选择整条回复，预览并编辑附有 Side 与来源快照说明的文本。确认时按捕获的服务实例、项目、来源会话和 Side 归属核对目标，在最新主草稿末尾追加并用本地 insertionId 去重；现有附件与模型选择保持原状。来源推进时显示旧快照提示，来源归档或目标改变时保留预览供复制。此操作只改本地草稿，不调用发送、排队或引导接口，也不会恢复归档。

`areal/conversation/list {view?,sourceThreadId?,includeArchived?,limit?,cursor?}` 按 `main`（默认）、`side` 或 `all` 分类，默认不含归档，`limit` 为 1–100（默认 30）。`main` 只含普通主会话和 Fork，不含委派 Worker 或 Side；`sourceThreadId` 仅适用于 `side`/`all`。按 `createdAt,id` 稳定排序，游标绑定身份与筛选条件，跨筛选使用会拒绝。旧 `thread/list` 合同不变；GUI 主任务列表使用新接口并显式包含归档以支持归档视图，相关讨论面板按来源分页读取，手动刷新可发现其他客户端新建的讨论。

认证连接中，仅有 observe 权限不能创建 Side；带 `threadIds` 的身份即使有来源读取和 interact 权限也不能创建派生会话，返回 `error.data.reason=SCOPED_PRINCIPAL_UNSUPPORTED`，不会自动扩展可见列表。列表、读取、证据、Blob 和按业务键查询的收据按目标 Thread 独立授权；目标可见不意味着来源或其他 Side 可见。Side 快照关联的媒体需以该 Side 的 `threadId` 请求 Blob，猜测摘要不能跨会话读取。`areal/thread/configure` 在 Side 空闲时只接受 `model` 或 `parameters` 搭配 `expectedRevision`，保持只读角色和工具范围；配置选项、Profile、Skill 和 resetModel 被拒绝。`areal/tool/acknowledge` 可为 Side 自有的 UNKNOWN 工具记录保存明确检查说明，保持 UNKNOWN 结果且不重放；不能借此确认来源或参考快照中的工具。其他旧执行入口按持久 Side 角色拒绝写入或提权；错误的 `data.reason` 和 `data.requestId` 经 GUI Core 客户端保留。

空闲 Side 可用 `areal/thread/archive {threadId}` 持久归档；活动轮次归档会拒绝。`areal/conversation/unarchive {requestId,threadId}` 幂等恢复已归档 Side 和完整历史，不自动发问。重放 Side 原创建键从持久历史返回原始首轮，包括重启后，不重新执行或恢复归档。读取或订阅归档 Side 不会恢复它，归档期间发送仍被拒绝。来源 Stop 或归档不级联停止或删除 Side；关闭相关讨论面板只隐藏视图。已发送内容由 Core 在 GUI 或 Core 重启后恢复，未发送草稿不承诺跨进程保存。
Side 首问与追问共用活跃额度：默认每来源 2、每部署 8；超额分别报 `SIDE_SOURCE_CAPACITY_REACHED`、`SIDE_DEPLOYMENT_CAPACITY_REACHED`。每个 Side Turn 默认最多 8 次模型轮、16 次工具调用、300 秒；全局限额仍可进一步收紧。Side 不自动或手动调用模型压缩，避免额度外请求；上下文过大时明确失败。模型许可不足时 `areal/side/capacity` 推送 `waiting`/`available`，活跃 Side 的 `thread/read` 与 `areal/thread/observe` / `thread/resume` 订阅快照在 `desktop.sideCapacityStatus` 投影当前状态，停止后快照不保留等待状态；停止只取消对应 Side。Side 请求计入自己的 Session 与部署真实用量，不继承来源 Goal 预算。

## 当前 GUI 复用入口

项目下的 Session 列表来自 `project.list` / `work.list`，不使用示例数据或 GUI 已打开列表。会话详情复用 GUI 消息与 Composer；附件入口不提供。模型与权限、目标创建/暂停/恢复/清除、运行中 Follow up 队列与引导均使用真实 Core；完整目标编辑与模型目录/凭据设置仍在桌面完成。

Turn 显示投影保留 Core 的 `goal.origin`、`goal.sequence` 与 `durationMs`，供同一 GUI 消息组件显示目标自动继续标签和权威耗时。不会按消息正文猜测续跑来源，也不传输 instructionSnapshot 或完整 Turn 配置。

正文、推理和工具文本通过 `session.body {threadId, turnId, itemId, cursor?}` 完整读取并交给同一 GUI 消息流渲染，长回复不再只显示预览。该只读入口要求当前项目的 observe 授权和已打开的精确会话订阅；每页重新校验设备授权、连接与 Core 代际。公共消息正文超过内联额度时按最多 32 KiB 的 UTF-8 页读取，每位观察者只保留一个有效期 45 秒、最多 4 MiB 的临时冻结正文版本；游标不能跨消息或订阅使用。媒体与 Core 已归档、不可访问的历史仍不提供。工具参数、文本输出和公开执行状态可以展开；modelContext、凭据、完整配置、instructionSnapshot、钩子负载和私有执行元数据不传输。浏览器仅缓存当前显示范围的正文，切换会话或断开后清空；读取失败可显式重试，不重放发送或工具操作。现有原生历史接收上限仍适用。

`session.send` 可附带 `enqueue: true, expectedTurnId`，映射 `areal/turn/enqueue`，要求 `turnEnqueueAdmissionGuard`；Core 在锁内确认普通归属与配置版本。`session.control {threadId, operation, expectedRevision, values}` 使用 submit 能力和既有 commandId journal，仅支持 configure、goalCreate/goalPause/goalResume/goalClear、queueUpdate/queueRemove/queueReorder/queuePause/queueResume/queueSteer、steer。字段严格限定；不接受路径、原生方法名、连接信息或凭据。Task 归属拒绝这些普通会话控制。

快照包含脱敏模型目录、配置、目标与队列显示投影；队列至多 128 项，每项文本 1024 UTF-8 字节，含附件或截断项不可在 Remote 编辑。模型目录至多 200 项。发送和控制共享 Session 未确认门；结果未知只查原 commandId，不重发。配置/目标/队列及 enqueue 使用原生持久收据核对。直接 `turn/steer` 无可查询原生请求键，回应丢失时保持 UNKNOWN，不将消息回显当作受理证明。

普通 Session 自建目标在 Core 标记为目标管理期间仍可按精确 goalId 和版本暂停、恢复或清除；TaskRun 管理的目标仍使用 Task 控制。

目标控制还要求已受理日志把当前 Host／设备／项目与精确 goalId 绑定到 goalCreate；其他设备创建的目标在此只读。

## Side 模型与清理恢复

`areal/side/start` 省略 `model` 和 `resetModel` 保持锚点模型继承；`resetModel: true` 显式使用部署默认模型；`model` 指定模型。二者不能同时提供。旧客户端保持继承语义，旧 Core 不支持 resetModel 时应拒绝而不是静默继承。首问与后续轮次使用同一持久配置。

旁路恢复按 owner/connectionGeneration 区分 idle/loading/ready/error。确定失败等待用户重试，切换目标或新连接可重新读取；旧结果不能更新新目标。未知提交仍只核对原回执，不自动重复首问。

MCP 清理失败保持 cleanupFailed，并持久保存 cleanupUnconfirmed。无连接记录的重复 disconnect 不构成清理证据，不能解除状态或启动第二宿主；目录提交失败的回滚也传播清理未确认。重启不自动消除此标记。当前没有以远端 RPC 声明清理成功的恢复入口，需操作者先独立核验本任务宿主退出，再通过维护流程修复记录。此状态不证明进程泄漏。


## 插件包管理

以下部署级方法要求无限制的 `manage` 身份；限制到 Thread 的身份不能调用。Core 持有工作区、安装状态和范围选择，客户端不得自行改写安装文件。固定格式和阶段边界见[插件指南](../guides/plugins.md)与[实施计划](../development/codex-plugins-plan.md)。

| 方法 | 参数 | 结果/约束 |
|---|---|---|
| `areal/plugin/list` | `{}` | `revision/data/marketplaces/errors`；条目错误隔离 |
| `areal/plugin/read` | `id` | 包详情；候选版本/摘要与已安装版本/摘要/Skills 分开 |
| `areal/marketplace/add` | `root, expectedRevision, requestId` | 添加本地目录，更新安装目录版本 |
| `areal/plugin/importArchive` | `path, expectedRevision, requestId` | 导入本机 ZIP 为候选来源；返回包详情，不安装或执行 |
| `areal/plugin/install` | `id, scope, expectedRevision, source, expectedDigest, requestId` | `scope=user/project`；摘要必须匹配用户选中的来源快照 |
| `areal/plugin/configure` | `id, scope, enabled, expectedRevision, requestId` | 项目明确选择覆盖用户默认；停用撤销后续读取 |
| `areal/plugin/uninstall` | `id, expectedRevision, requestId` | 撤权；保留历史缓存 |
| `areal/plugin/setup` | `id, threadId?, requestId` | `{thread,turn,requestId}`；仅普通会话；显式选择已安装 onboarding Skill |

目录条目的 `version/sourceDigest/skills/onboardingSkill` 描述当前候选；`installedVersion/installedDigest/installedSkills/installedOnboardingSkill` 描述持久安装副本。安装必须同时提交本次选中的 `source` 和 64 位十六进制 `expectedDigest`。范围变更采用目录 `revision` 的 CAS；冲突或来源变化后重新读取，不隐式重试写入。

写操作复用现有部署管理提交账本。同身份、同 `requestId`、同方法和参数返回原结果，异参数拒绝；结果未知通过 `areal/request/read {requestId}` 查询对应 `method` 的 completed `response`，不带 `threadId`，不重放。setup 另通过普通 Turn 准入固定权威 Skill 引用；包正文不能制造其他显式 Skill 选择。未支持组件只报告能力诊断，安装不启动 MCP/hooks/apps。AReaL 管理方法与已实现的实验 Codex 管理 wire adapter 共用 Store/Engine；两者保留各自的 wire 契约。

`areal/marketplace/add`、`areal/marketplace/addGit`、`areal/marketplace/remove`、`areal/marketplace/update` 和 `areal/plugin/uninstall` 在完整 `{"result":catalog}` 回执不超过 256 KiB 时返回原完整目录。超限的成功返回 `{"revision":N,"catalogRefreshRequired":true}`，表示变更已在目录版本 N 完成。相同请求重试和回执查询保留这个原始结果，即使目录随后变化或 Core 重启。`areal/plugin/list` 另行读取完整当前目录，版本可能晚于 N；它不替换历史回执。失败仍返回原错误。

## 插件来源、MCP 与桌面 Apps

新增方法保留无限制 `manage` 授权要求，参数类型见生成 schema。来源变更使用目录 CAS 与管理回执：`areal/plugin/resolve {id,expectedRevision,requestId}`；`areal/marketplace/addGit {url,refName?,sparsePaths?,expectedRevision,requestId}`；`areal/marketplace/remove {root,expectedRevision,requestId}`；`areal/marketplace/update {expectedRevision,requestId}`。

`areal/plugin/connection {id,expectedDigest,connect,requestId}` 明确信任/断开已安装版本；`areal/plugin/mcp/list` 区分连接、认证、可选失败与清理状态。`areal/plugin/auth {id,server,operation}` 的操作为 `start/status/cancel`，返回瞬时认证状态，不是管理回执。`areal/plugin/connector/configure {id,connectorId,provider,credentialRef,expectedDigest,requestId}` 仅支持显式 GitHub 映射；凭据值只由可信启动器注入。

`areal/plugin/auth/configure {id,server,expectedDigest,configuration,requestId}` 仅持久化宿主凭据引用，要求已断开且摘要匹配，使用持久管理回执。configuration 支持 clientSecretRef/privateKeyRef/privateKeyId/clientMetadataUrl/apiKeyRef/callbackUrl；秘密值只通过可信启动输入注入。配置 revision 隔离替代/取消的认证流程。

`areal/mcp/apps/list {threadId?}` 返回完整工具元信息。`areal/mcp/app/open/request/close` 绑定 `threadId/serverId/instanceId/generation`；工具请求还绑定 `requestId`。`areal/mcp/extension/call` 的 kind 为 `settingsRead/settingsUpdate/settingsAction/mentionsSearch`。`areal/mcp/forms/list`、`areal/mcp/form/respond/preview` 验证完整待回复请求与来源服务器。`areal/mcp/tool/result {threadId,callId}` 读取已持久保存的原始 MCP 结果，模型只用剔除 `_meta` 的投影。

文件授权只来自可信 Main。已认证的非 `desktop-owner` 不能提交 `fileResource` 或私有 `ui/host-file`；App bridge 不暴露这个私有方法。实际写入回执的方法名为 `areal/mcp/app/file/write`，通过既有 `areal/request/read {requestId}` 查询。通知新增 `areal/mcp/app/notification`、`areal/mcp/tool/result`、`areal/mcp/form/requested`；桌面共享服务保留实例和连接版本，旧窗口不得接收其他实例事件。

原生 Main 使用 `areal/mcp/form/resource/prepare {threadId,requestId,fieldName}`、`stage {selectionToken,requestId,paths}` 和 `release {threadId,requestId,fieldName,uri}`。prepare/stage 要求带认证的 desktop-owner，通用 Renderer 命令不能调用；stage 按 UUID/参数进入已有管理账本，UNKNOWN 只查原收据。路径和 selection token 留在 Main/Core，Renderer 只见不透明 URI。现代 discovery 协商 MRTR，逐轮保留参数并将 requestState 留在私有层。

固定 Codex0.162.1 的 `plugin/list/installed/read/install/uninstall/reconcile/search` 与 `marketplace/add/remove/upgrade` 共享包所有者。只有 `plugin/search` 需要 initialize 的 `experimentalApi:true`。没有配置私有托管服务时，share/remote catalog 返回 `-32004` 与 capability；不返回伪空成功。`marketplace/add {source,refName?,sparsePaths?}` 已支持顶层 sparse cone 路径和更新保留；完整 hooks 与其余边界见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。

## 插件 Hooks

以下管理方法要求无限制 manage 身份；使用已有部署提交账本。

| 方法 | 参数 | 结果 |
|---|---|---|
| `areal/plugin/hooks/list` | `{}` | `data` 中逐来源列出 installedDigest、definitionDigest、definitions、诊断与信任；配置来源还有 sourceKind/origin/enabled |
| `areal/plugin/hooks/configure` | `requestId,id,expectedDigest,definitionDigest,enabled,trusted,allowReadOnlyCommands?` | 核对当前安装/来源和整份计划摘要后保存独立定义信任；失配拒绝；禁用/撤信任取消已受理调用 |
| `areal/hook/acknowledge` | `requestId,threadId,invocationId,inspection` | 空闲目标自有 UNKNOWN 的有界检查说明；保留 UNKNOWN，不重放 |

显式 `AgentProfile` 可声明 `allowPluginSkills:true`；省略或 false 维持既有排除。它允许该 Profile 参与普通会话的插件 Skills/MCP/hooks，仍要求当前包与定义的独立信任。子任务必须同时继承父任务的插件范围，不能以 Profile 选项恢复父任务已禁用的能力；只读 command hooks 仍需单独的 `allowReadOnlyCommands` 同意，Side、研究和 nativeTaskAgent 不因此开放。角色输入 `agent_type` 使用已受理 Profile 的 id，未选角色及内部自动 Skill 发现 Profile 使用 `default`；SubagentStart/Stop matcher 与输入共用该身份，子任务 Pre/PostCompact 同样携带 `agent_id`/`agent_type`。

`allowReadOnlyCommands` 省略时默认为 false，已有信任元数据也默认 false。它只独立授予普通只读子会话的 command handler，仍绑定当前包/来源和定义摘要。每份定义返回 `readOnlyCommandTrusted`，MCP handler 始终为 false。Side、研究任务、nativeTaskAgent、只读根会话和禁止插件 Skills 的 Profile 继续排除。Core 过滤继承计划并在执行前检查当前权限。限定 hooks 要求 Runtime 确认 `restrictedScopeIsolation`：工作区/包只读，仅私有子任务 scratch 和本插件 data 可写，禁止网络和 provider 秘密继承；data 父目录/叶目录被重定向时拒绝，授权保留固定路径身份。配置来源不获得包根/data 授权。省略或清除此选项移除该能力，并保守取消该包/来源全部在途调用，包括可写 hooks；撤信任/停用移除两项同意并取消已受理调用。

`desktop.hookRuns` 保存每次 invocation 的包/定义摘要、event、turnId/toolUseId、Runtime operationId、outcome、asynchronous、delivered、output 和 inspection。`areal/hook/completed` 是刷新提示，权威恢复仍读 Thread 快照。未知结果未检查时新轮次被拒绝；关闭中的 Session 也拒绝新执行。

`turn/steer` 新增可选 `requestId`；提供时与 `areal/queue/steer` 一样把 hook 与提交结果包含在持久去重边界。相同身份/方法/key/参数等待原执行或返回已存结果；不同参数拒绝。`areal/request/read {requestId}` 查询部署收据，带 threadId 的查询也附带该身份同 key 的部署记录。旧客户端省略 key 可继续调用，但不能保证丢失响应后的单次重试。并行管理操作按 key 排队，日志总预算 8 MiB，为每个 accepted 操作预留最多 256 KiB 响应及记录余量；无法预留时在执行前拒绝，不截断旧收据。schema 的相应方法与投影由 `make desktop-schemas` 生成。

评价命令通过可信桌面后端执行；Renderer 不能指定接收端、归属或上下文。契约与限制见 [user feedback](../guides/user-feedback.md).

## 桌面轨迹开关

GUI 服务的窄命令 `trajectory` 支持 `{operation:"status"}`、`{operation:"retry"}` 和 `{operation:"setEnabled",enabled:boolean,expectedRevision:string}`。启停要求当前文件的 64 位小写 SHA-256，不接受配置路径、目的地址或认证覆盖；桌面适配器固定使用与 Core 相同的配置和凭据环境。状态读取不解密凭据，也不进入任务准入计数。启停立即应用上传控制；采集设置只在 Core 空闲、无排队任务且没有其它配置变化时，复用安全应用的 `ifIdle` 排空与重启。响应的可选 `capture_apply_pending` 和 `capture_apply_error` 分别表示等待应用及应用问题；客户端不能把它们显示为就绪开启。远端分析和归档状态不由该开关推断。

## Desktop 后台命令兼容

共享 Desktop 的 `areal.desktop-service.v1` 认证快照新增 `service.commandContract: "areal.desktop-commands.v1"`。这项声明来自驻留 Desktop 代码，与 Rust Core 的能力独立。Main 将精确匹配结果投影为顶层及每个项目的 `desktopCapabilities.currentCommands`，不采用旧快照自行声明的同名投影。

缺失或未知命令声明不阻止只读接入；停止原后台另需独立的 lifecycle version 2 能力。Main 对需要当前语义的 `send`、`continue`、`prepareCreator`、`feedback`、携带 MCP 内容的 steer/队列更新、新增插件管理操作、`providers.defaultAndApply` 和 `trajectory.setEnabled` 在发出前返回 `SERVICE_COMMAND_UNSUPPORTED`。这是已知未提交，不带未知提交标记或伪造的请求 ID。兼容的队列操作继续使用原业务请求键；不退回另一种写操作。评价草稿读取、偏好及 MCP Apps/表单轮询按这项可用性降级，保留本地草稿。
