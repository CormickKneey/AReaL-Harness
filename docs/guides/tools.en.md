[中文](tools.md) | **English**

# Tools and hooks

Core's registry binds names and JSON Schemas to built-in, command, client, MCP or plugin backends. Core validates inputs and outputs; Runtime handles local execution. Full model-tool schemas are in [tools.rs](../../core/engine/src/tools.rs).

The Local launch defaults to YOLO. File tools and command cwd accept outside-workspace absolute paths normalized to `workspace://host`, requiring Runtime full-access. Relative paths remain workspace-relative; argv uses ordinary filesystem paths. ASK_PERMISSIONS gates effective arguments before execution; see [permissions](configuration.en.md#permissions). The launcher supplies per-Thread scratch; isolated Workgroups use private `.scratch/agent-<threadId>` within their workspace and retain their Scope boundaries.

`run_command` `oneOf` uses two complete object branches, each defining either `command` or `argv` and the common options, for compatibility with model endpoints that require complete branches. Both branches include the Runtime deadline ceiling. Call parameters are unchanged; Core still rejects supplying both entry points or neither.

| Tool | Key parameters and boundaries |
|---|---|
| `read_file` | `path,offset?=1,limit?=120`; UTF-8 lines, line numbers, nextLine/eof, whole-file digest and fileVersion; at most 1000 lines/about 14 KiB |
| `search_files` | `pattern,path?=".",glob?,context?=2,limit?=50`; rg regex, context ≤10 and limit ≤100; respects gitignore without following symlinks |
| `image_read` | `path,maxDimension?=2048,crop?`; PNG/JPEG/WebP, up to 8 MiB/32 MP; downscales only and returns actual Core Blob image content |
| `fs_read/list/stat` | Relative paths or workspace URIs; read offset defaults to 0, maxBytes defaults/caps at 8192, returning a whole-file digest/version; list defaults to 100, maximum 256 |
| `fs_create` | `path,text`; create only if absent |
| `fs_write` | `path,text,fileVersion?/expectedSha256?`; omitted version uses the current Turn's last observation, or create-only if unobserved |
| `fs_apply_patches` | `path,patches[1..32],fileVersion?/expectedSha256?`; apply multiple unique replacements in one conditional operation, with no write if any fails |
| `run_command` | Exactly one of `command` or `argv`; command uses `/bin/bash -o pipefail -c`, argv runs directly; cwd defaults to `.` |
| `verify_command` | `argv,cwd?,timeoutMs?,yieldMs?`; direct execution, rejects shell entry points and requires separate scratch |
| `read_process/write_process/terminate_process` | Current-Turn process handles for continued reads, input and termination |
| `read_tool_result` | `resultId,after?=null,maxBytes?=8192`; page through original JSON from a historical call in this Thread using nextCursor, without rerunning the tool |
| `task_state` | `{}`; bounded observations of files/processes/children/scratch and summaryThroughItemId, without live probes |

Files are limited to 8 MiB and individual writes/patches to 64 KiB, also constrained by the 64 KiB argument budget per call. Explicit fileVersion and expectedSha256 are mutually exclusive; null SHA means create-only. Successful edits return a new version and normalized path. Shell/external edits do not refresh observations; reread after CAS conflicts. Use fs_read for long lines. read/search execute Python/rg in the same Scope with a 15-second deadline, requiring trusted system Python. Bundled rg 15.2.0 uses a Runtime-verified absolute path, ignores host rg configuration and ignore files above the workspace, and does not widen the sandbox.

Each complete model response uses the remaining Turn `max_tool_calls` allowance, with calls executed sequentially. Chat indices associate fragments and may be sparse nonnegative integers; they need not be below 16. Both protocols use the configurable `max_tool_buffer_bytes` budget (4 MiB by default) for combined tool IDs, names and arguments. Invalid indices or exhausted budgets prevent every call in the current response from executing. Model-visible text result pages are at most 16 KiB; argument errors and known command failures return to the model, while UNKNOWN stops execution. Results report remainingToolCalls, with a wrap-up reminder at ≤32 and an approximate remaining base Turn wall-clock budget.

`verify_command` writes complete output (up to 64 MiB) and a receipt under scratch/verification, including exit status, logs and before/after source fingerprints. Fingerprints cover Git tracked/unignored files, or a fallback walk excluding dependencies/build/cache. Source changes invalidate verification. Task-writable receipts do not authenticate hostile tasks. Pending verification processes receive bounded finalization feedback requiring a terminal read or explicit termination. Ordinary background run_command processes are exempt; this does not wake completed Turns.

## Design choices

Command observation separates execution, waiting, display and readback: `run_command`/`read_process` read Runtime facts through cursors, and explicitly recognized test commands fold only successful progress lines and preserve diagnostics and unknown lines. Unknown commands are never guessed. This takes the explicit wait/output limits seen in Codex and the retained failure output used by Claude Code, while avoiding a global RTK pipe rewrite in the model protocol; RTK's automatic format detection can misclassify ordinary Karma timestamps, so the native parser accepts only an explicit command type from argv.

Use `fs_apply_patches` for all precise edits: one array element for a single replacement, multiple elements for changes to the same file, with the same CAS boundary. Runtime validates replacements in order before one conditional write. A failed match reports the 1-based patch index and whether the text is missing or ambiguous; no partial edit is written. Include surrounding function or other context when text repeats. The model tool `fs_apply_patch` is removed; update tool allowlists, approval rules and hook matchers to `fs_apply_patches`, and arguments to `patches: [{oldText,newText}]`. Runtime/SDK `applyPatch` remains a single-element compatibility entry point sharing the `applyPatches` implementation.

## Waiting and state

Command timeoutMs defaults to 600000, capped by Runtime grants and reported as effectiveTimeoutMs. Commands/continued reads default to 120 seconds and PTYs to 1 second. `yieldMs` / `waitMs` accept nonnegative u64 values; 0 drains retained bytes up to the page limit without waiting for new output. Waits do not extend process deadlines or hold model permits and collect at most `tools.policy.outputPageBytes` bytes (8192 by default); JSON escaping also consumes the model result budget, so control-heavy output automatically uses a smaller page and continues through its cursor. Jest, Karma, Mocha, Cargo test, Pytest and Go test may fold successful progress lines while preserving all other lines and stdout/stderr separation; a view activates only when the complete serialized result including metadata is smaller. Unknown commands, compound shell commands and output with loss pass through unchanged. Silent and early-output commands continue waiting by default; only an explicit outputQuietMs>0 returns on silence, using underlying polls of at most 1 second.

`returnReason` is completed, waitBudget, outputLimit, outputLoss or outputQuiet. `commandStatus` is running/succeeded/failed/terminated. `outputReadComplete` / `outputClosed` mean the producer closed and retained output was drained; `outputIntegrity` is retained/incomplete and `nextAction` suggests follow-up. completed still requires checking exit status. gap/truncated continue to mean loss after draining.

Omitted read_process after resumes the last cursor returned in this Turn; explicit null rereads earliest retained output. `view="auto"` folds successful progress by default; `view="raw"` returns the original page and must also be supplied on continuations. Use `read_tool_result` for historical pages with rawResult; `after=null,view="raw"` rereads process output still retained by Runtime; an end cursor does not replay earlier output. Short process/cursor/fileVersion handles bind to the Turn and target. Core expands them before Runtime permission checks; malformed handles return recoverable errors without guessing. Caches hold at most 128 file versions and one current cursor alias per process; old explicit cursor aliases expire. task_state observedOnly=true identifies historical observations, not current facts. Compaction retains these caches; Turn completion or restart expires them.

## Original results and structural views

Large text/structured results and results selected for folding are stored as Blobs before model projection. `rawResult.resultId` identifies an actual call item in this Thread. `read_tool_result` checks ownership and the digest before paging through original JSON; a Blob hash or another Thread's item is not authorization. Share across tasks through explicit artifact exports. A Turn tool allowlist must include read_tool_result; otherwise retrieval-dependent projections are disabled and missing originals are explicit. Retrieval neither refreshes file versions nor reruns the original tool and its hooks. The retrieval call itself still follows approvals, matching hooks and the normal tool budget.

Snapshots are limited to 8 MiB per result and 32 MiB per Thread, sharing the Store's global quota. Referenced active/resumable history survives restarts and GC follows references; old records without originals return unavailable. Storage failure or quota exhaustion falls back to a bounded result with `rawAvailable=false`, without recommending automatic replay of effectful tools. Process snapshots contain only pages actually received by Core, never unobserved or lost bytes; original gap/truncated facts remain valid. Multimodal data retains existing media references and the existing 16 KiB mixed-result envelope limit. Pure text/structured MCP and command results accept at most 8 MiB; plugin SDK results accept 96 KiB within their 128 KiB transport frame.

Retrieval maxBytes is 4–8192, defaulting to 8192 raw UTF-8 bytes; escaping and metadata can reduce a page. Follow nextCursor until eof. This reads historical snapshots; read_process observes processes and remains subject to Runtime buffer retention.

Extension JSON policy.resultViews accepts mode off|observe|on, default observe, and independent searchGroups/repeatLines switches, both true by default. Off disables new structural transforms; observe measures candidates; on sends candidates that pass the saving gate. Existing passing-progress folding and large-result retrieval are independent of this mode.

```json
{"policy":{"resultViews":{"mode":"on","searchGroups":true,"repeatLines":true}}}
```

The search-groups-v1 view emits contiguous matchGroups sharing path, with rows `[line,kind,text]`, preserving every returned row and its order. limited still requires narrower searches. repeat-lines-v1 only handles intact output from recognized commands: stdoutRuns/stderrRuns contain `[repeat,text]`; concatenate repeated text in order to restore each stream. Unchanged streams retain their original fields. Both transforms verify reconstruction and require at least 15% and 256 bytes of complete serialized savings with no estimated token increase. Unknown formats and unprofitable candidates pass through; there is no sampling, source-code removal or cross-task memory learning.

Sent views are persisted with history and are not rewritten after configuration changes. execution.outputProjection records bytes, token estimates, decision and preprocessing elapsed time; execution.resultSnapshot stores the Blob reference. Observe metrics are not actual token savings. Compaction retains originals and adds a retrieval index for the latest 16 snapshots; older references remain readable, but may be absent from the summary.

## Extension configuration

Set `[tools] extensions_file="tools.json"` in user TOML. JSON may contain policy, tools, hooks, mcpServers, plugins and agents. It is limited to 1 MiB, validated at startup and never implicitly loaded from the workspace. See runnable plugin [tools.json](../../core/sdk-typescript/examples/tools.json) and the [MCP guide](mcp.en.md).

Command definitions are `{definition:{name,description,inputSchema,outputSchema?},argv,timeoutMs}`. The registry allows 128 tools total, with unique 1–64-character ASCII letter/digit/underscore/hyphen names. Schemas use Draft 2020-12 without external `$ref`; input roots are objects and schema defaults are not injected.

Commands run at workspace root, reading one parameter JSON line without waiting for EOF. stdout contains one [DynamicToolResponse](../api/core.en.md#dynamic-tools); diagnostics go to stderr. Exit 0 with success=false is a confirmed business failure. Nonzero exit, timeout, truncation or malformed results may follow side effects and become UNKNOWN. Command-tool stdout is limited to 8 MiB and stderr to 16 KiB; hook stdout remains limited to 16 KiB. Larger text/structured results use the snapshot projection above. argv has no implicit shell or variable expansion.

## Hooks

At most 64 unique names, configured as `{name,event,matcher,argv,timeoutMs}`. matcher is an exact tool name or `*`. Hooks run in order without recursion.

| Event | Response |
|---|---|
| PreToolUse | After input validation, allow/block or updatedArguments; rewritten input is validated again |
| PostToolUse | After confirmed success, allow only; cannot rewrite results or undo effects |
| PostToolUseFailure | After confirmed failure, allow only; no automatic retry |

Input is one `{event,threadId,turnId,callId,tool,arguments,result}` line. Output may contain decision (default allow), reason and updatedArguments. Initial rejection, pre-hook blocking and UNKNOWN skip post hooks. Tools and hooks have separate journals, so a crashing post hook does not erase a confirmed tool outcome. Inspect UNKNOWN before recording acknowledgement.

Client tool hosts own their side effects; TUI/Web do not execute arbitrary callbacks. See [plugins](../design/plugins.en.md) and [MCP](mcp.en.md) for trusted-host boundaries.

<a id="research-agents"></a>
## Optional research agents

An explicit agents entry in extensions JSON replaces default model agent tools with `delegate_tasks/read_agent/cancel_agent`. It is disabled by default and does not change the client spawn_child RPC.

```json
{"agents":{"maxModelRequests":256,"maxToolCalls":512,"maxWorkerModelRequests":48,"maxWorkerToolCalls":96,"workerTimeoutSeconds":1200}}
```

This requires Runtime, separate task scratch and nonzero max_children_per_turn/max_agent_depth. For example, use model_concurrency=4, max_active_turns=4, max_children_per_turn=3 and max_agent_depth=1. Child admission is cumulative per parent Turn and is not refunded; Workers cannot delegate. Model requests (including summaries/completion recovery) and tool budgets are shared for one Engine lifetime with additional Worker caps; restart resets counters. Internal HTTP retries use model settings. This is not an exact global token limit.

| Tool | Contract |
|---|---|
| `delegate_tasks` | `{tasks,wait?=false}`; 1–3 strings or `{prompt}` objects, each prompt ≤16000 characters; returns immediately by default, true waits for all terminal states |
| `read_agent` | `{threadId,waitMs?=0}`; waits 0–60000 ms and returns the current bounded report |
| `cancel_agent` | `{threadId}`; cancels and awaits settlement; repeatable for ended tasks without refunding quotas |

Dispatch returns requested/started/allAccepted, reports[], rejected[], asynchronous and advisory=true/sourceWriter=parent. Partial admission retains all started handles and explains rejected input indexes; zero admission fails. Reports contain actual status, reportKind=final/partial/none, up to 3000 UTF-8 bytes of report, truncation markers, up to 512 bytes of error.message and usage. Child usage is not double-counted in the parent. Only completed Turns yield final reports. Handles control only children created by the current parent Turn and cannot cross Turns/restarts. Parent completion automatically cancels and awaits unfinished Workers.

**Compatibility: omitted wait now means asynchronous dispatch; callers requiring the previous synchronous behavior must pass wait=true.** Worker failures are reported for parent handling; unconfirmed cleanup or persistence still fails the parent.

The parent is the sole source writer. Workers share model settings but have independent context and built-in tools, writing only `workspace://scratch/agent-<thread-id>`. TMPDIR and verification receipts use that directory; Runtime Scope/OS sandbox enforce read-only source access. Workers inherit no command extensions, hooks, client callbacks, MCP or plugins. Full history lives in a separate Thread; source=nativeResearchAgent restores the same permissions. There is no source snapshot isolation or multiwriter merge, so the parent must verify reports and final results.

The model chooses delegation timing, count and content without fixed phases or case-ID branches. Empty scratch for rejected Workers is rolled back using remove_dir only. Admitted scratch retains evidence for caller collection/cleanup; cancellation reclaims execution resources only. See [general](../../core/engine/src/instructions.md), [delegation](../../core/engine/src/agent-instructions.md) and [compaction](../../core/engine/src/summary-instructions.md) instructions.

## Task communication and background workers

Inside Goals/Tasks, ask_user_question supports mode=async: it persists a question in the independent Channel and returns immediately so the model can continue other work. task_channel_read reads messages; task_wait releases the coordinator Turn when no independent work remains; task_spawn creates a worker that survives coordinator Turns and shares the Goal budget. Ordinary agent_spawn remains parent-Turn-owned. Headless never awaits users or human approval, but may wait for workers. See the [Task contract](../api/tasks.en.md) for parameters, permissions and lifecycle.
