[中文](delegation-admission-repair.md) | **English**

# Delegation admission, concurrency and permission repair

This report records contract repairs and upstream comparisons following the [Standard122 analysis](standard122-execution-gap.en.md). Original scores, failures and budgets remain recorded. The matrix was not rerun, and no overall Agent capability improvement is claimed.

## Failure class and evidence

Across 244 final AReaL native states, all 122 Astra tasks created children: 134 child threads, 132 failures, with Bubblewrap uid-map failures in 121 tasks. Qwen created two children in one task, both failing. Parent DONE does not establish child success. These counters cover final attempts, not complete HTTP attempts or billing.

Core had no case-based automatic spawning rule: the model called agent_spawn. The original guidance led with delegation and only later recommended one writer for small work. Delegating every task conflicts with the intended optional contract; there is no single-variable evidence that wording alone caused the pattern.

The observed path was inspect → sharedReadOnly → narrowed file/network permissions → Restricted Scope → native OS sandbox even under a full-access deployment → unavailable user namespace → failure at the first file tool. Shared children previously started model work before lazily creating their first tool Scope. Only some isolated modification paths probed availability.

Concurrency inspection also found a global creation lock held across slow isolation probes, blocking unrelated parents, and a missing cumulative-limit recheck after a probe could race with the legacy spawn API.

## Controls in Codex, DSH and AReaL

These are source comparisons for the tested versions. Optional mechanisms are not assumed active in the benchmark.

| Concern | Codex 0.163.0 | DSH 0.2.0-rc.2 | AReaL response |
|---|---|---|---|
| Decomposition decision | Model spawn calls; default V1 guidance requires explicit user/applicable-instruction requests and keeps critical-path work local; configured usage hints may override it | Model independent/forked-context tools registered against provider capabilities; encourages concurrent starts of already independent work | Model chooses separable work; Core admits structured intent and actual capabilities, without delegation quotas |
| Creation capacity | Reserves thread slots before creation; optional residency/execution mechanisms | Validates depth and activation admission; defaults maxDepth=1 and maxActiveSubagents=8 | Keeps independent Thread, active Turn, model-request and cumulative-child limits; serializes per parent and rechecks after probes |
| Permissions | Inherits current Turn cwd, approval and sandbox; roles may narrow tools/features but cannot override parent OS sandbox or approval | Captures explicit parent sandbox overrides; in-process paths can inherit full-access presets; approval pinned to never and tool restrictions intersect | Inherits or narrows Profile/tool/budget boundaries; inspection retains narrowed OS permissions, checked before model work |
| Unavailable capability | Configuration/capacity checks precede creation; actual execution enforces permissions | Rejects unsupported provider requirements; children cannot widen scope or repeatedly request approval | scope.check rejects without child model requests or Threads; transport loss and UNKNOWN never justify safe fallback |
| Waiting and cancellation | Control plane tracks owned tasks and execution | Activation/inbox ownership, queues and disposal | Retains parent ownership, released model/tool permits during waits, cancellation and cleanup settlement; TaskRun semantics remain |
| Tools in one response | tool_supports_parallel and read/write locking | Parallel-safe pool plus exclusive barriers, default pool limit 10 | Retains response order and existing cross-task tool slots; read parallelism remains a performance candidate |

AReaL's `Limits::default` allows 32 concurrent model requests, 256 active Turns, 64 cumulative children per Turn and depth 8; deployments may override them. The 64-child limit is neither simultaneous execution width nor a target to fill, and cannot be directly compared with DSH's eight active subagents. These defaults remain unchanged: the evidence establishes admission and locking/quota defects, not a new width that improves equal-budget delivery.

The frozen launcher actually sets AReaL `max_children_per_turn` to **3** and Codex `agents.max_threads` to **4** (including the main agent). The library default of 64 is not this run’s effective fan-out. All three parents explicitly use full-access / danger-full-access. The observed difference is AReaL adding a restricted Scope for inspect; it does not prove the others successfully established a nested read-only sandbox in the same container.

This permission difference explains the failure mode: the other systems do not necessarily create a new read-only OS sandbox for an analysis child. AReaL's explicit isolation lacked matching availability admission. Inheriting parent full-access instead would change the guarantee and cannot silently retain a read-only claim.

Codex's default V1 tool guidance distinguishes requests for thorough analysis from delegation authorization and discourages handing off the immediate blocker only to wait. This is more conservative than AReaL's original opening. Configured usage hints or role prompts may replace it, so the source alone does not establish which description every benchmark request used. AReaL adopts optional delegation, independent work and critical-path principles without a text-based complexity planner or treating child count as a quality metric.

Codex references official commit `83086188ae0614bd882818ff1aa23f3194962012`: [delegation tool guidance](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/handlers/multi_agents_spec.rs), [creation](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/control/spawn.rs), [child configuration](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/child_config.rs), and [parallel tools](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/parallel.rs). DSH references the published [dsh-subagent](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent/v/0.2.0-rc.2), dsh-tool-subagent, dsh-subagent-in-process-driver and dsh-agent-loop packages, including policy capture/composition, resolveChildDepth, activation admission and parallel/exclusive scheduling. The repository's older upstream pin is not substituted for the tested package.

## Implemented shared-boundary repairs

1. **Runtime facts.** Handshake restrictedScopes reflects actual Bubblewrap namespace or macOS Seatbelt probes. scope.check validates parent permissions and narrowed boundaries without creating Scopes or task processes; scope.create and native start still recheck. Unavailable restricted execution does not disable an otherwise working full-access parent.
2. **Early Core admission.** Shared children check their frozen effective permissions before persistence and first model work. Rejection leaves no child Thread, cumulative child allocation or empty scratch. Older Runtimes require an upgrade while preserving parent control traffic.
3. **Concurrency and quotas.** Idempotent creation serialization belongs to each parent; slow probes no longer block unrelated sessions. Isolated reservations recheck cumulative capacity. Existing model/active-Turn/tool limits, exclusive workspace leases and cancellation ownership remain.
4. **Model interface.** Unified model delegation exposes executionId as its single control identity; clients and durable records keep complete identities. Failed spawning returns tool success=false. Reading failed-child evidence does not convert its status to success. Legacy threadId calls remain compatible.
5. **Paths and errors.** Model environment facts and task_state identify workspacePath, workspaceUri, commandCwd and scratchPath. Explicit UNSUPPORTED/permission rejection before Scope creation becomes a nondispatched tool failure. UNKNOWN still stops execution and never replays side effects.
6. **Control plane and consistent policy.** task_state is a Core query and no longer needs a Runtime Scope to inspect local facts. Bounded executionId recovery is separate from client diagnostics. Workspace facts are frozen in the existing instruction snapshot without accumulating each round. Native admission, commands and Linux seccomp share the effective Scope policy, fixing missing syscall filtering when a restricted child inherited a full-access deployment label.

See [Runtime API](../../api/runtime.en.md#permissions-and-deduplication), [Core Agent tools](../../api/core.en.md#agent-tools), [delegation design](../../design/multi-agent.en.md) and [tools](../../guides/tools.en.md).

## Verification levels and limits

Model-free regressions cover side-effect-free rejection of unavailable restricted scopes; usable full-access parents; no permission expansion; older Runtime compatibility without transport loss; zero child model requests and no child Thread/empty scratch; idempotency; cross-parent progress during probes; legacy-spawn races against isolated reservations; model control using executionId alone; and observable workspace facts after known admission rejection. Existing ownership, cancellation, depth, waiting, UNKNOWN and real macOS sandbox tests are also checked.

Entry points are `cargo test --locked -p areal-engine`, the Runtime crate tests, `npm --prefix runtime/sdk-typescript test`, all-targets Clippy for relevant crates, unified native delegation smoke, and `python3 scripts/check-docs.py`. Local evidence retains all attempts and failures. Native negative cases inside an outer Linux container require an available Docker/CI environment; passing macOS does not replace them.

Final Core regressions pass 466 tests with ten originally ignored tests; Runtime passes 81 and the TypeScript SDK passes nine. Formatting, Clippy, machine schemas and bilingual documentation checks pass. The macOS native smoke verifies concurrent isolated-candidate composition and delivery, contract rejection and cancellation cleanup, and identity/receipt recovery after restart without live model calls. Ignored tests include explicit model replays, capacity/disk benchmarks and native Workgroup tests requiring extra configuration; they are not counted as passes.

Integration verification also supplies the missing response schema for the existing server/recovery API so strict clients can complete capability validation. Loopback HTTP fixtures preserve existing NO_PROXY entries and add localhost/127.0.0.1 as required by the development guide. Initial proxy timeouts, cache mismatches and failed repair attempts remain in the evidence.

Independent-check guidance uses the existing opt-in execution_tracking candidate: derive independent expectations or small examples and reopen the complete final deliverable set. Path facts, capability admission and quota invariants are contract repairs. Task benefits of model guidance and parallel performance strategies still require equal-budget development comparisons and source-isolated confirmation. No claim is made that all verification blind spots are eliminated or that the 122-task score gap is recovered.

Equivalent public browser-bridge access is an evaluation configuration revision that must give all three harnesses the same protocol and version. Frozen tasks, hidden graders and unilateral budgets were not changed. Complete retrieval, CAS, UNKNOWN, no automatic replay and permission narrowing remain intact.
