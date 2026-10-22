[中文](completion-cache-routing.md) | **English**

# Completion, read refill and Responses routing comparison

The fixed100 development comparison of candidate `1ee7d4ab` failed the combined performance-promotion gate. Both products completed normally and passed frozen behavioral checks in49/50 roots; artifacts passed50/50. Across48 normal-correct pairs covering ten tasks, the task-equal wall ratio is **1.3058**: AReaL remains30.6% slower. Matched reported cache fractions converge, without establishing overall parity. See the [portable aggregate](completion-cache-summary.json).

Earlier repairs were merged as `d283badc`. This change integrates bounded read refill, routing and additional contract fixes with mainline desktop/task/recovery and metering work. The100 task results apply only to the frozen candidate. Integration followups were verified by mechanism regressions, without another100-run task comparison or inherited task-speed claim.

## Method and retained attempts

The same gpt-6.1-sol/xhigh and upstream subscription route run ten tasks, five independent repetitions per arm, with three rolling root slots per arm. Common limits are1200 seconds and160 actual HTTP requests per root; observed input/output thresholds are5M/160K tokens. Missing usage remains unknown, so these thresholds do not establish complete accounting of unobserved consumption. Each product retains its native tool protocol and tool set; Codex code-mode call counts are not directly comparable with flat AReaL calls.

This cohort omits maxModelRounds, while read width4, completionFocus=true and bounded recovery remain explicit experiments rather than GUI defaults. An earlier redundant1024-round configuration adds user-role runtime hints. Its29 admitted roots (AReaL10/12 and Codex17/17 normal-correct) and71 unadmitted cells remain separate, as do four pilot roots and84 short mechanism requests. Failed attempts were never replaced by selected successful reruns.

These ten seen development tasks cover a Web chatroom, durable DAG, existing API, release pipeline, ledger reconciliation, incident evidence, release handoff, knowledge portal, content-addressed backup and offline documentation. Eight explicitly allow or require parallel work. They are neither source-isolated confirmation nor the long-term25%-per-domain distribution.

## Fixed100 results

| Metric | AReaL | Codex |
|---|---:|---:|
| Normal and frozen behavioral checks passing | 49/50 | 49/50 |
| Passing artifacts including abnormal roots | 50/50 | 50/50 |
| Abnormal roots | 1 wall limit | 1 common160-request limit |
| All-root wall median | 779.99s | 585.68s |
| Last child-model response to root exit median | 254.65s | 124.72s |
| Root HTTP request median, not tool rounds | 39.5 | 34.5 |
| HTTP requests | 3420 | 4033 |
| Usage UNKNOWN at exit observation | 59 | 539 |
| Usage UNKNOWN after late receipts | 58 | 539 |
| Final observed input lower bound | 104,760,696 | 86,525,200 |
| Final observed output lower bound | 2,703,246 | 1,887,095 |
| Final observed cached input lower bound | 97,236,480 | 80,244,480 |
| Matched reported cache fraction | 92.82% | 92.74% |
| All observed request-interval overlap median | 1.887 | 2.398 |
| Completed known-usage interval overlap, sensitivity only | 1.891 | 2.006 |
| Original browser checks passing | 8/10 | 10/10 |
| All-artifact equivalent-control reviews passing | 10/10 | 10/10 |

AReaL's offline-document artifact passed, but the final answer encountered broken streams/recovery and the wall limit. Codex's backup artifact passed before hitting the common request cap. Both remain execution failures. One AReaL root produced two completion candidates and one published final_answer; this differs from the older identical-final cancellation bug and still misses the strict completion-candidate gate.

The task-cluster descriptive interval for the48-pair task-equal ratio is1.1083–1.5287; it is not a population or single-fix causal estimate. The earlier10.2% gap used a different revision and1024-round configuration; the historical41% bridge also dropped native protocol headers. Neither is a single-variable before/after speed baseline.

There are zero complete-usage pairs, so precise token savings or dollar ratios are unavailable. Reported reasoning output is1,022,076 versus470,639 tokens, a subset of total output, never additional consumption. Missing requests stay excluded from that decomposition. Reported zero cache-write counters do not establish zero physical writes; cached-input fraction is not a directly observed hardware KV-block hit rate.

The batch took about3h55m. Three-slot utilization is97.58%/98.32%, including end-of-queue idle; median result-settlement-to-refill delay is about1ms. Outer scheduling remained occupied while internal critical paths stayed slower. Request intervals contain network, queueing and late-observed cancellation. Known-complete sensitivity changes the denominator and does not prove useful work. Final-tail time also includes necessary integration checks.

The aggregate contains all ten per-task, five-repeat outcomes. The two original UI failures used ambiguous locators: agent and room IDs can share numeric values, and a selected tag can acquire a leading checkmark. All20 artifacts were reviewed once on unmodified shadow copies with the same send/SSE, filtering, refresh-persistence, empty-state and unsafe-literal assertions. Only control selection changed; all passed. Original failures and screenshots remain. This is not an aesthetic rating.

## General mechanisms and boundaries

| Class | Repair and evidence | Conservative boundary |
|---|---|---|
| Safe reads waiting for a whole batch | Trusted contiguous reads refill free slots between barriers; unmatched global hooks no longer serialize unrelated reads | Global width stays1. Shell, external tools, matching hooks, finite output and repeated-failure gates remain ordered; names or command appearance are insufficient |
| Lost routing identity | Subscription forwarding carries stable identity and the first Turn state; generic Core Responses HTTP also covers custom endpoints with model-build/Thread/Turn/purpose isolation |128 entries per factory,30 idle minutes,8KiB per value; account changes, eviction and late responses cannot contaminate new slots. Unowned calls share no state; body/retry behavior unchanged |
| App data in system prefix | Changed references append as areal_context data rather than each Turn's system snapshot; A→B→A, clearing and historical content remain | A real Core/MCP update test preserves the complete previous request prefix; reintroducing the old insertion fails. This cross-Turn path is outside the single-Turn task cohort |
| Oversized batch handoffs | With durable original retrieval, UTF-8 previews preserve structured lifecycle, source, delivery and cursors and update byte offsets | Previews establish neither full consumption nor acceptance. Oversized metadata uses bounded-original fallback without deleting unknown state |
| Permission-review backoff retaining capacity | permissionReview joins solve/summary's actual-request capacity boundary; backoff releases and retry requeues/accounts | Real Core/Runtime capacity1,503,active-stream and cancellation/no-dispatch checks pass;20s,512-token and no-tool bounds remain |
| Unclear current-environment capabilities | sourceView distinguishes snapshots/shared inputs; networkPolicy uses the same base decision as scope creation | Deny includes local listeners; metadata grants no access. Unsupported isolated/legacy facts remain unknown |
| Late integration and stopping guidance | Explicit experimental guidance prepares finite checks/docs and verifies current integrated source | Combined efficiency gate failed; default remains off. No forced success, skipped checks or shortened final answer |

The earlier feedback-history fix `0b3130e3` remains. Across3200 AReaL and3846 Codex adjacent captured requests, prior input arrays remain exact prefixes, with zero top-level instruction/tool changes. Native Lite definitions can be embedded in input. Short routing probes and this cohort support the observed routing gap; this does not assume identical backend routing for every provider.

Toolchain inheritance, full isolated reports, cancellation receipt consumption, capability/write-set clarity, safe shared leases, solve/summary capacity, Git-aware snapshots and artifact readiness remain from the [previous report](complex-work10-completion-runtime.en.md). Unsettled resources, UNKNOWN or unproven consistency still require conservative leases. Snapshot size/symlink/dependency limits remain. Persistent network recovery is the compatibility default; the local profile is explicitly bounded.

## Validation and rollout

Reconciled Rust targets pass1197 tests with14 ignored; GUI173 pass/3 skip, plus57 provider contract/recovery tests, type checking/builds and real Core/Runtime collaboration smoke. The first full make verify exhausted disk during linking. The second completed the workspace pass but four targets could not execute damaged artifacts. Those outputs were quarantined and rebuilt, only failed targets rerun, and launcher/smoke stages completed. Neither failed full invocation is relabelled as one green make verify; passing long tests were not repeated.

Initial out-of-workspace probe failure, mechanism REDs, App source-mutation RED, download failures and raw Electron resource-signature preflight failure remain. The archive matches the lock-installed npm checksum; the final local package requires separate signing and strict deep verification. No complete upstream resource-signature claim is made for the raw archive.

Transport ownership/state, append-only context, capacity lifetime and structured handoff fixes rely on contract invariants; the integrated runtime does not inherit an overall speedup claim. Performance policies are not widened globally and unseen-source confirmation is absent. The local completion guidance is disabled; existing explicit read width4 remains experimental, with global defaults1/false. Original-workspace protection, installation identity/hashes, configuration and40-conversation migration evidence remain in the private local asset; installed identity comes from its manifest. The actual custom GUI endpoint's cache fraction is unmeasured, so92.82% on the fixed subscription route is not a promise for arbitrary providers.
