[中文](complex-workflow-concurrency.md) | **English**

# Complex-workflow concurrency, shared writes and network recovery

Runtime revision `9a42b9873727e440a0ea07583977961e6324ee44` passed full verification and was installed into the local GUI. Trusted read concurrency, safe shared leases, source projection and both model-capacity layers have mechanism regressions. Verification decisions and complex-workflow tails remain inefficient; overall efficiency has not matched Codex.

The source starts from the actual GUI baseline `213ee69691d8e4ce501d9abfa764aaabf3fb9886` and retains the [previous environment, handoff and cancellation fixes](complex-workflow-repair.en.md). Implementation is on `codex/complex-workflow-concurrency-runtime`. The original checkout's 489 files, two deletions and HEAD are unchanged; its older main was not used to replace the GUI.

## Mechanisms and conservative boundaries

| Problem class | Repair | Scope, counterexamples and compatibility |
|---|---|---|
| Every tool in one response ran serially | Bounded batches of consecutive trusted builtin reads; persist intents in call order first | Only explicitly recognized Builtin file reads, lists, stats and searches. Writes, cursors, process input and unknown backends remain barriers. Hooks and finite output budgets remain conservative; cancellation settles in-flight work and UNKNOWN cannot cross a write barrier. Global width remains 1; this local profile explicitly selects 4 |
| Shared authors held an exclusive lease while waiting for models | Acquire for potential side effects; yield at model-wait boundaries after all managed processes settle; validate the complete shared-tree version before execution | Changed trees return pre-execution CONFLICT for a new model decision, without automatic replay. Active processes, UNKNOWN, cleanup errors, hooks, links, external Git metadata, overlapping state and oversized trees retain exclusion. This is not unconditional per-tool unlocking |
| Snapshots rejected ordinary development repositories | Git tracked files, unignored untracked files and required explicit writes; descriptor-relative ignore handling without Git; separate source and artifact collection | 16 MiB per file, 64 MiB total; the 128 MiB store limit is unchanged. Unignored links, special files and oversized input fail explicitly. Source projection is not the dependency closure or execution environment. Delivery retains baseline/candidate closure and conflict checks without deleting ignored products |
| Backoff held Engine or shared-model capacity | Admit each actual request; release both capacity layers before inner HTTP or outer Core backoff, then queue and account again | Live streams still occupy capacity; summaries use the same control. Cancellation, confirmed tools and Goal UNKNOWN do not trigger automatic replay; missing usage is neither refunded nor zero-filled |
| Recovery lasted too long, or bounded disabled Core recovery entirely | Separate `NetworkRetryMode`; bounded allows at most five Core network recoveries per current solve/summary request, without bypass through completion retries | Persistent remains the global default; this local deployment explicitly selects bounded. Legacy `watchdog_disable=true` still disables Core recovery; HTTP retries are separate. A retry count is not a whole-task wall-clock bound. Explicit Rust `Limits` initializers need the new field or default expansion |
| Candidate manual summaries deadlocked at capacity one | Remove duplicate outer acquisition at the manual entry point; admit at the actual summary request | Introduced in this candidate, found and repaired before installation; failing records retained |

See [tool scheduling](../../../core/engine/src/tools/scheduling.rs), [shared leases](../../../core/engine/src/workspace.rs), [source snapshots](../../../core/engine/src/workgroup/tree/snapshot.rs), [capacity lifecycle](../../../core/engine/src/model/capacity.rs) and [recovery policy](../../../core/engine/src/watchdog.rs). Configuration, protocol and bilingual usage documentation changed with implementation. No policy is selected by task identity, answers or hidden scoring.

The previous six fixes remain: authorized toolchain projection, actual report/check/limitation handoff, consumption of all settled terminal receipts, frozen/live capability descriptions, exact-file write contracts and dynamic round facts outside global instructions. Pilots additionally exposed a trusted-verifier capability mismatch; schema projection now reflects the actual host, and unsupported legacy RPC requests fail before task creation. Worker self-checks are not promoted to trusted acceptance.

The Codex reference snapshot is `014489466a1739c2c563cdfe57880c2c7c8680e3`, inspected for trusted parallelism, read/write barriers and finite recovery. It also contains an optional unbounded-connection-recovery feature, so not every Codex recovery mode is finite. The measured binary is `0.163.0-alpha.10.2`; its exact source identity is UNKNOWN, and the reference snapshot is not represented as that binary's exact source.

## Fixed comparison and every attempt

The original eight prompts remain, with content-backup CLI and offline Markdown publication added. All are seen development tasks, not source-isolated confirmation. Both products use `gpt-6.1-sol / xhigh`, 1200 seconds per root, 160 combined root/child/auxiliary requests and observed input/output caps of 5M/160k. Each product has three rolling root slots, six total; spare slots are not transferred between products. Browser verification uses separate shadow copies outside root slots.

AReaL uses a macOS arm64 debug/dev package with debug symbols disabled; Codex uses its official distributed binary. Build profiles differ, so this describes the actual artifact/model combinations rather than equal-optimization Runtime performance. Ordinary same-UID local comparison is not a security evaluation against malicious hidden-checker discovery.

| Stage | Actual root attempts | Retained outcomes and limits |
|---|---|---|
| Connectivity probes and functional pilots | 6 + 8 | Separate from formal denominators; failures, incorrect probe environments and intermediate candidates retained |
| Original ten tasks, five repetitions per product | 100 | All settled. The shared relay recorded 905 ECONNREFUSED and one ECONNRESET. Fifty-eight roots have direct local-502 evidence and another two streams broke during the same interval. This cannot establish a sufficient five-repeat capability comparison |
| First supplement | 6 | Admission stopped too conservatively on one connection reset. Fourteen more cells were never admitted, not zero-filled, counted successful or substituted for failed cells |
| Final single-repeat confirmation | 20 | Every cell admitted and settled, with integrity verification passing. Kept separate, not presented as five repeats or independent-source confirmation |

There are 140 model-chain root attempts in total and 14 unadmitted cells; an attempt does not imply an observed upstream response or known consumption. In the original formal matrix AReaL completed normally in 15/50 and normally passed behavior in 12/50; Codex did so in 24/50 and 21/50. Old relay logs do not identify which endpoint rejected connections, so local forwarding errors are not directly attributed to the model provider.

The controller originally lacked a persistent-relay-failure circuit and kept filling slots with failures. Admission now stops after three consecutive connection failures without HTTP responses or 5xx responses, resetting on success. Both the overconservative one-reset stop and deterministic three-failure probes remain recorded. This repairs evaluation orchestration, not Agent capability.

## Final twenty attempts

| Product | Normal completion | Normal and behavior passing | Wall timeout | Checker UNKNOWN | Observed input / output lower bound | Unknown-usage / total requests |
|---|---|---|---|---|---|---|
| AReaL | 9/10 | 9/10 | 1 | 0 | 22,540,704 / 597,920 | 28 / 709 |
| Codex | 10/10 | 9/10 | 0 | 1 | 17,116,287 / 352,830 | 134 / 848 |

Both products passed real Chromium checks on their two web tasks, 4/4 in total. The document checker demanded stdout JSON that was absent from the public requirements. Codex's original FAIL remains, with acceptance UNKNOWN rather than additional success credit; frozen assertions were not changed. The earlier ambiguity about regenerating a static incident report through its CLI is likewise retained as UNKNOWN.

Nine pairs across nine tasks both completed normally and passed behavior. The task-equal geometric AReaL/Codex wall ratio is **1.4111**. All-attempt wall medians are 892.1 and 588.5 seconds. This paired statistic has success-selection bias and one repetition per task; it neither replaces fixed denominators nor yields a causal improvement estimate by subtraction from the contaminated old matrix.

There are zero pairs with complete usage. Observed cached-input lower bounds are 4,430,080 and 7,398,272, subsets of input that must not be added again. Exact token ratios, cost ratios and dollar costs are UNKNOWN. Request coverage is not token coverage.

Concurrency was actually used: median request-service overlap factors are 1.98 for AReaL and 2.40 for Codex. Those intervals include network, queuing, inference and stream consumption, not GPU utilization. Original-matrix root-slot utilization was about 99.7%, but busy failing slots do not imply useful output. AReaL's median time after its last child receipt was 183.3 seconds, including necessary integration that cannot all be called waste.

## Native regressions and unresolved behavior

Full `make verify` passed on the final source: Rust **1110 passed / 14 ignored**, fmt, workspace/all-targets clippy, SDK, Python, schemas, launcher, PTY/HTTP/SSE/SIGKILL/trajectory smokes and documentation checks. All 103 frozen runtime files retained their hashes through the final matrix. This establishes mechanism correctness and local diagnostic evidence, not the generalization gate requiring 25% each across four domains.

- Real Core/Runtime probes covered simultaneous shared-author model waits, parent writes, active-background-process lease pinning, stale-command rejection before execution and cancellation settlement.
- With model capacity one, healthy admission delays during failing-request backoff were 69.1 ms and 38.0 ms in solve/summary-related probes, versus about 4028 ms in the old candidate. These are particular fault-capacity probes, not whole-task speedup ratios.
- Two real TCP stream failures after one confirmed mutation recovered successfully; six failures exhausted five Core recoveries. Both paths performed the mutation once. Explicit disable still fails, and UNKNOWN usage remains unknown.
- Isolated Node, authorized networking, secret-read denial, 503 recovery, full-report handoff and canceled terminal receipt regressions passed. Initial loopback probes lacking NO_PROXY timed out and remain recorded separately from corrected-environment passes.

All 17 observed isolated workers completed on one attempt without stale failure latches. Root finals were one each for nine AReaL roots and zero for its timed-out root, versus one each for all ten Codex roots. Detectors found no identical-terminal-page rereads, dynamic-prefix transitions or recursive child spawning. Non-reproduction does not prove that arbitrary Agent loops are impossible.

Long tails remain. The offline document task added fault-boundary tests at 1156.3 seconds and collected a passing 23-test result at 1174.9 seconds, but failed to deliver `verification.md` or a root final before the 20-minute wall limit. Six premature artifact reads were rejected, and one UTF-8 paging offset was invalid. These remain coordination/decision overhead; artifact admission, necessary integration and safety checks were not bypassed to shorten timing. No task-specific prompt, unilateral budget increase or further paid rerun was added.

This development effort also had orchestration inefficiency: the original 100 roots spanned about 80.6 minutes, while the primary development conversation has a separate approximately 6.47-hour record gap with UNKNOWN cause. That gap cannot be attributed to AReaL task performance. Development consumption is separate from both answering products; reasoning is an output subset. Development failures and overhead are retained.

## Actual installation and evidence

The local GUI Core was replaced, restarted and verified: API `areal.core.v1`, state version 15, ready service and no pending configuration. Only `network.retry_mode` and `tools.extensions_file` changed semantically in the local profile. Other configuration is preserved. The GUI frontend remains the existing frontend and is not claimed to share the new Core commit.

All 40 historical persisted conversation files are byte-identical. Canonical full public-history projections from the old Core on a private cold-backup copy and the new actual service match 40/40. The initial object-order-sensitive JSON hash failure and a failed comparison of hot fragments against hydrated archives both remain recorded. The final comparison only canonicalizes object key order, omitting no fields and retaining array order. Cold backups of the old App, configuration and user data remain reviewable and recoverable.

The [machine summary](complex-workflow-concurrency.json) records all three cohorts, native validation, unresolved behavior and deployment state. Full local evidence is under `/Users/louis/Desktop/Agent训练数据与Benchmark/AReaL-Harness-ComplexWork10-v1.0`, with `04_质量审计与复验证据/report.html` as the entry point for attempts, per-thread timelines, frozen patch, Codex source comparison and installation receipts. Full traces are not published with the repository, so complete independent reproduction materials are not claimed. No EnvArena publication or promotion of global performance defaults followed from these development-set results.
