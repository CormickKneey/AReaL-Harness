[中文](codex-plugins-p2-acceptance.md) | **English**

# Codex plugin P2 acceptance matrix

Candidate evidence captured 2026-10-14 against Codex0.162.1 / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`, P2 was committed as `6c3de0a`; this separately approved read-only follow-up is based on that revision. Runtime manifests bind source-file/diff and Core binary hashes. P0 and [historical P1/P3 evidence](codex-plugins-p1-p3-acceptance.en.md) remain separate. **P2 and full compatibility are open.**

## Current matrix

| Requirement | Evidence | Status / remaining |
|---|---|---|
| Original declarations, overlay, matcher/alias, typed MCP templates | Package37 pass, including hooks5 and sources4 | Local pass; no Windows device |
| Cumulative user/project JSON/TOML and global gate | Actual Core requires independent review; no package environment in config hooks; user hooks=false gates both | Local pass; managed/profile/session stack incomplete |
| Independent trust, CAS, revoke, visible review | Stale digests reject; real Electron shows commands/digests, consent gate and original-receipt recovery | Source desktop10 pass; separate read-only consent; no distribution |
| Pre deny/exit2/rewrite and Post effect preservation | Actual Runtime write/denial assertions and output6 checks | Local pass; full native file-input mapping not compared |
| PermissionRequest independent of Pre | Actual allow/deny without tool_use_id; deployment/read-only boundaries retained | Local pass; all policy modes/providers unaccepted |
| User/steer deduplication and repeated Stop | Concurrent same-key success/rejection runs once; Stop samples three times with false/true/true, no synthetic Prompt | Local pass; actual direct/queue steer uploads pass |
| MCP handler and real human waits | Original stdio handler blocks before model; 1s active budget survives 1.4s human wait; MRTR4 pass | Local pass; real remote/HTTP upload conditions remain P1/P3 gaps |
| Manual compaction owner and Pre/Post/Start compact | Each real MCP event once under true compaction owner | Local pass; auto compact/resume/all attach combinations unaccepted |
| UTF-8 spill, strict output, known fail-open | Both ends and retained full output; output6 pass | Local pass; retained files use Core data directory rather than Codex OS temp |
| Background concurrency, safe points, descendants, End | Runtime56 pass; actual Core21 includes ordinary command releasing waiting async hook, next-Turn context, confirmed descendant exit and End once | Local default matrix21 pass with separately consented read-only child; arbitrary dependency cycles remain excluded |
| SubagentStart/Stop and agent_type | Actual ordinary read-only child emits Start/Stop with root session_id and exact child identity | Limited command path passes; custom roles and read-only MCP incomplete |
| Pinned Codex binary comparison | Actual0.162.1: Prompt exit2 makes0 model requests; Stop makes2 requests and active=true | Two events pass with owned hook/loopback model; no whole-package/all-event comparison |
| Human-wait journal and response budget | Real MRTR upload enclosing durable submission RED timeout→GREEN; near7.5MiB concurrent responses RED overflow→GREEN restart/no replay | Fixes pass; actual hook steer uploads pass |
| Schema generation and failure preservation | Standard Make exit0;5 failure/invalid-JSON/success checks | Current command passes; historical SIGKILL cause UNKNOWN |

## Reproduction and evidence

Run from the owned worktree with the fixed Rust toolchain and isolated target. GUI uses Playwright CDP against actual source Electron. MCP/Runtime are real subprocesses; model endpoints are loopback fixtures. No real provider, remote OAuth or signed/notarized package claim.

```sh
cargo test --locked -p areal-plugins
cargo test --locked -p areal-mcp
cargo test --locked -p areal-engine --test codex_plugins --test plugin_hook_output --test plugin_mcp_runtime --test plugin_mcp_subscriptions
AREAL_TEST_BIN_DIR=/absolute/bin-dir node scripts/plugin-hooks-smoke.mjs
AREAL_TEST_BIN_DIR=/absolute/bin-dir node scripts/plugin-readonly-hooks-smoke.mjs
AREAL_CORE_BIN=/absolute/bin-dir/areal node clients/gui/scripts/plugin-p2-hooks-smoke.mjs
make desktop-schemas
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui run verify
python3 scripts/check-docs.py
```

The hooks script defaults to the full matrix. `--defer-concurrency --defer-readonly-child` explicitly selects an independent subset; manifests retain deferred and `completeMatrix:false`. `--writable-child` runs concurrency and lifecycle using an explicitly sharedWrite child. It also records `completeMatrix:false`: a subset or policy-selected pass is not a default-matrix pass.

- Bounded group Runtime56: `/private/tmp/areal-p2-hook-write-lane/final-green.log`; frozen seven-file packet SHA256 `1ab41b6414b71e3936a51c2cad4946fba08bd134f8e2820c20b07de2bc155f39`. Actual Core21: `/private/tmp/areal-plugin-hooks-3no58f/manifest.json`, Core `0eed11f6…`, unchanged during execution.
- Independent16: `/private/tmp/areal-plugin-hooks-E8XvmY/manifest.json`, including actual human wait, compaction and same-WebSocket direct/queue steer uploads with duplicate keys.
- Native8 with visible commands/digests: `/private/tmp/areal-plugin-gui-537du4/manifest.json` and `hook-review.png`, Core `0eed11f6…`, unchanged after execution.
- Codex baseline: `/private/tmp/areal-codex-hooks-baseline/REPORT.md`; binary SHA256 `61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70`.
- Journal upload/budget RED/GREEN: `/private/tmp/areal-p2-submission-upload-{red,green}.log`, `areal-p2-submission-budget-{red,green}.log`.
- Package37: `/private/tmp/areal-p2-plugins-final.log`. Engine independent28: `/private/tmp/areal-p2-engine-group-final.log`, explicitly skipping the failed subprocess probe below.
- MCP39 pass,1 child probe fail,2 external-condition ignores: `/private/tmp/areal-p2-mcp-plugins-regression.log` and `areal-p2-mcp-remaining.log`.
- Standard schema: `/private/tmp/areal-p2-desktop-schemas-group-final.log`; publication5: `areal-p2-schema-publication-tests.log`; diagnosis: `/private/tmp/areal-p2-schema-diagnosis/README.md`.

## Current follow-up evidence

Historical paths above are previous-run records, not a promise that temporary artifacts still exist. The separately approved read-only implementation binds actual Core binary and source hashes in each new manifest. Both data redirection RED cases are retained in `/private/tmp/areal-readonly-data-red-v2.log` and `/private/tmp/areal-readonly-data-parent-red.log`.

The original full-matrix command fixture used 1–3s command limits and failed at different steer/upload points with explicit command `timedOut` receipts. `/private/tmp/areal-readonly-full-matrix-final.log` preserves the failure. Normal-command fixture limits are now bounded at10s and explicitly reject unexpected command timeout; application/user timeout semantics are unchanged. MCP's1s active budget and actual1.4s human wait remain unchanged. The10s run passed21 default scenarios, including exact-once uploads and confirmed cleanup, in `/private/tmp/areal-plugin-hooks-CFb85O/manifest.json`. This does not establish a stable3s host-startup guarantee or identify the historical SIGKILL source.

Final frozen candidate: all three runs use Core SHA256 `fa0e40040ed61fb4d97f095ba522e7dcdd01ece9fb4549a38513f18dba9aecb0`, unchanged throughout execution; an independent non-author review confirms matching behavioral source hashes and SHIP for this limited slice.

- Read-only10: `/private/tmp/areal-readonly-hooks-86HCiw/manifest.json`, including workspace/sibling data-leaf redirects, redirected parent pre-creation rejection and real root idle Profile/SessionEnd. The idle Profile RED is `/private/tmp/areal-readonly-idle-profile-root-red.log`; a child-only SessionEnd probe was discarded because child Sessions never emit that event.
- Default matrix21: `/private/tmp/areal-plugin-hooks-onHQuW/manifest.json`, no deferred selectors and `completeMatrix:true`.
- Source desktop10: `/private/tmp/areal-plugin-gui-tu6MJU/manifest.json` and `hook-readonly-consent.png`, independent explicit checkbox, original-receipt response-loss recovery and revocation.
- Package37 and Engine28: `/private/tmp/areal-readonly-package-accepted.log`, `/private/tmp/areal-readonly-engine-accepted.log`; Engine explicitly filters the previously failed epoch child probe. Runtime56 remains unchanged and passed earlier in this follow-up. GUI types/build/public inventory1125 pass; public documents149 pass.
- Standard schema exit0: `/private/tmp/areal-readonly-desktop-schemas.log`; optional/defaultfalse bool appears only in the owned Core schema. Workspace build succeeds; the known rust-objcopy SIGABRT/missing LLVM layout warning remains separate.

Idle hook checks now use the current desktop configuration; only an in-progress Turn supplies its frozen configuration. Research/nativeTaskAgent and external platform/provider gaps remain source or unaccepted evidence as described above.

## 2026-10-15 design-review fix acceptance

This batch fixes four design findings within the compatibility scope above; focused acceptance does not establish full protocol conformance.

| Finding | Fix and acceptance |
| --- | --- |
| MCP cleanup state | Detect `CleanupUnconfirmed` by type in the error chain and retain `cleanupUnknown`. A later disconnect without a cleanup handle cannot clear the reconnect gate. Wrapped errors and the actual Engine disconnect path pass; this injects boundary state, not an OS cleanup failure. |
| Cross-instance hook revocation | Each invocation checks shared enablement; polling cancels in-flight calls without requiring an MCP connection. Old invocations retain package ownership after an update removes hook definitions and remain revocable. Frozen definitions do not freeze authority. |
| Refresh lock scope | Remote preparation does not hold the Engine refresh lock. Store retains cross-process CAS; publication uses one installation-state read, with draining outside the lock. Disable completes within a 2s acceptance window while an actual loopback Git download is held behind a barrier. |
| Incremental refresh | State polling avoids package contents; parsed components are cached and calls validate their own package. Five refreshes of a 1 MiB asset perform one full read; same-size tampering remains rejected. Metadata traversal remains, without fixed latency or arbitrary same-UID directory-replacement isolation guarantees. |

The four original assertion RED logs are `/private/tmp/plugin-review-{cleanup,revoke,lock,cache}-red.log`; the later-disconnect UNKNOWN regression is `plugin-review-cleanup-retention-red.log`. Package38 passes (`plugin-review-package-final.log`); all four Engine integration targets pass30 with no filters (`plugin-review-engine-frozen.log`), followed by a final15-check rerun of both MCP targets (`plugin-review-mcp-engine-accepted.log`). The two focused checks are in `plugin-review-revoke-frozen.log` and `plugin-review-cleanup-accepted.log`. All these logs are under `/private/tmp/`.

MCP41 passes with2 existing ignores (`/private/tmp/plugin-review-mcp-final.log`): the live GitHub credential case was not run, and the other is a subprocess entry invoked by its parent test. The parent `cross_process_refresh_serializes` and Engine's `mcp_only_discovery_trust_and_revocation` both pass in this batch. Historical SIGKILL failures below remain recorded; their cause is still UNKNOWN. The workspace build passes with the known rust-objcopy LLVM layout warning; no toolchain changes were made.

The first native attempt inside the outer tool sandbox failed with `sandbox_apply: Operation not permitted`. Subsequent native runs execute outside that outer sandbox while retaining the product Runtime sandbox. The final candidate's first full-matrix run failed its 5s model-readiness wait before upload (`/private/tmp/areal-plugin-hooks-jmCyOE/manifest.json`): preceding command-hook receipts succeeded and fixture cleanup interrupted the Turn. This fixture wait is now bounded at15s; product execution limits and behavioral assertions remain unchanged.

Final frozen Core SHA256 `f0a2c3bb7ca26a101ee0ca6ee03b824c400cbacc8442c4fc7447293b9920be12`: the default full hooks matrix passes22 (`/private/tmp/areal-plugin-hooks-VbWmUS/manifest.json`, `completeMatrix:true`) and read-only isolation passes10 (`/private/tmp/areal-readonly-hooks-lhkkmD/manifest.json`). Both retain an unchanged binary; owned behavior/test source hashes match the final files. The new actual two-Core case confirms shared user-disable cleans idle descendants without a refresh on the original instance and rejects a frozen Stop hook in an active Turn. Native runs use a loopback model fixture; no new GUI, installed-package or real-provider acceptance is claimed. Public documents174, Rust formatting and diff checks pass; only these fixes are committed, without push.

## SIGKILL classification

A historical service-schema invocation received kill9; direct shell redirection truncated its tracked output to0 bytes. Make now stages all three outputs on the same filesystem, requires successful generation and valid JSON objects, and replaces each destination atomically. Generation failures preserve all old files; three renames are not a cross-file transaction. The unchanged cached generator and standard Make both pass currently. The historical killer remains unconfirmed.

Two distinct direct Rust children also received kill9: Engine's persisted epoch restart probe in `mcp_only_discovery_trust_and_revocation`, and MCP `cross_process_refresh_serializes`. Both produced no stdout/stderr; signature checks and OS queries provide no causal event. They remain failed, without changing launch parents, signing, loader or EDR settings. The separate rust-objcopy SIGABRT has a demonstrated missing `@rpath/libLLVM.dylib` layout; it does not explain SIGKILL, and the machine toolchain was not repaired.

Standard generation exposed existing native-host-v2 search-schema drift unrelated to hooks. That file is restored; only the owned areal-core-v1 hook/steer schema is included.

## Approved Runtime write policy

The previous overlapping-path lease conflict is resolved by typed task groups, without enabling global concurrent_writes or a hook: string-prefix exemption.

Implemented: trusted Core/Runtime task-scope owners admit Ordinary/Hook participants; groups bind runtime epoch plus a validated task Scope. Each member retains its own grants. Same-group overlap is permitted when at least one member is Hook; ordinary/ordinary remains serialized, and cross-group conflicts remain excluded. Cross-group FIFO becomes bounded generation FIFO: first admission sets a fixed deadline that new members cannot extend; after sealing, the next generation queues behind foreign waiters. UNKNOWN cleanup retains exclusion. Path expansion cannot bypass earlier foreign waiters.

This permits actual same-task hook/tool write races and changes the fairness unit, approved by the user and implemented. The window is 1–min(task process wall limit,60000) milliseconds; Core uses the maximum allowed by that bound. Authority uses the current connection root, and task/parent ancestry is validated. Five Supervisor integration cases and a real Native path cover admission, forged metadata, sealing/FIFO, expansion/cancellation and UNKNOWN; not every fault is injected on a native host. A fixed group window cannot promise deadlock-free arbitrary long dependency cycles; unlimited reentry and starvation-free foreign FIFO cannot both be claimed. Detailed analysis and nine failure contracts are in `/private/tmp/areal-p2-hook-write-analysis/README.md`.

## Approved limited read-only child implementation

The user separately approved ordinary read-only child command hooks. Side, research, nativeTaskAgent, read-only root Sessions and Profiles disabling plugin Skills remain excluded; MCP handlers receive no authority from this consent. `allowReadOnlyCommands` defaults to false in requests and prior trust metadata, binds reviewed package/source and definition digests, and is exposed independently in CLI and the source GUI. Omitting it revokes the extra capability. Core filters inherited plans and uses the same admission/live-check predicate.

Runtime confirms `restrictedScopeIsolation` from the actual backend. Even a full-access deployment must enforce restricted Scopes for this path: workspace/reviewed package reads, private child scratch and own package data writes, network denied and no inherited provider secrets. An unverified backend reports false. The task-group anchor supplies scheduling identity only.

Two concrete RED cases exposed data redirection: canonicalization turned a redirected leaf into an excess write grant, and Core pre-created a data leaf through a redirected parent before validation. The fix retains literal grant identity, rejects redirected roots, and creates only the data leaf using the existing package directory walker and descriptor-relative `mkdirat`/`openat` with NOFOLLOW. It does not claim protection against every same-UID directory-object replacement; Runtime still advertises `directoryObjectIsolation:false`.

Real Core/Native fixtures cover the actual read-only child Start/Stop identities, existing sibling markers, forbidden workspace/host/sibling writes and network, secret absence, allowed private scratch/data writes, stale/revoked/omitted trust, persistence through confirmed restart, a disabled Profile, and Side from an otherwise eligible parent. Research/nativeTaskAgent exclusion is checked in the shared source predicate; this fixture does not create those worker modes. Full read-only MCP compatibility remains open.

## Closing full compatibility

Complete custom role inputs, automatic compaction/resume/attach, all12 events against original packages, Windows/Linux execution and packages, real OAuth/HTTP uploads/services and authorized private OpenAI catalog/sharing. Open [P1/P3 requirements](codex-plugins-p1-p3-acceptance.en.md) remain; no release, signing, notarization or push occurs in this batch.
