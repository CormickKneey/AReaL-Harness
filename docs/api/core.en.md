[中文](core.md) | **English**

# Core API

Core implements a subset of pinned Codex app-server 0.145.0 plus AReaL extensions, not full official-client compatibility. See the [baseline schema](../../schemas/app-server/codex-0.145.0.json) and [desktop API](desktop.en.md) for authentication and product extensions.

## Transport and sessions

Each WebSocket text frame carries one request, response or notification, up to 4 MiB. Requests are `{id,method,params}` with string/integer id and object params. jsonrpc is optional; responses contain either result or error; batches are unsupported. Request initialize, then send initialized.

| Method | Parameters |
|---|---|
| `model/list` | `{}` |
| `thread/start` | `{cwd?,model?,dynamicTools?}` |
| `thread/list` | `{cursor?,limit?}`; 1–100, default 30 |
| `thread/read` | `{threadId,includeTurns?}` |
| `thread/resume` | `{threadId}` |
| `turn/start` | `{threadId,input}` |
| `turn/steer` | `{threadId,expectedTurnId,input}` |
| `turn/interrupt` | `{threadId,turnId}` |

Core owns stable Thread/Turn/Item IDs and history. read does not subscribe; resume atomically snapshots and subscribes, returning the baseline before subsequent events. Each connection permits 128 subscriptions, a 256-item send queue and 128-event Thread windows. Lag disconnects consumers; reconnect and resume again. Observer disconnection does not cancel tasks.

input preserves text/image/audio/file ordering with at most 1 MiB aggregate UTF-8 text, also constrained by the history budget. Authenticated clients upload media Blobs rather than supplying host localImage/localAudio paths. Adapter/model capabilities validate modalities. Original thread/start model must match the service default; product model selection uses areal/thread/start/configure.

Events include thread/started, turn/started/completed, item/started/completed and item/agentMessage/delta; AReaL media uses areal/item/agentMedia/available. Terminal completed/interrupted/failed state is published after persistence. steer preserves emitted text, cancels the current model request and continues within the same Turn.

<a id="recovery"></a>
## Execution and recovery

Tools execute only after complete model-stream termination. dynamicToolCall retains original arguments, effectiveArguments, callId, execution backend and running/succeeded/failed/cancelled/unknown outcomes. Local tools also record epoch/scope/operationId; external tools do not invent Runtime facts. Hooks and nested plugin operations have separate journals; outer failure does not erase confirmed writes.

Confirmed argument/schema errors can return to the model for correction. Persistence failures and UNKNOWN stop automatic execution. `areal/tool/acknowledge {threadId,itemId,inspection}` records 1–1024 bytes of inspection while idle. It preserves unknown history without replay or expanded grants.

`execution.backend` is runtime/command/client/mcp/plugin/agent/coordination/core. Optional `modelArguments` stores replay arguments after hooks but before Runtime ID expansion; `effectiveArguments` retains real IDs for audit and is the fallback for older records. Replay keeps one assistant text/tool-call batch per completion followed by ordered tool results. Tool images follow the batch as user images linked to callId. Chat reasoning is archived without replay; opaque Responses context preserves order.

`Limits.watchdog_disable` defaults to false. Core retries the current model request without a retry count limit for classified network failures: transport errors, HTTP 408/429/5xx, premature EOF, request/stream idle timeouts and explicit SSE rate-limit/unavailability errors. Length, empty-answer, authentication, quota and parameter errors are not network failures. See the [configuration guide](../guides/configuration.en.md). Root Agents, child Agents and independent Workgroup Engines inherit the host switch. Embedded callers pass Limits explicitly; Engine never reads process environment variables. Rust `Limits`, `NativeFactory` and `NativeExecutor` gain a `watchdog_disable` field, so explicit struct initializers must be updated. `Limits::default()` and `NativeExecutor::new()` enable the watchdog.

The watchdog keeps the same messages, tools, sampling parameters and model round. It does not consume `max_completion_retries` or reserve another Agent logical-request slot; Workgroups still account for each physical request and enforce deployment budgets. Backoff starts at 250 ms and doubles up to 30 seconds. Failed streams release their shared model permits before waiting, and cancellation and overall deadlines remain effective; solve requests also respond to steer. Core audits and discards the failed response's text, context and unexecuted calls, restores its output-byte allowance, and retains earlier executed tools and observed usage. Events are `areal/model/completionDiscarded` (new `retryKind=network|completion`) and `areal/model/watchdogRetry {threadId,turnId,purpose:solve|summary,retry,delayMs}`. Discarding a response neither rolls back executed tools nor restarts the Turn.

Goal requests check the shared budget and known usage before retrying. A failed or timed-out request with unknown usage retains its reservation and blocks the Goal with usageUnknown, without watchdog backoff or finite completion retries. Summary requests follow the same rule: the previous checkpoint is retained without a degraded replacement. Metered HTTP requests disable internal transport retries so one reservation cannot hide multiple requests.

`max_completion_retries` defaults to 0 and enables finite recovery for classified length truncation or empty completions (reasoning alone is not a final answer). With the watchdog disabled, classified network failures also use this finite allowance. Tools execute only after a complete successful stream; UNKNOWN, persistence errors, cancellation and overall deadline errors are never replayed.

Compaction retains the original goal and recent content without splitting completion/tool-result or opaque-reasoning boundaries. Summaries are at most 16 KiB with throughItemId and a persisted checkpoint. Network failures retry the same summary input without consuming validation attempts. Empty or pseudo-tool summaries get one retry; subsequent failure permits explicitly marked DEGRADED CONTEXT only if it reduces input, otherwise the Turn fails. Cancellation preserves the old checkpoint. Compaction never deletes history, journals or Turn tool state.

Model audits in `data_dir/model-requests/*.json` and `requests.jsonl` record solve/summary, parameters, body digest/size, attempts, usage, stopReason, duration and bounded response shape, without headers, endpoints or prompts. `usageObserved=true` means a complete parseable usage event was received, including zero; missing/false is not known zero. A length termination still collects same-frame/tail usage within deadlines and cancellation, then marks truncation and prevents tool execution.

Snapshots are written in format 7 and formats 1–7 can be read; older Core cannot read new snapshots. contextCheckpoint affects model input without deleting original history. modelContext retains opaque Responses context, not user content. Missing usage/duration is unknown, not zero.

<a id="dynamic-tools"></a>
## Dynamic tool callbacks

thread/start.dynamicTools accepts `{name,description,inputSchema,outputSchema?}[]`, persisted and immutable for the Thread lifetime. After recording intent, Core requests the registering connection:

```json
{"id":"REQUEST_ID","method":"item/tool/call","params":{"threadId":"THREAD_ID","turnId":"TURN_ID","callId":"CALL_ID","tool":"lookup","arguments":{"key":"answer"}}}
```

The client echoes the request id:

```json
{"id":"REQUEST_ID","result":{"success":true,"contentItems":[{"type":"inputText","text":"42"}],"structuredContent":42}}
```

success/contentItems are required. Successful structured output is checked against outputSchema; see [desktop API](desktop.en.md) for media extensions. success=false is confirmed failure. RPC errors, invalid/oversized results, disconnects, timeouts and cancellation become UNKNOWN without retry. areal/tool/cancelled is best-effort and does not guarantee rollback.

Restored definitions have no host binding. A callback-capable client may take over through resume when the old host is disconnected and Thread idle. Execution-host disconnection stops the affected Turn. TUI/Web return method-not-found for arbitrary callbacks. See [tools](../guides/tools.en.md) for registration limits.

<a id="agent-tools"></a>
## Agent tools

| Tool | Parameters |
|---|---|
| `agent_spawn` | `{prompt,maxModelRounds?}` |
| `agent_read` | `{threadId,offset?:0}` |
| `agent_wait` | `{threadId,timeoutMs?:10000}` |
| `agent_wait_any` | `{threadIds,timeoutMs?:10000}` |
| `agent_report` | `{summary,evidence,remaining}` |
| `agent_send_input` | `{threadId,prompt}` |
| `agent_cancel` | `{threadId}` |

prompt is nonempty, at most 32000 characters and subject to the input-byte budget. maxModelRounds is 1–1024 and cannot expand the parent limit; the final round is handoff-only. wait timeout is 0–60000 ms without cancellation. wait_any accepts 1–16 distinct direct children. report is child-only: summary up to 4096 characters, two arrays of up to 16 entries/512 characters each, at most 16 KiB serialized arguments.

Snapshots contain status, settled, text, offset/nextOffset, source/sourceItemId, partial and errors. Text pages contain at most 2048 UTF-8 bytes; restart from 0 when the content source changes. settled confirms task and cleanup settlement. Reports do not turn failure into success. Targets are bound to the parent Turn; cross-root/sibling/ancestor control is forbidden.

Model-spawned tasks join before normal parent completion. Manual `areal/agent/spawn {parentThreadId,input}` cancels descendants when the parent ends; `areal/agent/list` observes with pagination. Default depth/fan-out are 8/64; either set to 0 disables tools. See [admission design](../design/multi-agent.en.md).

Optional research mode replaces default model agent tools with `delegate_tasks`, `read_agent` and `cancel_agent`; see [configuration, asynchronous results and reports](../guides/tools.en.md#research-agents). It does not change the client `spawn_child` RPC. Restoring `source=nativeResearchAgent` reapplies read-only source access and built-in-tool restrictions.

Embedded `RuntimeConfig.command_scratch` may name a separate directory but must not contain workspace or Core data. Runtime must explicitly grant `workspace://scratch`. Shared research budgets cover one Engine lifetime; restart starts a new budget lifecycle.

<a id="workgroups"></a>
## Workgroups and embedding

Service methods are `areal/workgroup/policy/start/list/read/wait/cancel/revise/artifact`. start takes `{requestId,plan,workers?,admission?}`; wait takes `{id,afterRevision,timeoutMs}`; revise takes `{id,requestId,expectedRevision,plan}`; artifact takes `{id,path?,offset?}`. See the [schema](../../schemas/areal-core-v1.json) and [usage guide](../guides/workgroups.en.md).

State revision and planRevision are separate. Revisions affect unstarted tasks or appended nodes and preserve original checks/grants. Identical owner/requestId and parameters return the original group; changed parameters conflict. Models control only their current Turn's groups. Waits are limited to 60 seconds without blocking cancellation on the connection. Four of 16 in-flight slots are reserved for control. Only verified artifacts with confirmed cleanup are readable.

Rust interfaces live in [Engine](../../core/engine/src/lib.rs), [concurrency](../../core/engine/src/concurrency.rs) and [Workgroup](../../core/engine/src/workgroup/mod.rs). Embedders own Runtime, MCP Connections, PluginHost and Service lifecycles. Await Engine shutdown before closing hosts; Drop is not asynchronous cleanup. A Service's parent Engine and Factory should share a SharedModel pool.

Rust launchers call `areal_config::skills::discover(workspace, homedir)` for `SkillDiscovery { skills, warnings }` and must display individual Skill warnings. Each entry includes id/revision/root/metadata. Engine `SkillLocation` accepts optional metadata and reuses the header parser when omitted. The new field affects Rust struct-literal callers; existing deployment JSON may still omit it. Bodies and attachments are not cached in the startup catalog; see the [desktop Skill contract](desktop.en.md#skills).

## Errors

Standard -32700/-32600/-32601/-32602/-32603 mean parse/request/method/argument/internal errors. -32000 is closed, -32001 capacity, -32003 authentication, -32004 missing and -32009 conflict. Transport id is not a business deduplication key. Read authoritative state after losing old turn/start or spawn responses; never replay automatically. See [desktop submissions](desktop.en.md#submissions) for requestId semantics.

<a id="goals"></a>
## Goal mode

Goals need no deployment toggle. `areal/capabilities.features.goals` is always true to advertise support; automatic continuation starts only after explicitly creating a Goal. See [client usage and recovery](../guides/clients.en.md#goals) and [deployment limits](../guides/configuration.en.md#goals). These are AReaL extensions to the pinned Codex 0.145.0 baseline, not upstream `thread/goal/*` compatibility.

### Client control

Reads require observe; mutations require interact and authorization for the Thread. Mutations require `requestId`, `threadId` and `expectedRevision`; existing-Goal mutations also require `goalId`. Identical principal/method/requestId and parameters return the original receipt before checking revision; changed parameters conflict. Read a fresh snapshot after conflicts instead of blindly retrying writes.

| Method | Additional parameters | Behavior |
|---|---|---|
| `areal/goal/get` | `threadId` | Return the projection, including control revision when goal=null |
| `areal/goal/create` | `objective, tokenBudget?, maxTurns?, maxActiveSeconds?` | Create on an idle root Thread without pending input and atomically accept the first Turn; an uncleared Goal conflicts |
| `areal/goal/update` | `goalId, objective?, tokenBudget?, maxTurns?, maxActiveSeconds?` | Edit after stopping and cleanup; retain identity and usage without starting execution |
| `areal/goal/pause` | `goalId` | Persist paused, pause the user queue and request cancellation; cleanup may still be running when the response arrives |
| `areal/goal/resume` | `goalId` | Validate budget, UNKNOWN and hosts, then resume; wait for active-Turn capacity if needed; only queue pauses caused by Goal pause/Stop are resumed automatically |
| `areal/goal/clear` | `goalId` | Require stopped execution, no active Turn, pending input or unsettled resources; increment control revision and retain historical attribution, evidence and accounting |

objective is 1–4000 Unicode characters and cannot be whitespace-only. Budgets are positive integers. maxTurns includes the first root Turn; maxActiveSeconds counts root-Turn model queues, execution, tools, interactions and cleanup without adding child duration or capacity waits between Turns, paused time or offline time. Omitting tokenBudget at creation leaves tokens unlimited by the Goal. For updates, omitted fields retain values and explicit null removes the Goal token limit; deployment limits still apply. Only client control can raise limits. update needs at least one field. completed Goals are read-only; clear/create starts a new Goal.

resume retains all usage and cannot bypass exhausted limits or resume completed Goals. It acknowledges conservative reservations for unknown model consumption without deleting them or restoring accountingComplete=true. Tool UNKNOWN still requires independent inspection and acknowledgement. Ordinary `thread/resume` restores subscriptions and snapshots without resuming Goal execution. Only the queue pause owned by that Goal pause can be cleared by Goal resume.

The projection contains `threadId`, `revision`, `eventSequence` and `goal`. A Goal contains `id`, `threadId`, `objective`, `status`, `reason`, budgets/usage, `activeTurnId`, `settling`, `waitingForInput`, `waitingForCapacity`, latest `report`/`reportTurnId` and `unreportedTurns`. Status is active/paused/blocked/completed/budgetLimited/failed. Control changes advance revision; persistent projection changes advance eventSequence. get and atomic resume include current usage; events are not emitted per token. State and receipts are persisted before events. A save failure emits in-memory failed/SystemError and recovery remains conservative.

goal.usage contains `inputTokens`, `cachedInputTokens`, `outputTokens`, `tokensUsed`, `reservedTokens`, `unknownRequests`, `timeUsedSeconds`, `turnsStarted` and `accountingComplete`. tokensUsed sums confirmed input/output; cached input is a subset, not an extra charge. Outstanding reservations also count toward admission. Unknown statistics never become zero. A crash window or missing usage makes accountingComplete=false. Estimated request admission does not guarantee that provider charges cannot exceed tokenBudget.

```json
{"id":20,"method":"areal/goal/create","params":{"requestId":"goal-migration-1","threadId":"THREAD_ID","expectedRevision":0,"objective":"Complete the module migration, preserve public API compatibility and pass the relevant behavior tests.","tokenBudget":200000,"maxTurns":20,"maxActiveSeconds":3600}}
```

create returns the projection and first turnId. Events `areal/goal/updated` and `areal/goal/cleared` carry threadId, revision, eventSequence and the projection; clear also carries the removed goalId. Existing Turn events and terminal meanings remain intact. Thread adds optional `goals:{revision,eventSequence,goal}`; children use `goalOwner:{threadId,goalId}`. Turn adds `goal:{goalId,sequence,origin,predecessorTurnId}`, where origin is initial/user/continuation. Old data defaults to no Goal; clear preserves revision to reject stale requests.

Goal events use the existing atomic snapshot/subscription boundary, authorization filters and backpressure rules. Reconnect by replacing local state with the full resume snapshot before applying events. Separate get/subscribe calls do not provide that atomic boundary. Rust types generate request, response and event definitions in [areal-core-v1.json](../../schemas/areal-core-v1.json).

### Model tools

| Tool | Parameters | Authority and behavior |
|---|---|---|
| `goal_read` | `{}` | Read the bound Goal, state, budget and remaining work; children receive a read-only projection |
| `goal_update` | `{expectedRevision, status, summary, evidence, remaining, blocker?}` | Current root Goal Turn only; continue/complete/blocked reports progress or requests settlement |

Core binds Goal/root identity. summary is nonempty and at most 4096 characters; evidence and remaining each allow 16 entries of at most 1024 characters, with at most 32 KiB total arguments. complete requires nonempty evidence and empty remaining; blocked requires a nonempty blocker describing the obstacle and resolution. Evidence is model-reported text referencing tools, checks or artifacts, not independent semantic verification. Core checks report structure, unconsumed verification handles, pending input and child/Workgroup settlement; actual checks and model reporting still determine business correctness.

`goal_update` returns the accepted control revision. complete remains pending until the Turn settles normally. User control, steer or queued input invalidates the previous completion request; cleanup, persistence or child failure cannot publish completed. Models cannot create, resume, raise budgets or clear Goals, bypass approvals, or finish a Goal through ordinary final text or Turn completion.

Rust embedders use `Limits.goals: goals::Policy` and `Engine::goal_get/goal_create/goal_control`. Custom Model implementations must explicitly support per-request output caps in `chat_limited` and preserve accounting via `share_context`; the HTTP adapter supports both. Custom Workgroup Factories must implement `executor_for_goal` and retain the supplied Budget; the default rejects Goal calls. Ordinary Turns and standalone Workgroups retain their existing behavior.

Goal request ledgers are stored at `goals/<goal-id>.json`, with reservations persisted before sending. Root/child Agents, native Workgroups and active-Turn summaries share accounting. Each ledger permits 4096 requests/4 MiB; clear retains ledgers and history. Snapshot format 7 stores Goals and Turn attribution and cannot be read by older binaries; the API remains areal.core.v1.
