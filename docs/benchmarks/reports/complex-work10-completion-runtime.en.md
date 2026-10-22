[中文](complex-work10-completion-runtime.md) | **English**

# Complex-workflow completion, artifact readiness and policy inheritance

Runtime `41805761f94c080a4aa81383a501fccc8d7548e6` passed mechanism regressions and a fixed100 development comparison and was installed in the local GUI. Across43 pairs where both products completed normally and passed functional checks, the task-equal geometric wall-time ratio is **1.1018**: AReaL remains about10.2% slower. Long tails remain:2/50 AReaL roots reached their wall limit despite passing artifacts. See the [portable aggregate and all100 cells](complex-work10-v1.1-summary.json).

The relay behind the previous “41% slower” result discarded native Codex protocol and routing headers. That result cannot serve as a reliable native causal baseline. This experiment does not establish an improvement “from41% to10.2%.” Original results, invalidated attempts and failures are retained.

## Mechanisms and boundaries

| Issue | Implemented behavior and evidence | Conservative boundary |
|---|---|---|
| Serial calls within one model response | Bounded concurrency for trusted native reads; local width4; isolated workers now inherit the parent's pure `ToolPolicy`, fixing parent4/child1 divergence | Compatibility default1; writes, Shell, process input, cursors, external namesakes, hooks and bounded-output gates remain barriers |
| Whole-turn shared-writer exclusion | Previous repair yields the lease at model-wait boundaries after safe snapshot/CAS and managed-resource settlement; regressions retained | Active processes, unknown effects or unproven consistency retain exclusive access; no blind per-tool unlocking |
| Capacity held during network backoff | Solve, summary and shared-model calls acquire capacity per actual attempt and release before backoff/requeue; healthy requests enter with capacity1 | Persistent retries remain the compatibility default; local bounded mode is explicit; HTTP and stream recovery have separate budgets; unknown writes are not replayed |
| Repository snapshot limitations | Git-aware source projection preserves tracked/unignored dirty source and explicit write sets while excluding ignored build products | 16 MiB per file/64 MiB tree; symlinks, excessive trees and environment dependencies may still reject isolation or conservatively share; not a full environment clone |
| Missing Node in isolated workers | Trusted toolchain paths and necessary execution resources retained; real Node/localhost regressions pass | Parent credentials and the entire environment are not copied |
| Incomplete child handoff | Full reports, checks and limitations with provenance and UTF-8 paging;16-task batches compact duplicate metadata before truncation while keeping original text retrievable | Preserve actual text, failures, cleanup, verification and delivery; maintain legacy single-receipt projections and necessary integration checks |
| Repeated completion after cancellation | Consumption covers settled cancelled/failed/interrupted outcomes; no identical repeated final answer in50 AReaL roots | Acknowledge only completely observed content; late results and cleanup changes can still wake the coordinator |
| Frozen capability/write-set ambiguity | Capabilities reflect execution strategy; schema and preflight errors require exact relative file paths; no frozen-contract rejection observed here | Immutable isolated contracts remain immutable; rejected admission is not a failed child |
| Dynamic-round prefix mutation | Dynamic reminders stay in runtime context; zero observed prefix transitions | The historical defect required explicit configuration; not a claim about every GUI default |
| Premature artifact reads | Advertised capability and current readiness are separate; `artifact.available` and byte access share a predicate; not-ready returns `ready:false` with a next action | Cleanup, strict verification and provenance checks remain required; zero premature calls here |
| Repeated reads/wakeups | `receiptVersion` and `agent_wait_any.after/nextAfter` skip unchanged settled receipts;103 versioned waits and zero detected same-terminal-page rereads | A cursor does not acknowledge report text; new text/errors/delivery/resource settlement cannot be swallowed |
| Completion tail | Explicit `completionFocus` covers required deliverables, concern-driven checks, independent work before waiting and timely child handoff | Globally false; locally enabled experimental policy;2 timeouts remain; no forced success, skipped verification or extra budget |
| Dropped subscription controls | Provider preserves `parallel_tool_calls` and explicit text controls, fills catalog-declared defaults, invalidates account/catalog caches and rejects stale revisions | Historical samples already used `all_turns` on both sides; no reasoning-mode speedup claim. New verbosity is low on both sides; old AReaL was medium |

Implementation entry points: [generation/capacity](../../../core/engine/src/generation.rs), [context/static prefix](../../../core/engine/src/context.rs), [collaboration receipts](../../../core/engine/src/agents.rs), [pure-policy inheritance](../../../core/engine/src/workgroup/native.rs), and [provider encoding](../../../clients/gui/packages/chatgpt-provider/adapters.js). See the [Core contract](../../api/core.en.md) for compatibility. Behavior is selected by public capabilities, lifecycle and explicit settings, without task identifiers, fixed business content or private-path branches.

## Codex reference and measurement validity

Reference source is pinned to `014489466a1739c2c563cdfe57880c2c7c8680e3`. Its `codex-rs/core/src/tools/parallel.rs` uses declared parallel support, read/write locking and cancellable admission; `tools/handlers/multi_agents/wait.rs` uses `FuturesUnordered` to observe the first terminal result. AReaL adopts explicit safe classes, ordering barriers and result-driven waits while retaining durable intents, cleanup and UNKNOWN constraints. Shared-write consistency is not identical to Codex's working-directory strategy.

The measured CLI SHA256 is `1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe`; its exact compiled correspondence to the cached source is **UNKNOWN**. Code-mode internals and child events are not fully symmetric observations; missing records are not zeros.

Capturing the actual CLI established that the old relay dropped `x-openai-internal-codex-responses-lite`, session/thread and other native headers, plus bidirectional turn-state routing. Eight old-relay roots and admission probes remain separate; no score-selected replay occurred. The corrected relay preserves native bodies, protocol/routing headers and SSE bytes, overrides authentication in the trusted layer, removes hop-by-hop and invalid decoded length/encoding headers, and adds no implicit retries. Three header-contract and two real HTTP wire checks preceded live admission on both sides. Actual transport failures and capacity rejections still occurred in the fixed100; this is not a zero-fault claim.

Both sides use `gpt-6.1-sol`, `xhigh`, low verbosity and default service tier. Ten tasks, five repeats each, three rolling root slots per arm and1200 seconds per root; independent checkers do not occupy root slots. Failures are not replayed and budgets are not expanded for one arm. All tasks are seen development tasks; repetitions do not establish source isolation.

## Fixed100 results

| Metric | AReaL | Codex |
|---|---:|---:|
| Admitted/planned | 50/50 | 50/50 |
| Normal and functionally correct | 48/50 | 45/50 |
| Abnormal executions | 2 wall-limit stops | 5 upstream model-capacity rejections |
| Passing artifacts, including abnormal roots | 50/50 | 48/50 |
| Functional checker UNKNOWN | 0 | 0 |
| Original browser probes passing | 8/10 | 8/10 |
| Equivalent locator reviews passing | 2/2 | Not rerun; both roots already failed |
| All-root wall median | 838.51s | 714.96s |
| Normal-correct wall median | 819.79s | 738.54s |
| Model-service overlap median | 1.72 | 2.34 |
| Last child-model response to root exit median | 361.77s | 126.13s |
| Requests | 2768 | 3883 |
| Requests with UNKNOWN usage | 130 | 636 |
| Observed input-token lower bound | 70,317,847 | 77,239,153 |
| Observed output-token lower bound | 2,044,927 | 1,726,472 |
| Observed cached-input lower bound | 14,199,808 | 71,082,752 |

The two AReaL browser reviews only add support for legal `select` tag controls. On shadow copies, the original search/tag intersection, reload persistence, empty-state and literal unsafe-text assertions pass. Original failures remain; candidate tree hashes are unchanged and no model root is replayed. One reviewed root remains a timeout. Three capacity-rejected Codex roots have passing artifacts and still count as execution failures.

The43 normal-correct pairs cover ten tasks. Task-equal geometric wall ratio1.1018 has a descriptive task-cluster95% interval1.0220–1.1861; pair-equal ratio is1.0805. The nine tasks shared with the historical sample have task-equal ratio1.0863. Selected passing pairs do not replace the full50-attempt outcome denominators. These intervals do not establish four-domain generalization or a single-component causal gain.

There are zero complete-usage pairs. Missing usage remains UNKNOWN; observed totals are lower bounds, not exact cost or token-saving ratios. Twelve excluded development/admission roots and112 short probes, including seven unknown-usage requests, are accounted separately. Intermediate failing tests and initial probe failures are retained.

## Remaining gap and elapsed evaluation time

Three-slot utilization is98.81% and98.04%, with about1ms median between settled root results and replacement admission; observer settlement inside a root is not hidden by this metric. The formal matrix took about3h54m; AReaL's three-slot span is14016s and Codex's11990s. Stable-route capacity probes selected three slots; probe failures remain. The experiment ends at its fixed100 denominator instead of opening another batch because of a slow tail.

Remaining internal differences are visible in lower AReaL service overlap and longer tails after the last child response. Portal repeat2 passed browser checks at1068s, then drafted a4703-byte verification report, repeated nine HTTP tests, loaded a screenshot late and requested a metadata plan update. That request had no complete terminal before the deadline. Offline-document generation repeat4 also reached the wall limit. Neither has a normal final answer; these are not the fixed duplicate-final consumption bug.

The traces support earlier document/verification work, less unnecessary rechecking and fewer late metadata rounds. Necessary integration verification is not all waste. Service intervals include network, upstream queueing, inference and stream consumption; pure compute and workspace-lock time cannot be separated reliably. The completion policy has not eliminated tails and is not promoted to a global performance default.

## Validation, installation and preservation

Final-source `make verify` passes1113 Rust tests with14 ignored and201 paired Markdown files, plus provider contract/recovery/account-session regressions. Real isolated workers cover Node, necessary environment, pure-policy inheritance, full paged handoff, parallel delivery and cancellation. Real HTTP fixtures cover capacity1 healthy admission during fault backoff, summary capacity, bounded stream recovery and no replay of unknown tool results. Two intermediate full-check failures and an initial capacity-probe timeout remain. Packaging follows the final successful verification.

The local GUI replaces only the frozen Core and three provider files inside the archive; the other7756 regular files retain their contents. Strict deep verification of the local ad-hoc signature passes; no Developer ID or notarization claim is made. Normal quit precedes cold backup, configuration-byte CAS and atomic replacement. Checks then confirm a new service generation, actual process path, all Core manifest hashes, provider archive hash and applied configuration.

The local explicit profile uses read width4, bounded network recovery and `completionFocus=true`; existing extensions are merged and global defaults remain unchanged. The original workspace HEAD and491 existing states are preserved. Forty conversations and1346 durable files remain; old Core reading the cold backup and new Core reading actual data produce identical complete public projections for all40.

Initial hot pre-install versus restarted public hashes differ for40 threads; the precise origin is **UNKNOWN**. The old Core reading the cold backup also differs from those pre-install hashes. Both the initial failed assertion and complete follow-up comparison are retained. Identical durable bytes and matching old/new reads support preservation, not a claim that hot-state projections never changed.

The private evidence asset `AReaL-Harness-ComplexWork10-v1.1` contains100 trajectories,50 paired timelines, HTTP/SSE, original and review screenshots, the fixed plan, frozen manifests, failures/UNKNOWN, cold backups and install receipts. This repository provides portable aggregates rather than complete independent replay materials. The report commit is documentation-only; running bytes remain the validated `41805761` build.
