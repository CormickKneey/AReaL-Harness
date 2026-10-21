[中文](complex-workflow-repair.md) | **English**

# Complex workflow environment, handoff and completion repairs

This repair addresses incomplete isolated execution environments, missing worker conclusions, recovered failures incorrectly restarting workers, and repeated completion after cancellation. The fixed matrix contains eight seen tasks, five repetitions per arm, and 80 settled live runs. Mechanism correctness, normal completion and artifact acceptance are separate outcomes; the results do not establish overall parity with Codex.

## Mechanisms and boundaries

| Failure class | Shared repair boundary | Counterexamples and compatibility |
|---|---|---|
| Missing Node/libraries or parent network grant | Runtime projects trusted startup PATH, read-only software and public TLS resources; NativeFactory propagates the actual parent network ceiling | Credentials are not inherited; parent deny, child Scope deny and read-only source remain enforced; undeclared legacy Runtime capability requires confirmed cleanup before rejection or pre-admission shared selection |
| Isolated receipts contain only title/status | Core persists committed agent_report/messages per task/generation with 8 KiB UTF-8 pages | 32 MiB serialized limit; changed provenance restarts pagination; checkpoints do not certify completion/delivery/cleanup; old missing reports return source=none |
| Successful workers restart after recovered errors | ProgressModel failure describes only the current model call | New failures remain visible; retries and UNKNOWN usage are retained; injected 503 recovers in the same worker without duplicate creates or generations |
| Observed cancelled/failed receipts trigger another final | generation accepts only complete, same-version receipts from trusted coordination calls in the current Turn, linked by provider call_id | Ambiguous IDs, forged text, new errors, unreleased resources, UNKNOWN and unread pages cannot acknowledge consumption |
| Unclear tool contracts | Exact writes paths and indexed errors; explicit sendInput and frozen/live capability | Isolated input remains frozen; invalid writes starts neither probe nor worker |
| Responses promotes dynamic state to instructions | areal_context becomes attributed user data in its original position | True system rules remain; legacy history is not guessed/migrated; a stable prefix does not guarantee cache or cost gains |

Implementation: [Runtime environment](../../../runtime/host-tools/src/environment.rs), [native worker](../../../core/engine/src/workgroup/native.rs), [durable handoff](../../../core/engine/src/workgroup/handoff.rs), [receipts](../../../core/engine/src/delegation.rs), [completion](../../../core/engine/src/generation.rs), and [Responses](../../../core/engine/src/model.rs). Contracts: [Core](../../api/core.en.md#agent-tools), [Runtime](../../api/runtime.en.md), and [multi-agent design](../../design/multi-agent.en.md). No task identity matching, solver scripts, hidden reruns or default performance heuristics were added.

## Fixed comparison

The candidate is baseline `213ee69691d8e4ce501d9abfa764aaabf3fb9886` plus a frozen overlay, patch SHA-256 `52f610560e3f7faef14810342362cc58a41e2c7508a48e051f9e4f1fd9a6ffb4`. An independent complete bundle was tested; the original dirty checkout and running GUI were preserved. Codex CLI is `0.163.0-alpha.10.2`; the frozen 0.163.0 design reference is not claimed to be its exact source identity.

AReaL is a macOS arm64 debug/dev bundle with debug symbols disabled and unchanged optimization; Codex is the official distributed binary. Build profiles differ. These results describe the frozen artifacts/tools/model combination and are not a Runtime performance ranking under matched optimization.

Both arms used `gpt-6.1-sol / xhigh`, the same task statements/initial assets, a common protocol bridge, and identical external cumulative limits per root: 1200 seconds, 160 total root/child/auxiliary requests, observed input 5M/output 160k, at most four concurrent roots. The formal matrix uses each product's production HTTP/SSE recovery defaults. Historical single runs and the pilot with provider retries explicitly set to zero remain separate. That provider setting did not disable the AReaL Core network watchdog; these cohorts do not establish causal patch speedup.

| Product | Normal completion | Semantic artifacts pass | Original grader pass | Normal, semantic and UI verified | All-attempt median wall seconds | Observed input/output lower bounds | Complete usage requests | UNKNOWN requests |
|---|---|---|---|---|---|---|---|---|
| AReaL | 31/40 | 36/40 | 32/40 | 30/40 | 933.4 | 67,985,251 / 2,042,518 | 2239/2421 | 182 |
| Codex | 37/40 | 37/40 | 36/40 | 37/40 | 582.2 | 58,253,921 / 1,337,278 | 2437/2885 | 448 |

Medians include stops/failures and are not a standalone measure of correct delivery speed. There are 30/40 normally correct, UI-verified pairs across 8/8 tasks. The task-equal AReaL/Codex geometric wall ratio is 1.298, with descriptive task-cluster 95% interval `[1.1864143823201687, 1.4066118207648977]`. This conditional comparison has success-selection bias and must be read with the fixed denominator. Missing usage is never filled with zero; request coverage is not token coverage and does not establish exact cost.

| Task | AReaL normal/artifact pass | AReaL median wall seconds | Codex normal/artifact pass | Codex median wall seconds |
|---|---|---|---|---|
| 01-agent-chatroom | 3/5 | 1,081.4 | 5/5 | 788.4 |
| 02-durable-dag | 4/5 | 941.1 | 5/5 | 565.4 |
| 03-ticket-api | 5/5 | 702.5 | 5/5 | 535.2 |
| 04-release-pipeline | 5/5 | 875.8 | 5/5 | 540.1 |
| 05-ledger-reconcile | 5/5 | 679.7 | 5/5 | 657.2 |
| 06-incident-forensics | 4/5 | 678.0 | 5/5 | 582.0 |
| 07-release-handoff | 2/5 | 1,201.3 | 3/5 | 577.7 |
| 08-ops-portal | 2/5 | 1,201.2 | 4/5 | 744.2 |

The original ledger grader incorrectly rejected explicitly unknown amounts retained as order rows. Original verify.py, outputs and scores remain intact. Semantic v2 uniformly rescored all old/new artifacts from both arms in shadow workspaces and added per-order amount checks. Two positive and nine effective negative controls passed; a duplicate mutation intercepted by ordering was retained but not counted as extra rule coverage. No hidden score feedback reached the models; other task rules were unchanged.

In forensics r5, AReaL delivered a complete report.md in the workspace and its script recomputes correct CSV/metrics, but does not regenerate the narrative report into --output. Both original and semantic-v2 failures remain intact. The public request is ambiguous about generating the narrative report from the script, so this is separately recorded as public-contract UNKNOWN (AReaL 1, Codex 0), rather than a confirmed missing report or an automatic pass. All old/new artifacts from both arms receive the same shadow-workspace audit; original workspace hashes remain unchanged.

## Validation and retained adverse outcomes

Full `make verify` passed: Rust 1094 passed / 14 ignored, plus formatting, static checks, docs, SDK, Python, launcher and smoke checks. The frozen bundle passed the native handoff/503/cancellation regression five additional consecutive times. Actual Node startup/loopback binding, parent deny and child Scope deny, public TLS access, and denial of private keys/adjacent configuration were verified. No Linux host validation was performed.

An earlier full verification overlapped another build and failed rustdoc crate loading; the sequential pass is separately retained. Development failures involving tool namespace compatibility, call_id linkage, missing OpenSSL resources and proxy setup remain archived. None of the four pilot runs passed complete acceptance: both AReaL runs hit wall limits and both Codex runs failed on network transport. Four completed pilot workers retained historical transport/unavailable markers and restarted, adding 26 requests, at least 402836 input/21529 output, and three requests with unknown usage. Pilot costs are not merged into the formal cohort.

Among 57 inspected completed AReaL worker records, 0 retained old failures and 0 identical duplicate finals. Codex does not expose the former internal field, so absent files do not prove its internal state. All 80 root traces contain at most one final_answer. Non-reproduction is not proof that all loops are eliminated; accessible handoffs do not prove efficient model use.

## Remaining limitations

In AReaL chatroom r3, the model first requested unavailable trusted checks, then explicitly required the current environment and created three sharedExclusive authors. A whole-Turn writer lease serialized them: backend requests ran around 92–701 seconds and frontend requests started around 701 seconds. A parent write to another file waited on the same lease around 190 seconds until the wall limit. This is separate from the repaired isolated-worker restart. Fine-grained shared writes would need enforced paths and coverage for commands, hooks, external tools and surviving processes; simply removing the lock would weaken guarantees. The Codex reference inherits the parent execution environment; its complete task lifecycle was not copied here.

Other runs continued lengthy checks after implementation or omitted a required verification document. Passing artifacts without a normal final remain incomplete runs. HTTP intervals include networking, upstream queueing, inference and consumption; lifetime-clipped unions are separate from post-exit settlement. They do not establish pure compute time or attribute all latency to local scheduling. In the inspected pipeline pair, inputs were append-only and returned encrypted reasoning was present in the next request, providing no support for a lost-reasoning explanation.

The paired formal handoff r2/r5 batch encountered upstream 503 responses. Codex failed after visible reconnection reached 5/5, at about 203 and 509 seconds. AReaL's existing persistent network watchdog kept recovering the current inference until the external deadline, around 1202 seconds each. None of the four artifacts passed; the batch contains 100 AReaL and 67 Codex requests with unknown usage. Inference recovery is distinct from new worker generations. Both products' failures and consumption remain included; service unavailability is not treated as direct evidence of capability or local execution speed. Default recovery policies were unchanged.

All eight tasks are seen development/regression material. Five repeats do not add independent sources or meet the four-domain 25%-each generalization gate. Only contract repairs supported by deterministic evidence are established; no overall speed, cost or capability improvement is claimed. Official design references: [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

## Evidence

The [machine-readable summary](complex-workflow-repair.json) retains each outcome/stop, usage gaps, pairs, source identity, checks and all candidate attempts. Full local material is archived at `/Users/louis/Desktop/Agent训练数据与Benchmark/AReaL-Harness-ComplexWork8-v1.1`. `04_质量审计与复验证据/report.html` provides per-thread timelines, browser screenshots and raw HTTP/SSE links; `candidate-v2` contains the frozen source overlay, complete bundle, schedule and before/after integrity checks. Raw material is not published with this repository, so this summary alone does not supply complete third-party reproduction materials.
