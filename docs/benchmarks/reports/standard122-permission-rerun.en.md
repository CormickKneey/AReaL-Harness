[中文](standard122-permission-rerun.md) | **English**

# Standard122 after permission repairs

PR [#96](https://github.com/areal-project/AReaL-Harness/pull/96) merged the admission, concurrency and local-tool repairs. The immutable Arena candidate uses source `0831f3d060ad84cfa8b4e007c4be612c066e1243`; the production paths match merged commit `e5c07f25b07772bead92fae821d12ac79f776082`. The later commit changes only a package-layout test. All applicable merge checks passed. This report records one independent run for each of the two models and 122 cases, plus failure retries. It is a descriptive historical comparison, not evidence of stable ranking or generalization.

## Frozen execution

The 244 formal tasks use the original case/Reward references and common native adapter, with 12 concurrent tasks per Job. Only AReaL was rerun; DSH and Codex are historical results. Failure retries increased from 3 to 5, allowing at most 6 attempts. DONE with score zero never triggers a rerun. Each attempt keeps the original 128 physical model requests, 4,194,304 known-plus-reserved tokens, 131,072 context window, 32,000 output limit, model HTTP retry policy and case deadline. Failures remain zero in the fixed denominator. Each of four domains contributes 25%; tasks are equally weighted within each domain.

## Platform scores

| Model | Harness | Final | First attempt | First four attempts | DONE | Normal zero | Terminal failure | Retried cases | Attempts |
|---|---|---|---|---|---|---|---|---|---|
| astra | AReaL final | 80.51% | 78.24% | 79.38% | 122 | 23 | 0 | 3 | 128 |
| astra | areal previous | 72.15% | 61.16% | 72.15% | 120 | 27 | 2 | 19 | 150 |
| astra | dsh previous | 74.68% | 59.63% | 74.68% | 122 | 26 | 0 | 24 | 149 |
| astra | codex previous | 78.04% | 41.32% | 78.04% | 117 | 20 | 5 | 65 | 246 |
| qwen | AReaL final | 72.78% | 61.90% | 71.92% | 114 | 26 | 8 | 24 | 191 |
| qwen | areal previous | 74.05% | 64.16% | 74.05% | 113 | 24 | 9 | 24 | 175 |
| qwen | dsh previous | 79.06% | 64.53% | 79.06% | 108 | 16 | 14 | 35 | 197 |
| qwen | codex previous | 77.31% | 69.69% | 77.31% | 120 | 25 | 2 | 16 | 149 |

The first-attempt view assigns zero to cases that retried after failure. The first-four-attempts view assigns zero when the eventual final attempt is later than four. These describe observed attempts and do not simulate old policy or remove route/load drift. Final status counts belong only to the final-score column.

| Model | Delta from old AReaL | Improved | Regressed | Equal | Cases beyond four attempts | Contribution after attempt four |
|---|---|---|---|---|---|---|
| astra | +8.36 pp | 21 | 4 | 97 | 1 | 1.14 pp |
| qwen | -1.27 pp | 15 | 16 | 91 | 9 | 0.86 pp |

## Domain detail

| Model | Harness | Software (49) | Browser (22) | Documents (22) | Data (29) |
|---|---|---|---|---|---|
| astra | AReaL final | 63.27% | 69.09% | 99.24% | 90.46% |
| astra | areal previous | 59.18% | 65.45% | 80.30% | 83.68% |
| astra | dsh previous | 65.31% | 65.80% | 81.97% | 85.63% |
| astra | codex previous | 65.31% | 68.18% | 87.42% | 91.26% |
| qwen | AReaL final | 61.22% | 75.45% | 79.39% | 75.06% |
| qwen | areal previous | 57.14% | 82.73% | 72.88% | 83.45% |
| qwen | dsh previous | 57.14% | 80.00% | 98.18% | 80.92% |
| qwen | codex previous | 57.14% | 77.27% | 82.88% | 91.95% |

## Mechanism acceptance

Local macOS child creation was functional; Git toolchain discovery and Bash 3.2 here-document temporary-file compatibility were separate execution defects. The final implementation keeps the native read-only boundary, pins trusted Git resources and distributes Bash 5.3.20 with corresponding sources. Git/source writes and outside/network negative controls still follow each mode. Hard-coded `/bin/bash` remains the system shell. Native permissions, cancellation/restart, real collaboration, GUI, relocated release bundles and install/upgrade checks passed; see the [design and validation report](inspection-permissions-v2.en.md).

Arena retains default enforced read-only. Runtime reports whether the effective restricted Scope can actually execute; Core hides unavailable delegation and rechecks explicit creation before child model work. No default elevation was enabled. An unavailable deployment is not repaired into a sandbox-capable host by hiding a tool, and no started children means that a child success rate is undefined.

| Model | Verified final states / tasks | Missing | Capability unavailable | Started children | Failed children | Interrupted | Unsettled | uid-map error receipts |
|---|---|---|---|---|---|---|---|---|
| astra | 122/122 | 0 | 122 | 0 | 0 | 0 | 0 | 0 |
| qwen | 122/122 | 0 | 122 | 0 | 0 | 0 | 0 | 0 |

Previously Astra created children on all 122 cases: 134 child threads, 132 failed, and 121 cases with uid-map errors. This run measures capability admission; it does not show that models autonomously choose delegation better when it is available. The per-parent creation lock, post-probe quota recheck, optional inheritance and writer leases are covered by mechanism regressions. The model retains decomposition decisions; Core does not dispatch by case identity or target a child quota. DSH/Codex comparisons and scope guarantees are documented in the [admission report](delegation-admission-repair.en.md).

## Costs and incomplete evidence

All eight terminal failures are Qwen cases: two output-length limits, four local root-budget rejections and two native timeouts. These are observed terminal conditions, not isolated causal attribution. No child started in any of them. Cumulative receipt budget flags are not used to attribute a rejection to a particular attempt.

| Model | Case | Attempts | Observed terminal stop |
|---|---|---|---|
| qwen | tb2-adaptive-rejection-sampler | 6 | output_length_limit |
| qwen | tb2-mailman | 6 | root_budget_rejected |
| qwen | tb2-make-mips-interpreter | 6 | native_timeout |
| qwen | tb2-schemelike-metacircular-eval | 6 | output_length_limit |
| qwen | bx-browser-priority | 6 | native_timeout |
| qwen | bx-browser-dependencies | 6 | root_budget_rejected |
| qwen | bx-browser-subtasks | 6 | root_budget_rejected |
| qwen | bx-browser-import | 6 | root_budget_rejected |

| Model | Attempts | Known request lower bound | Known token lower bound | Tasks with incomplete usage |
|---|---|---|---|---|
| astra | 128 | 2674 | 70929417 | 8 |
| qwen | 191 | 7065 | 246990046 | 24 |

Verified request records are deduplicated and assigned to unique platform attempt intervals. A final log can contain earlier retries; receipt totals must not be blindly summed. Earlier request recovery does not restore missing native-state bytes. The budget audit observed no limit violation in verified records; unknown coverage remains explicit. Historical artifact downloads can return final bytes for earlier attempts; original data and one bounded read-only supplement are preserved. Full-attempt byte coverage and complete historical cost are not claimed. USD is unknown without a price table.

| Candidate qualification | Tasks | Known token lower bound | In formal score |
|---|---|---|---|
| v1 | 2 | 550144 | No |
| v2 | 2 | 946607 | No |

V1 was retired after TLS dependency and durable-identity corrections; its two qualification results remain. V2 requalified without using scores as a gate. The shared workspace also showed an independent atomic-write compatibility symptom: a nobody-owned sticky directory, uid0 with capabilities dropped, EPERM from conditional replacement, and successful shell overwrite. This is consistent with [Linux rename sticky-directory restrictions](https://man7.org/linux/man-pages/man2/rename.2.html), but the exact failing syscall was not traced. No CAP_FOWNER grant, sticky-bit removal or silent non-atomic fallback was added for scoring; the case also had functional/self-check failures, so its zero score cannot be attributed solely to permissions.

## Interpretation and evidence

The distribution has been consumed during development, there is one independent sample per model-case, and retries are not independent repetitions. Only AReaL ran now, versus three historical Harnesses; provider contention differs despite equal per-Job concurrency. Historical model aliases do not fix actual route/weight identity. Main includes other fixes besides the permission change. These factors preclude isolated causal attribution or default-policy promotion. Platform automatic scores are not independent semantic/visual acceptance. Formal superiority requires the repetitions and source isolation in the [methodology](../methodology.en.md).

Both model-route configuration fingerprints match this run before/after and the historical r3p12 preflight snapshots. Actual weight bytes are not available; route drift is not established as the cause of the measured differences.

The [portable JSON](standard122-permission-rerun.json) includes exact scores, per-case improvements/regressions, source/package binding and audit boundaries. Raw traces are not published in this repository. The private archive is `AReaL-Harness-Standard122-v1.0/04_质量审计与复验证据/finalization-arena-v1/candidate-v2`. Original failures, UNKNOWN and extra qualification overhead remain there.

Harness: `standard102-native-areal@1.1.0-5a8b6d192fe5`; SHA-256: `da6effdb801aad675e6baa50458c1edacb9e902db396373596ee7e5888833897`.

The live GUI dependency audit also required Vite 7.3.7 and MCP client/core 2.3.0. See the [MCP advisory](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) and [Vite advisory](https://github.com/advisories/GHSA-587h-7wmj-h5pm). Core/Runtime source-input hash remains `46659ac6a0834207e30437023ddba531b55671a7351ae08ba305824aa309ce44`; the immutable Arena payload was not changed. GUI audit, type checking, production build and 109 public checks passed, with three original skips. This follow-up changes GUI dependencies only and does not substitute a new solver or reselect benchmark samples.

### Arena Jobs

- [astra / swe24](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-swe24-2610210432)
- [astra / terminal12](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-terminal12-2610210432)
- [astra / transfer8](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-transfer8-2610210433)
- [astra / files41](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-files41-2610210433)
- [astra / browser17](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-browser17-2610210433)
- [astra / workday20-browser5](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-workday20-browser5-2610210433)
- [astra / workday20-files14](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-workday20-files14-2610210433)
- [astra / workday20-script-object1](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-astra-workday20-script-object1-2610210433)
- [qwen / swe24](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-swe24-2610210433)
- [qwen / terminal12](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-terminal12-2610210433)
- [qwen / transfer8](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-transfer8-2610210433)
- [qwen / files41](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-files41-2610210433)
- [qwen / browser17](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-browser17-2610210433)
- [qwen / workday20-browser5](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-workday20-browser5-2610210433)
- [qwen / workday20-files14](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-workday20-files14-2610210433)
- [qwen / workday20-script-object1](https://arenaonline-prod.alipay.com/jobs/s122-af5v2-formal-qwen-workday20-script-object1-2610210433)
