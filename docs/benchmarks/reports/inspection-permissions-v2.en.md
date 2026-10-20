[中文](inspection-permissions-v2.md) | **English**

# Inspection child permissions, concurrency and regression evidence

The final design separates responsibility, authority, execution capability and concurrency admission. `inspect/report` assigns analysis and evidence delivery; trusted configuration decides whether sources must be read-only. Runtime verifies enforcement capability, while Core owns capacity, writer exclusion, cancellation and settlement. Enforced read-only remains the default, with explicit inherited authority as a candidate. User-wide configuration and deployment privileges were not changed.

## Comparing the three implementations

The comparison uses frozen Codex 0.163.0, DSH 0.2.0-rc.2 and the actual benchmark launcher, without assuming optional features were active.

| Concern | Codex | DSH | Repaired AReaL boundary |
|---|---|---|---|
| Delegation decision | Model spawn calls under tool/instruction guidance | Model subagent calls with depth and activation admission | Model chooses separable work; no case-based planner or per-task spawning requirement |
| Ordinary inspection permissions | Inherits effective parent Turn sandbox/approval, without universally adding a read-only inspection sandbox | Inherits parent preset/explicit sandbox override, intersects tools and fixes child approval to never | Enforced read-only by default; explicit inherit retains existing parent/Profile limits |
| Role restrictions | May change model, instructions and selected features/tools; role files cannot override parent OS sandbox/approval in this version | Tool filtering and execution policy are separate controls | Profile/allowlist/deny and Runtime policy remain separate; instructions do not claim OS enforcement |
| Read-only guarantees | Parent policy can itself be read-only; a reviewer label does not establish a new child-specific OS boundary | Filtering is sufficient only when every effectful entry point is controlled | Default read-only, existing parent/Profile restrictions, legacy sharedReadOnly and research Agents remain enforced |
| Concurrency | Thread admission, model/execution capacity and tool parallelism have separate ownership | Activation/depth and parallel/exclusive tool scheduling are distinct | Existing capacity remains; inherited inspectors take a writer lease only before potentially writing work |

Codex usefully avoids changing ordinary collaboration authority implicitly. This does not make full-access children universally safer, nor mean every role can configure a separate read-only sandbox. Hiding edit tools or saying “do not edit” cannot guarantee immutability while arbitrary shell execution remains available. Enforced read-only collaboration still needs an actual execution boundary.

The benchmark set AReaL cumulative children per Turn to **3** and Codex Threads to **4**, including the parent. AReaL's library default of 64 was not the effective benchmark fan-out. All three parents used full-access / danger-full-access. The others did not necessarily add AReaL's inspection-specific restriction; their success does not prove they established the same nested read-only sandbox in the failing container.

Sources include Codex [child_config](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/child_config.rs), [role](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/role.rs), and [official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents#approvals-and-sandbox-controls), plus the released DSH [subagent package](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent/v/0.2.0-rc.2) and matching in-process driver. See the [previous report](delegation-admission-repair.en.md) for the original failure chain and creation-lock/quota repairs.

## Implemented policy

```toml
[delegation]
inspection_permissions = "read-only" # default, enforced source read-only
# inspection_permissions = "inherit" # explicit inheritance, no source immutability promise
```

The environment override is `AREAL_HARNESS_INSPECTION_PERMISSIONS`. This startup policy requires a safe service restart to change. Model tool arguments cannot increase deployment authority. Parent and trusted Profile restrictions still intersect; legacy explicit `workspaceMode="sharedReadOnly"` and research Agents are unchanged. See [configuration](../../guides/configuration.en.md#inspection-child-permissions), [design](../../design/multi-agent.en.md) and [Core API](../../api/core.en.md#agent-tools).

| Scenario | Behavior and guarantee |
|---|---|
| Enforced read-only, supported deployment | Child Scope narrows source writes and networking; private scratch remains writable, with real OS enforcement |
| Enforced read-only, unsupported deployment | Reject before child model work, empty Thread persistence or TaskRun worker registration; parent can continue without silent permission expansion |
| Explicit inherit, full-access parent | Adds no inspection-only file/network restriction; logical Scopes, budgets and lifecycle still exist |
| Inherit, already read-only parent/Profile | Existing restrictions remain; unavailable enforcement still rejects admission |
| Writable inherited child using trusted native reads | Model work and read_file, image_read, fs_read/list/stat and search_files can cooperate with parent reads |
| First command, file mutation, ambient tool or hooked operation | Take an exclusive workspace lease until Turn process cleanup and durable settlement |

Shell text alone cannot establish absence of side effects, even for an intended search. Such operations conservatively take the writer lease; not every analysis command is promised parallel execution. Ambient tools named `read_file` cannot impersonate native reads. Lease waits are cancellable; control queries need no ordinary execution lease. Writable inspectors cannot delegate recursively or start services that outlive their Turn.

`read_file` uses a fixed Python helper and is a trusted read entry point; its implementation as a process must not accidentally take a whole-Turn writer lease. Final code and native cooperation tests cover this route, with a same-named ambient callback as a counterexample. A lease survives yielded commands until their descendants settle, avoiding release while background processes can still write.

There is no new planner, model loop, model budget or implicit retry. The model still decides whether coordination is worthwhile. Per-parent creation, post-probe quota checks, shared Goal accounting and cancellation ownership remain covered. Remote effects remain the tool host's responsibility; a workspace lease is not a remote transaction.

## What the Bubblewrap validation establishes

Default local Docker security permits parent commands but denies required namespace setup. Disabling only outer seccomp still fails when the complete sandbox mounts `/proc`; a simplified successful bwrap command is not sufficient evidence.

Using the repository's supported temporary CI-container settings—`seccomp=unconfined`, `systempaths=unconfined`, `apparmor=unconfined`—the full Runtime reads restricted files and rejects source writes. No privileged mode, SYS_ADMIN or global sysctl change is needed. These settings apply only to test containers; the original remote failing container is not claimed repaired.

Both deployment choices therefore remain valid: provide an enforcing backend for hard read-only collaboration, or explicitly inherit existing parent authority for trusted ordinary collaboration without an additional inspection-only sandbox requirement. Inheritance is not a replacement for hard read-only access. Either path rejects unavailable capabilities before spending child model work.

## Validation and live-model scope

Entry points include related config/protocol/engine/server tests, Runtime crates, `make delegation-permissions-smoke`, `make unified-execution-smoke`, Clippy, generated schemas and bilingual documentation checks. Native permission tests cover macOS, default Linux security and a supported Linux sandbox container. Scripted models do not count as live-model task success.

Two previously failing development cases each receive one read-only/inherit trial with fixed root limits: 128 physical requests, 4,194,304 tokens, 32000 output tokens per request, 600 seconds and three children, using gpt-6-astra / medium. Solvers mount only public materials; hidden mechanical checks run afterward, and semantic reviews use anonymous independent contexts. The current subscription route differs from the original Arena gateway; this is not an equivalent rerun of the full 122-task matrix.

The final read-classification refinement receives one additional fixed-budget regression on the same original case. Successes, failures, UNKNOWN, adapter qualification failures and review attempts are retained without replacing original outcomes. Exact results and costs are recorded locally in `validation-summary.json`, `live-summary.json`, per-attempt state, request ledgers and review receipts.

The related Rust matrix passed **612 tests with 10 existing ignores**. After the final read classification and fixture-settlement correction, Engine library/delegation reruns passed **252 tests with four ignores**; these overlap the matrix and are not added as independent tests. Runtime passed **94 tests**, and its TypeScript SDK passed **nine**. Clippy, formatting, schemas and **223 Markdown documents** passed. Each of three native environments covered both permission modes, and existing macOS/Linux isolated delivery, cancellation and restart smoke tests passed.

| Original case | Mode/scope | Terminal | Mechanical and independent semantic | Children | Seconds | Physical requests | Known token lower bound / unknown requests |
|---|---|---|---|---:|---:|---:|---|
| 015-benchmark-report | read-only, paired | completed | both passed | 0 | 210.1 | 10 | 157719 / 0 |
| 015-benchmark-report | inherit, paired | failed | missing outputs, not reviewed | 0 | 105.8 | 7 | 57718 / 1 |
| 011-release-notes | inherit, paired | completed | both passed | 1, completed | 285.7 | 21 | 336367 / 0 |
| 011-release-notes | read-only, paired | completed | both passed | 0 | 187.4 | 11 | 159587 / 0 |
| 011-release-notes | inherit, final-build regression | completed | both passed | 1, completed | 202.2 | 19 | 282231 / 0 |

Across five Solver attempts: **68 physical requests, 993622 known tokens as a lower bound, one unknown request**, and **991.2 seconds** total wall time. The unknown request retains a 163072-token reservation; charged usage including reservations is 1156694 and is not actual total token usage. The single Solver failure was an accepted stream disconnect before any child creation. Both actual children completed, and all five attempts preserved original inputs.

**Eight adapter qualification failures** are retained with no actual upstream model calls; 16 local relay admissions are not physical model requests. Initial semantic reviews returned two UNKNOWN results for missing measured filesystem evidence and one HTTP 502. After uniformly supplying public-input hashes and actual file manifests, the three original submissions and final-build submission each received a valid semantic pass without modifying submissions to satisfy reviews. Early configuration, budget/cancellation-fixture, incomplete-probe, proxy and intermittent MCP reopen failures remain logged. The MCP fixture now waits within a deadline for completed tasks to release the lock; production gains no retry.

The admission defect is repaired, but inheritance has not shown lower resource use. In the original release-notes pair it consumed more time and tokens. The final-build regression neither replaces that unfavorable result nor attributes the difference to read classification. Enforced read-only and optional delegation remain defaults until source-isolated evidence supports policy promotion.

Inheritance is not promoted to default. Unseen-source confirmation and comparable-resource quality/cost evidence are still required. Seen development cases and mechanism regressions neither establish recovery of the 122-task gap nor guarantee the model never delegates low-value work.

## Local macOS tools and convergence

Local child admission and the remote namespace failure are separate mechanisms. Shared read-only children can start on macOS, while system Git and Bash here-documents had runtime compatibility defects. This does not establish that all local child creation fails. The converged implementation combines early capability admission with this report’s default read-only policy, explicit inherit option and deferred writer leases. Inheritance is not used to hide tool failures.

Apple’s `/usr/bin/git` selects a developer toolchain using state outside the sandbox. Resolving the real executable alone still leaves ambient system/user configuration accesses. Runtime now discovers and validates CLT/Xcode Git on the trusted host, allows its fixed executable/resources and isolates ambient Git configuration in restricted execution. It grants neither the complete toolchain nor the user directory. Status, log and diff can read the repository; index/configuration writes remain denied.

Bash 3.2’s [here_document_to_fd](https://github.com/apple-oss-distributions/bash/blob/main/bash-3.2/redir.c) omits `MT_USETMPDIR`; [tmpfile.c](https://github.com/apple-oss-distributions/bash/blob/main/bash-3.2/lib/sh/tmpfile.c) therefore ignores TMPDIR on this path. Environment settings or `/dev/fd` metadata allowances do not repair that branch. Complete macOS Runtime bundles now include separate, SHA-256-pinned Bash 5.3.20 executables for standard Bash/sh entry points and PATH. They run in the same Seatbelt policy, without granting shared `/tmp` writes, rewriting task scripts or replacing system shells. GPL-3.0-or-later licensing, complete corresponding source, patches and the builder accompany the executables. Nested hard-coded `/bin/bash` paths and system shebangs still invoke the system version; use the Runtime entry point or `env bash` when private temporary storage is required.

Changes belong to [Runtime command execution](../../../runtime/exec-native/src/lib.rs), [trusted discovery](../../../runtime/host-tools/src/lib.rs) and bundle assets. Core gains no planner or budget. GUI integrity checks include the shell, license and source, and distribution signing includes the new executables. See [Runtime API](../../api/runtime.en.md#system-tools-in-restricted-macos-commands) and [release requirements](../../development/releasing.en.md).

| Validation level | Observation and scope |
| --- | --- |
| Original-input replay | Read-only Git and here-documents change from failure to success; source writes/network remain denied; shared writers and inherit work within their authority |
| Native isolation counterexamples | Git index/configuration bytes unchanged; small/large here-documents and private scratch work; source and external temporary-file access remain denied; native and narrowed full-access-parent paths covered |
| Core/Runtime children | Default read-only, inherit, shared exclusive writers, isolated delivery and rejection of a writable child under a read-only parent satisfy their contracts; concurrent composition, cancellation and restart pass |
| Real model | gpt-6-astra / medium, explicitly assigned one read-only inspection child; both complete, 7 successful commands, 8 requests, 60581 known tokens, 0 UNKNOWN, 60.7 seconds; source and `.git` bytes unchanged |
| Current workspace | Relevant Core crates: 649 passed, 11 preconfigured ignored; Runtime: 101 passed; packaging: 11 passed; GUI integrity: 3 passed; formatting, Clippy and documentation have separate logs |
| Relocated complete bundle | Both child permission modes pass through Core/Runtime from a path containing spaces, with signatures and source manifests verified. The independent owned/TUI release smoke was terminated by SIGKILL on its first attempt; that launch path was not retried, and complete distribution acceptance remains unproven |

The real-model trial uses a fresh public Git fixture and explicitly requests delegation. It validates execution, not autonomous delegation decisions or benchmark gains. The shared development tree includes other sessions’ work; regression counts describe that workspace. A separate incremental patch and hashes identify this repair. Evidence is archived as `readonly-tools-repair-v1`, retaining the original diagnosis, build failures and package startup failure. The installed GUI remains unchanged; the original Arena image/deployment and 122-task matrix have not been updated or rerun.

## Convergence on the latest main

The converged version starts from main `5ad7c336`, combining capability preflight, per-parent admission and default read-only tool compatibility while preserving upstream participant Scopes, plugin hooks and child-result consumption. Earlier 649/101 counts and the initial TUI failure belong to an older development tree and do not qualify this revision. Terminal startup uses the existing upstream foreground-process-group handoff and restoration rather than a second implementation; search fixtures retain the upstream Python native-launch bridge.

Integration exposed two interaction failures, retained as regressions: executionId-only model receipts require automatic completion to compare the same public view or it requests another final answer; inherited inspectors with frozen plugin lifecycle hooks need the whole-Turn writer lease before sampling because hooks may run before their first tool. Trusted reads without those hooks retain deferred admission. Cancellation must release the lease independently of model coordination.

Capability presentation and request admission are verified separately. Explicit Runtime unavailability hides research read-only creation and narrows ordinary creation to available intent, hiding it when the parent cannot write. Reads, waits and cancellation remain; explicit legacy requests still preflight the final Scope before child model work. Private macOS Bash pins a 15.0 deployment target, checked against actual Mach-O metadata rather than execution on a newer local system.

Arena qualification retains the frozen 122 tasks, Reward and common native adapter, with one run for each original model and only the AReaL package replaced. Task failure retries increase from three to five; normal DONE zero scores are never retried, and per-attempt root budgets and model HTTP retry policy remain unchanged. This provides engineering qualification and descriptive historical comparisons, not independent repetitions or policy superiority. Formal policy claims still require at least five independent repetitions per arm, comparable resources and unseen-source confirmation. This run cannot promote inherit or establish a stable ranking.

The converged source passes **1082 workspace Rust tests with 14 existing ignored tests**, plus Clippy, three desktop schemas, SDK/script checks and GUI resource regressions. A complete macOS bundle relocated under a path containing spaces passes owned release smoke and full-screen PTY checks. Direct Mach-O startup in the native Runtime integration fixture exposed a local launch-path difference; it now uses the system Python parent consistently with the product and existing search fixture. This changes no sandbox, skips no execution and never treats pipe loss as success. Original failures and subsequent qualification are retained separately.
