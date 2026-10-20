[中文](standard122-execution-gap.md) | **English**

# Standard122: execution cores and failure mechanisms across three agents

## Findings

The evidence does not support “AReaL's entire agent loop is worse.” It supports a more specific diagnosis: **a normally terminated execution, successful tool operation, and agent-authored passing check are still too weakly connected to complete delivery. Capability admission, tool-use overhead, and failure recovery also cause identifiable losses.**

Prioritize delivery identity and verification coverage, then delegation capability admission, safe protocol recovery, and browser state/context efficiency. Rewriting Runtime, adding more agents, lengthening global instructions, or increasing default budgets should not be the starting point.

Mechanical-gate adaptation is distinguished from semantic ability: four key citation zeros are triggered by introductory notation explanations, not necessarily factual hallucinations. This is an offline diagnostic. No product behavior, task, or grader was changed; no Solver/Reward was rerun. Coverage comprises the complete platform matrix, document trajectories, and six selectively retrieved final native-state archives, not an exhaustive step-by-step audit of all 1,066 attempts. See the [machine-readable evidence](standard122-gap-evidence.json) and [agent improvement method](../../development/agent-improvement.en.md).

## 1. Identity and evidence limits

The external benchmark is `AReaL-Harness-Standard122-v1.0`, batch `standard122-r3p12-20261019`. These locators refer to external evidence; the raw trajectories are not published in this repository:

| ID | Location |
|---|---|
| E | Benchmark `04_质量审计与复验证据/standard122-r3p12-20261019/` |
| P | Benchmark `02_EnvArena_上传包与线上发布/standard122-r3p12-20261019/` |
| D | `E/documents-trajectory-analysis-v1/` |
| N | `D/normalized/<engine>/<model>/<case>.json`; event numbers are one-based array positions |
| T | `E/tasks/<engine>/<model>/<case>/<first16(sha256(task_id))>/` |
| F | External Excellence package `03_任务源资产/harness-standard102-v1/`, containing frozen launchers and release payloads |

Frozen identities, from `P/execution-protocol.json:5–43`:

- AReaL: source identifier `b775bc25fd2378ad3fccd35a6b1ed20842069d09`, payload SHA-256 `8b6fb337…f31cdb01`.
- Official DSH: `0.2.0-rc.2`, payload `4121e4df…794e8876`. The inspection uses published JS in this payload, not a different local checkout.
- Codex CLI: `0.163.0`, payload `63f06b97…6470fb35`. Source reference is the tag's peeled commit `83086188ae0614bd882818ff1aa23f3194962012`. No reproducible binary rebuild was performed to establish byte-for-byte source/binary equivalence.

AReaL source line numbers below refer to the frozen revision, retrievable with `git show <revision>:<path>`. Current HEAD `92af6f48…` and the substantial dirty working tree are not the tested build. New execution-budget hints or Plan completion review cannot be treated as enabled in this batch.

Actual common root limits were **128 requests, 4,194,304 cumulative tokens, 131,072 request-context tokens, and 32,000 output tokens**, established by native receipts and `F/native-common/shared_runner.py:139–164`, not the obsolete 120,000 in some input contracts. The same model routes and common bridge do not produce identical model inputs. For Qwen, AReaL/DSH use Chat→Chat and Codex uses Responses→Chat; Astra uses Responses→Responses. Spot checks of the same task's first outbound request show medium reasoning effort for all three and identical Qwen sampling parameters. Prompt, tool, conversion, scheduling, and service-time differences remain.

The primary matrix contains 732 Tasks and 1,066 attempts. Six withdrawn-version Tasks are excluded. Only infrastructure failures trigger up to three retries; normal zero scores do not. One logical sample per condition and failure-triggered retries do not establish independent repeated measurements. Preserve the distinction between 700 DONE, 31 HARNESS_FAILED, and one EVAL_FAILED. Automatic scores are not independent semantic/visual delivery approval; consumed sources do not establish generalization.

### An additional metering trap

The archive already identifies 336 historical attempts with unverified bytes and 341 Tasks with unknown total usage. The frozen launcher and actual logs reveal another issue: the bridge log is append-only, while receipt aggregation reads the whole file (`shared_runner.py:140,163–164`). AReaL/Astra `wd-browser-triage` attempt-4 has 337 log rows, four occurrences of `request_number=1`, and receipt requests=334. **334 therefore cannot be interpreted as bypassing a single 128-request root limit or as pure final-attempt consumption.** Duplicate historical downloads, cross-attempt accumulation inside logs, and final native state are separate issues. Total cost, cache benefit, and overall speed rankings are not established here.

## 2. Where the score gap actually lies

### Platform scores with equally weighted domains

| Model / Harness | Browser, 22 | Data, 29 | Documents, 22 | Software engineering, 49 | Overall | DONE / full / normal zero / failed |
|---|---:|---:|---:|---:|---:|---|
| Qwen / AReaL | 82.73% | 83.45% | 72.88% | 57.14% | **74.05%** | 113 / 81 / 24 / 9 |
| Qwen / DSH | 80.00% | 80.92% | 98.18% | 57.14% | **79.06%** | 108 / 87 / 16 / 14 |
| Qwen / Codex | 77.27% | 91.95% | 82.88% | 57.14% | **77.31%** | 120 / 82 / 25 / 2 |
| Astra / AReaL | 65.45% | 83.68% | 80.30% | 59.18% | **72.15%** | 120 / 74 / 27 / 2 |
| Astra / DSH | 65.80% | 85.63% | 81.97% | 65.31% | **74.68%** | 122 / 79 / 26 / 0 |
| Astra / Codex | 68.18% | 91.26% | 87.42% | 65.31% | **78.04%** | 117 / 85 / 20 / 5 |

Failed includes HARNESS_FAILED/EVAL_FAILED, not normal functional zero. Full means platform automatic full score only. Source: `E/final-score-summary.json:63–335`. Domain means and fixed weights were independently recomputed from all 732 rows and matched.

### Domain contributions to overall gaps, percentage points

Positive means the comparator leads; negative means AReaL leads. Formula: `25 × (comparator domain mean − AReaL domain mean)`.

| Comparator − AReaL | Browser | Data | Documents | Software engineering | Total |
|---|---:|---:|---:|---:|---:|
| Qwen / DSH | -0.682 | -0.632 | **6.326** | 0.000 | **5.012** |
| Qwen / Codex | -1.364 | 2.126 | 2.500 | 0.000 | **3.263** |
| Astra / DSH | 0.085 | 0.488 | 0.417 | **1.531** | **2.521** |
| Astra / Codex | 0.682 | **1.897** | **1.780** | **1.531** | **5.889** |

Documents dominate the Qwen gap against DSH; the Astra gap against Codex spans several domains. All three score 28/49 on Qwen software engineering, but solve different sets. AReaL's per-task win/loss/tie counts are Qwen versus DSH 10/16/96, versus Codex 12/16/94; Astra versus DSH 7/14/101, versus Codex 6/19/97. Without repetitions and source isolation, these are not stable significance or general capability rankings.

### Concentrated document zeros

For Qwen, AReaL scores zero and DSH scores one on each of these five cases:

| Case | Observed proximal AReaL failure | Codex score |
|---|---|---:|
| `011-release-notes` | Non-source-ID citation placeholder remains in prose; self-check misses it | 0 |
| `012-apispace-runbook` | Ellipsis citation placeholder remains in prose; self-check misses it | 1 |
| `014-architecture-adr` | Invalid citation placeholder plus an ownership factual error | 0 |
| `015-benchmark-report` | Invalid citation placeholder; delegated checking provides no useful feedback | 1 |
| `bx-doc-controls` | Content checks pass, but the file is written outside the delivery directory | 1 |

The four citation cases account arithmetically for 4.545 overall percentage points. All five account for 5.682 points, **89.82% of the document-domain gap**. This is **score attribution, not a prediction that a regex fix recovers 5.682 points**: 014 has another error and semantic delivery remains independently unreviewed. Do not loosen the grader to erase these failures.

### Measurement sensitivity: format explanations are treated as citations

Inspecting the actual `deliverables.tar.gz` places all four triggers in introductory **citation-format explanations**: `RELEASE_NOTES.md:3` for 011, `RUNBOOK.md:7` for 012, `ADR.md:5` for 014, and `REPORT.md:3` for 015. Examples explain that citations use `[src:资料ID]` or refer to conclusions carrying `[src:…]`. This is not a discovery that four documents use fabricated evidence to support factual claims.

The public `012/public/TASK.md:17` itself explains notation using `[src:资料ID]`. The corresponding local task-authoring source, `object-id-contract-r6/.../012-apispace-runbook/oracle/check.py:13,167–169`, applies its citation regex to the **whole document**, subtracting registry IDs, including format examples inside backticks. This matches the observed errors; the online grader was not rebuilt to prove byte-identical source/runtime provenance.

These cases first establish **output hygiene/strict mechanical-gate adaptation** differences and a contract edge between notation examples and actual citations. Their zeros cannot all be interpreted as factual reasoning failures. In particular, Qwen's 5.012-point gap against DSH is not an equally sized measured real-work quality gap. Preserve original scores and hidden assertions. Evaluate document quality with anonymous, independent semantic review of all three and separately audit treatment of metatext in the gate. Case 014's ownership error and the wrong-directory delivery failure remain independent issues.

## 3. What paired trajectories reveal

### 3.1 The artifact and its agent-authored checker share blind spots

In `N/areal/qwen/012-apispace-runbook.json`, events 30 and 32 fail; subsequent edits repair excerpt/citation-set issues. The event-48 check still covers selected claims/excerpts, and the final answer declares passing checks. The platform identifies an invalid source ID elsewhere in the prose. Cases 011, 014, and 015 exhibit the same local-green/full-document-red pattern.

DSH passes the automatic gate on all four; Codex passes two. The transferable difference is **coverage of delivery constraints and the final verification target**, not a magical semantic validator inside DSH. Evidence: the corresponding assessments in `D/documents-metrics.json`, checking commands, and deliverables in the three N trajectories.

Hypothesis: when the same model writes both the artifact and the check scope, it repeatedly confirms what it already believes. Link public requirements to final artifacts and observed checks, including the complete output set. This does not justify forcing a source-ID checker or another generic review round onto every task.

### 3.2 The verified file and delivered file occupy different locations

`N/areal/qwen/bx-doc-controls.json` event 11 observes the actual template under `/envarena/workspace/inputs`. Events 19 and 31 nevertheless write to `/var/lib/ah-state-…/repo/output/completed.docx`. Event 31 successfully reloads the document and checks controls and preservation; the final answer claims completion. The assessment reports a missing candidate `completed.docx`. The native receipt is also OK, with 15 requests and no exhausted budget.

DSH and Codex both score one. **Validating a correct file is not delivering it to the requested location.** Workspace URIs, actual cwd, private state roots, and scratch can coexist. An invented path containing `repo` does not become the workspace. The shared improvement boundary is an explicit effective working root, relative output paths, and verification of the final delivery set—not a private benchmark-path special case.

### 3.3 Delegation is exposed although execution prerequisites fail

Direct inspection of all 44 AReaL document native-state archives finds:

- Qwen: one parent task creates two children; **2/2 fail**.
- Astra: 22 parent tasks create 24 children; **24/24 fail**.
- All 26 failed children retain `bwrap: setting up uid map: Operation not permitted`, followed by UNKNOWN/execution-failure settlement.

The selected PTY, WAL, and browser archives show the same failure category. This is not unwillingness to collaborate: **the outer evaluation boundary cannot provide the nested native sandbox required by child execution**. Astra delegates more actively and therefore pays creation, failure, waiting, and integration costs more consistently. Parents still achieve 13 document automatic full scores, so child failure is neither a sufficient explanation for every low score nor evidence that multi-agent work is always harmful.

Admit execution against measured capabilities and return an explanatory, side-effect-free unavailable result early. Select a runnable strategy only within existing permission boundaries; do not dispatch when required isolation cannot be satisfied. **Do not silently remove sandboxing, switch to host execution, or expand permissions for scores.** DSH's composable child-task services are a useful interface reference, but this report does not exhaustively audit all DSH child lifecycles.

### 3.4 Protocol failures terminate unfinished work

For Qwen `wd2-swe-http-polling`, AReaL's final native state reports `invalid_tool_call_index: negative … (event 276)`. Its last actions are repairs to its own verification script, without a final answer. Codex scores one; DSH has HARNESS_FAILED/zero. Qwen `tb2-adaptive-rejection-sampler` has only five final native Solve ledger records and ends on a streaming error; the bridge records a read timeout/502, not a functional proof that the algorithm is wrong.

Frozen AReaL retries unaccepted HTTP requests with `max_retries=3`; this is distinct from in-stream completion recovery. `generation.rs:1146–1173` uses a separate counter/configuration, with completion retries defaulting to zero. The correct existing boundary—do not execute incomplete tool calls; discard an unexecuted completion—must not be described as no recovery support at all.

Separate malformed/interrupted unexecuted completions, confirmed tool facts, and unknown side effects. Bounded experiments may recover the first category; the others must not be replayed. A negative index violates the provider/protocol contract; accepting arbitrary indices is not the fix. Codex's Qwen protocol conversion also prevents this pair from being a parser-only experiment.

### 3.5 Browser action success is confused with persisted state

Astra `wd-browser-triage` scores AReaL zero, DSH one, Codex 0.6. After verifying and joining three SHA-256 cold-history segments in AReaL's final archive, the trace contains 76 `run_command` calls. It repeatedly selects similar assignee/priority locators, including eight clicks on the same `P2` locator, without filling `Filter Assignee`. Three compactions occur; the terminal HTTP 400 corresponds to a bridge budget rejection. The original request remains retained in the checkpoint, so “compaction forgot the whole task” is not supported.

DSH explicitly opens a picker, fills its filter, selects, closes, reloads to verify persistence, and submits the result. Codex also reloads but still fails the priority and assignee checks. All three encounter UI-state semantics; DSH finds a persisting action sequence in this attempt.

Hypothesis: full-page snapshots and successful action receipts insufficiently distinguish a changed target field from an action that merely executed. Repeated similar actions need observable state differences. Candidates should use public UI state, target-field before/after observations, and saved-state reloads—not hardcoded business-field workflows or automatic re-clicks after a fixed failure count. This task uses public `browser.py`; the GUI's entire built-in Browser design cannot be counted as tested functionality.

### 3.6 Data/system work: a public fixture is not the input class

Two Astra pairs where Codex scores one and AReaL/DSH both score zero:

- `tbpc030001-drive-persistent-pty-session`: AReaL compiles and manually exercises the implementation, then finishes. Actual failure is a descendant escaping the process group and surviving close. Codex's final trace commands on lines 7 and 14 enumerate `/proc` descendants and clean them individually rather than relying only on `killpg`.
- `tbpc030001-recover-rotated-sqlite-wal-chain`: AReaL verifies that the public database loads, but the final logic still sorts frames by capture number; variants fail WAL frame checksums. Codex's trace lines 18 and 20 already search frame order using checksum chains and commit boundaries, and the final automatic assessment passes. DSH fails with an incomplete committed WAL.

The transferable difference is **deriving invariants and constructing inputs that could falsify the current approach**, not more compilation/sample-success messages. These cases cannot attribute every Codex gain to prompting, and hidden variant feedback must not become product strategy. Reverse control: Qwen `wd2-swe-sse` scores AReaL/DSH one and Codex zero; AReaL performs targeted chunk/usage-frame checks.

## 4. Code-level comparison of the execution cores

All three use a model-driven context → response → tool → history → next-request loop. **More layers, Rust, or more plugins do not themselves explain score differences.**

| Mechanism | Frozen AReaL | Frozen published DSH | Same-version Codex source reference | Explanatory limit |
|---|---|---|---|---|
| Completion | On a no-tool response, check unobserved verification, children, and delivery, then publish FinalAnswer; `generation.rs:680–823` | No tool calls means completed; `agent/turn-stopping` may enqueue context; `dsh-agent-loop/lib/index.js:951–1012,1154–1157` | Combine model follow-up with pending input, then run stop hooks; `session/turn.rs:578–604,713–770` | None is a general answer validator. Lifecycle closure cannot cover omitted business constraints |
| Tools/scheduling | Sequential `for call in calls` within a response; release model permit before tools; `generation.rs:701–707,830–857` | Concurrent parallel-safe groups, exclusive barriers, model-order commits; `index.js:506–640` | `ToolCallRuntime` and capability-based routing | Potentially less serial waiting, but no latency ablation here; do not parallelize dependent writes blindly |
| Tool/model adaptation | 32 named tools in this batch's Qwen document first requests, including history, service, and delegation management | Commonly 24 on the paired task; plugins contribute schema/context; headless explicitly supplies cwd | `tools/spec_plan.rs:125–170` builds from ModelInfo, environment, and policy; 12 named tools in Qwen document first requests, mostly exec_command used | AReaL's larger cognitive surface is an experiment candidate, not proof that fewer tools are always better or that only one tool was exposed |
| Context/compaction | Original user input, recent history, checkpoints, original-result retrieval, net-reduction preflight | Context assembly, system-prompt projection, durable logs, compaction plugin | `compact.rs`, retained tool outputs, token-budget modules; asynchronous compaction also exists in this version | No compaction in 132 document traces; browser evidence is directly relevant, document-gap attribution is not |
| Stream recovery | Distinguish pre-acceptance HTTP retries and completion recovery; no replay of executed tools | Request-error waterfall may choose retry; `index.js:1124–1135` | `responses_retry.rs:58–163` classifies errors, retry allowance, and transport | Borrow classification and safe reconstruction boundaries, not optional unbounded retries or a unilateral budget expansion |
| State/roles | Dynamic budgets, plans, and execution receipts enter context; prefixes may change | Persist request headers, context, and system updates separately; `index.js:1167–1260` | Separate world state, step settings, and resolved model messages | Cache/attention loss is a hypothesis; older offline prefix evidence is not this run's cache efficacy |
| Safety/evidence | Core ownership, Runtime facts, no automatic UNKNOWN replay, retained originals | Durable events, conservative recovery, service composition | Durable rollout, tool runtime, error taxonomy | Preserve AReaL's reliability foundation; it does not automatically imply delivery success |

DSH JS is under `F/native-payloads/dsh/dsh-app/node_modules/@deepseek-ai/`; `dsh-agent-loop` is 0.2.0-rc.2 and its `lib/index.js` SHA-256 is `00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2`. The current repository's older DSH reference or Codex app-server schema version is not the benchmark identity.

Pinned Codex references: [execution loop](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/turn.rs), [tool assembly](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/spec_plan.rs), [stream recovery](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/responses_retry.rs). Optional code paths are not proof of activation in this run.

### Secondary tool risks, not established primary causes

- `fs_read` is byte-oriented. Starting Chinese text at `offset=1` can split UTF-8 and return base64. `wd2-doc-api-playbook` has an observed instance, yet Qwen still scores one. Improve text boundaries without attributing all document failures to it.
- 8192-byte retrieval pages, `nextLine/nextCursor`, file versions, and private scratch increase protocol burden. Case 014 uses a hash as a cursor. Retrievable originals do not prove timely acquisition of the important passage.
- Observe mode in `tools/results.rs:57–170` still permits lossless file-line conversion. Analyze persisted `contentItems`, not raw results as if they were model-visible. The document normalizer does read contentItems. A spot check of `012/sources.json` yields 2,113 UTF-8 bytes, matching displayedBytes; rawBytes=3,058 is not evidence of lossy removal.

## 5. Explanations weakened by counterexamples

1. **Fewer crashes alone is insufficient.** Astra AReaL has two failures versus Codex's five, yet trails by 5.889 points. Normal low scores and verification gaps matter more.
2. **It is not all long context or summarization.** Document traces do not compact. Median Qwen document first prompts are AReaL 9,112, DSH 6,086.5, Codex 8,993.5 tokens. In single-attempt Astra document tasks, Codex's median is approximately 11,025, larger than AReaL's 6,404 despite better results. Prompt length is an experimental variable, not a sufficient cause.
3. **More rounds is not the answer by itself.** Median Qwen document requests are AReaL 17, DSH 20.5, Codex 13; both comparators do better in opposite directions. Continuing until budget rejection can also eliminate delivery opportunities.
4. **More agents do not automatically add verification.** All 26 AReaL document children fail on sandbox setup, supplying none of their intended independent checking. Establish executability before efficacy.
5. **Wholesale imitation is unjustified.** Qwen AReaL leads both on browser tasks, and DSH has more infrastructure failures. Local successes do not prove another overall architecture superior.

## 6. Minimal shared improvements and validation gates

These are design candidates, not implemented or proven score improvements. Preserve Clients → Core → Runtime. Core must not read hidden grading material or embed the case IDs or business answers in this report.

| Priority | Shared boundary and candidate | Counterexample/compatibility | First validation |
|---|---|---|---|
| P0 | **Execution capability admission:** verify required sandbox/file/network capabilities before delegated model work; declarations match measured availability; fail early with explanation | No silent isolation downgrade or host fallback; validate interactive hosts and outer containers separately | Model-free parent-full-access/child-restricted cases, unavailable nested namespaces, cancellation, UNKNOWN; zero dispatches to unavailable child strategies |
| P0 | **Delivery identity:** distinguish effective cwd, workspace, and scratch; align final delivered files with verification paths and versions | Preserve explicitly authorized external paths; do not move arbitrary private files automatically | Different roots/aliases, wrong directories, post-verification edits, async checks, unrelated-state preservation; inspect final files, not asserted paths |
| P1 | **Public obligations → evidence:** let the model maintain concise outstanding requirements and checks as needed; check the complete final artifact and surface uncertainty | No mandatory Plan for trivial tasks; Core owns evidence identity, not business answers | Single-variable development comparisons; missed constraints, false passing claims, delivery quality, and added consumption—not Plan completion alone |
| P1 | **Safe stream recovery:** separate unexecuted completions from committed tools; explicitly bounded candidate for recoverable classes | Do not blindly retry budget 400s or permission denials; no UNKNOWN/confirmed-write replay | Malformed indices, truncation, stream errors, duplicate tool IDs, trailing usage; prove exactly-once effects before equal-budget live A/B |
| P1 | **Compact actionable tool views:** assemble by public capabilities/Profile; separate stable prefix and dynamic state; clarify text/byte APIs | No case-ID routing, hidden permissions, or untested compatibility with existing Responses reasoning sessions | Initial/later schema cost, actual retrieval calls, tool-choice errors, real cache usage, and regression on previous successes |
| P2 | **UI differences and saved-state checks:** expose changed target fields and uncertainty; model decides when to change approach | Not an automatic click retryer; never clear collections or replay UNKNOWN | Unchanged-state failure controls, persisted state after reload, unrelated values preserved, action/request consumption |
| P2 | **Parallel-safe tools and selective delegation:** reference DSH barriers and Codex capability routing for separable work | Dependencies, shared-file writes, and short tasks may regress; all child usage remains rooted | Critical path, integration cost, all-attempt tokens/time, and delivery confirmation—not concurrency count |

The proposed execution state machine is not a hidden extra planner. Retain model decisions while making observation → action → evidence → outstanding requirements → deliverable/blocked facts visible and durable. Separate protocol termination from delivery acceptance. Optional completion checks may validate only public user requirements, not read Reward or treat a preferred title/format as a universal answer.

First fix reproducible contract/environment defects. Then run single-variable development comparisons with equal models, root budgets, permissions, and retry rules, preserving failures and reverse controls. Freeze a proposal before testing new, source-isolated material. These 122 cases and same-source variants are consumed development data, not a fresh confirmation set. Without complete historical usage, do not claim cost or speed advantages.

## 7. Completed checks and unresolved claims

Completed: recomputation of denominators/domain means/gaps from 732 rows and retry counts; aggregate counters from 132 normalized document traces; compaction/child-state inspection of all 44 AReaL document native archives; direct inspection of the main pairs above; read-only retrieval of six final native-state archives with declared-size checks and SHA-256 recording; SHA verification of three browser cold-history segments; frozen AReaL, published DSH, and same-tag Codex source inspection.

The investigation retained external-path permission denials from child inspections and upstream source-path 404/API-rate-limit failures, then used fixed-tag alternatives. Incomplete child reports were not counted as completed audits. Temporary scripts and downloads remain in task scratch; the repository receives only the reports, fingerprints, and aggregates. No product behavior tests or new model benchmarks were run because product implementation was unchanged. Documentation language/link and focused-format checks are separate, not efficacy evidence.

Unresolved: full non-document failure-category frequencies; complete historical attempt bytes; costs and real cache benefits; efficacy of current working-tree mechanisms; independent semantic/visual delivery; recoverable score attributable to any proposed intervention; stable ranking and unseen-source generalization. **There is enough evidence to prioritize repairs, not to promise whom those repairs will beat.**
