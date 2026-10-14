[中文](codex-plugins-p2-acceptance.md) | **English**

# Codex plugin P2 acceptance matrix

Candidate evidence captured 2026-10-14 against Codex0.162.1 / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`, based on local changes over `75e449a`. Runtime manifests bind source-file/diff and Core binary hashes. P0 and [historical P1/P3 evidence](codex-plugins-p1-p3-acceptance.en.md) remain separate. **P2 and full compatibility are open.**

## Current matrix

| Requirement | Evidence | Status / remaining |
|---|---|---|
| Original declarations, overlay, matcher/alias, typed MCP templates | Package37 pass, including hooks5 and sources4 | Local pass; no Windows device |
| Cumulative user/project JSON/TOML and global gate | Actual Core requires independent review; no package environment in config hooks; user hooks=false gates both | Local pass; managed/profile/session stack incomplete |
| Independent trust, CAS, revoke, visible review | Stale digests reject; real Electron shows commands/digests, consent gate and original-receipt recovery | Source desktop8 pass; no distribution |
| Pre deny/exit2/rewrite and Post effect preservation | Actual Runtime write/denial assertions and output6 checks | Local pass; full native file-input mapping not compared |
| PermissionRequest independent of Pre | Actual allow/deny without tool_use_id; deployment/read-only boundaries retained | Local pass; all policy modes/providers unaccepted |
| User/steer deduplication and repeated Stop | Concurrent same-key success/rejection runs once; Stop samples three times with false/true/true, no synthetic Prompt | Local pass; actual direct/queue steer uploads pass |
| MCP handler and real human waits | Original stdio handler blocks before model; 1s active budget survives 1.4s human wait; MRTR4 pass | Local pass; real remote/HTTP upload conditions remain P1/P3 gaps |
| Manual compaction owner and Pre/Post/Start compact | Each real MCP event once under true compaction owner | Local pass; auto compact/resume/all attach combinations unaccepted |
| UTF-8 spill, strict output, known fail-open | Both ends and retained full output; output6 pass | Local pass; retained files use Core data directory rather than Codex OS temp |
| Background concurrency, safe points, descendants, End | Runtime56 pass; actual Core21 includes ordinary command releasing waiting async hook, next-Turn context, confirmed descendant exit and End once | Local pass with explicit writable child; default matrix remains open |
| SubagentStart/Stop and agent_type | Actual sharedWrite child emits Start/Stop with root session_id and exact child identity | Writable default-role path passes; read-only policy and custom roles incomplete |
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

## SIGKILL classification

A historical service-schema invocation received kill9; direct shell redirection truncated its tracked output to0 bytes. Make now stages all three outputs on the same filesystem, requires successful generation and valid JSON objects, and replaces each destination atomically. Generation failures preserve all old files; three renames are not a cross-file transaction. The unchanged cached generator and standard Make both pass currently. The historical killer remains unconfirmed.

Two distinct direct Rust children also received kill9: Engine's persisted epoch restart probe in `mcp_only_discovery_trust_and_revocation`, and MCP `cross_process_refresh_serializes`. Both produced no stdout/stderr; signature checks and OS queries provide no causal event. They remain failed, without changing launch parents, signing, loader or EDR settings. The separate rust-objcopy SIGABRT has a demonstrated missing `@rpath/libLLVM.dylib` layout; it does not explain SIGKILL, and the machine toolchain was not repaired.

Standard generation exposed existing native-host-v2 search-schema drift unrelated to hooks. That file is restored; only the owned areal-core-v1 hook/steer schema is included.

## Approved Runtime write policy

The previous overlapping-path lease conflict is resolved by typed task groups, without enabling global concurrent_writes or a hook: string-prefix exemption.

Implemented: trusted Core/Runtime task-scope owners admit Ordinary/Hook participants; groups bind runtime epoch plus a validated task Scope. Each member retains its own grants. Same-group overlap is permitted when at least one member is Hook; ordinary/ordinary remains serialized, and cross-group conflicts remain excluded. Cross-group FIFO becomes bounded generation FIFO: first admission sets a fixed deadline that new members cannot extend; after sealing, the next generation queues behind foreign waiters. UNKNOWN cleanup retains exclusion. Path expansion cannot bypass earlier foreign waiters.

This permits actual same-task hook/tool write races and changes the fairness unit, approved by the user and implemented. The window is 1–min(task process wall limit,60000) milliseconds; Core uses the maximum allowed by that bound. Authority uses the current connection root, and task/parent ancestry is validated. Five Supervisor integration cases and a real Native path cover admission, forged metadata, sealing/FIFO, expansion/cancellation and UNKNOWN; not every fault is injected on a native host. A fixed group window cannot promise deadlock-free arbitrary long dependency cycles; unlimited reentry and starvation-free foreign FIFO cannot both be claimed. Detailed analysis and nine failure contracts are in `/private/tmp/areal-p2-hook-write-analysis/README.md`.

The read-only hook gate remains. Automatic approval review rejected broad removal because it weakens the existing security boundary. A narrowly scoped alternative needs separate validation and explicit authorization; the write-group decision does not authorize it.

## Narrow read-only child proposal (not enabled)

The next change is limited to ordinary read-only child Sessions whose Profile already permits plugin Skills. Side, research, nativeTaskAgent and Profiles disabling plugin Skills remain excluded. A separate explicit read-only command-hook consent binds package/source digest, definition digest and scope kind; existing writable hook trust alone does not admit it. Only command handlers enter this path; MCP handlers remain blocked pending separate authority design.

Core admission and current-definition checks must enforce the same predicate. The command runner grants read access only to the child-readable workspace and reviewed package, writes only to private child scratch and that package's data directory, denies network and excludes inherited provider secrets. Runtime must confirm enforced isolation; no full-access fallback or permission widening is permitted. The task-group anchor provides scheduling identity only. Revocation, UNKNOWN and descendant cleanup use existing owners.

Before implementation, require real Core/Runtime scenarios showing SubagentStart/Stop in the actual read-only child, rejection of workspace/host/sibling-data writes, network denial, secret absence, allowed private-data writes, stale/revoked trust rejection, and unchanged Side/research/Profile exclusions. This proposes a new explicitly consented execution capability in a previously excluded Session; it is separate from the approved write-group change and is not full read-only MCP compatibility.

## Closing full compatibility

Complete read-only child policy and role inputs, automatic compaction/resume/attach, all12 events against original packages, Windows/Linux execution and packages, real OAuth/HTTP uploads/services and authorized private OpenAI catalog/sharing. Open [P1/P3 requirements](codex-plugins-p1-p3-acceptance.en.md) remain; no release, signing, notarization or push occurs in this batch.
