[中文](codex-plugins-p1-p3-acceptance.md) | **English**

# Codex plugins P1/P3 acceptance ledger

**Status: first GitHub delivery; full P1/P3 acceptance remains open.** Updated 2026-10-13. Source, actual Core/CLI and native desktop evidence exist, without full Codex compatibility acceptance. Branch `codex/codex-plugins-p1-p3`, baseline `d4ee44af837afec758c89224a2351881ce2b5661`.

## Scope and pinned contracts

The current batch covers P1 source acquisition/MCP lifecycle and P3 desktop Apps/extensions, with GitHub as the first real service. P2 hooks are excluded. P0 retains its separate [accepted record](codex-plugins-p0-acceptance.en.md); it does not discharge the new requirements in the [phase plan](codex-plugins-plan.en.md).

| Contract | Fixed reference and claim boundary |
|---|---|
| Codex package behavior and plugin-management wire types | `0.162.1`, commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; plugin adapter only, not an upgrade of the existing `0.145.0` app-server contract |
| Agent Plugins manifest/MCP schemas | `1.0.0`; manifest SHA-256 `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`, MCP SHA-256 `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb` |
| OpenAI public MCP Extensions | Revision `0d606217705e0e71eb21fff009619b67b80611dc`; source pinned independently of service access |
| MCP connection host | rmcp `3.3.0`, negotiated host baseline `2025-11-25`; Apps capability `io.modelcontextprotocol/ui`, MIME `text/html;profile=mcp-app` |

The pinned public OpenAI specification requires MCP `2026-07-28` or later and multi-round-trip requests (MRTR) for forms on OpenAI-registered servers. Direct MCP connections can use legacy forms. This host's `2025-11-25` behavior does not implement that modern MRTR path; an Apps/form implementation must not be described as support for every OpenAI mechanism. Protocol support and private service access are separate prerequisites.

## Implemented owners and observable interfaces

| Owner | Current source/interface | Evidence boundary |
|---|---|---|
| Package Store | `core/plugins/src/{remote,components,metadata}.rs`; source resolution, pinned Git/npm content and component documents | Installation and resolution do not execute package lifecycle scripts; source tests do not prove a real remote MCP service |
| MCP normalization/auth | `normalize_plugin_document`, `PluginServerConfig::redacted_view`, `AuthPolicy::is_supported`; `AuthManager::{start,status,cancel,ready_credential}` | Config literals and credentials remain internal; public states are Pending/Ready/Failed/Cancelled |
| MCP connections | `Connections::connect_plugins_with_options`, generation-bound `McpTool::call_raw_with_meta`, `McpServer` resource APIs and `ResourceUpdates` | Original metadata and full results retained; schemas fixed for a generation; revocation cancels cloned handles; list changes never replay calls |
| Legacy elicitation | `ElicitationBroker`, standard and `openai/elicitation/create` requests | Bound server/generation/request identity and cancellation; not modern MRTR acceptance |
| Core desktop protocol | `core/protocol/src/plugin_runtime.rs`; `areal/plugin/connection`, `areal/plugin/auth`, `areal/plugin/connector/configure`, `areal/mcp/tool/result`, App/extension/form methods | Typed ownership and receipts; Main-authorized file paths must not be inferred from App input |
| Desktop host | `clients/gui/app/src/core/mcp-apps*.cjs`, `McpAppHost`, `McpAppForm`, `McpAppsWorkspace` | Electron owns isolated surfaces/files; Core owns execution; GUI/SDK checks below do not prove native rendering or user uploads |
| Codex management adapter | `core/app-server/src/codex_plugins.rs`, pinned `plugin/*` and `marketplace/*` handlers | Uses the existing Store; hosted catalog/search/sharing remains an explicit unavailable capability when not configured |

These entries identify implementation owners. Acceptance depends on the evidence below and the final integrated candidate, not the presence of a route or type.

## Authentication mechanism matrix

| Mechanism | Current result |
|---|---|
| Legacy `auth: "oauth"` without an OAuth object | Creates a discovery policy; no silent anonymous normalization |
| OAuth discovery, provided public client, DCR, legacy CIMD with metadata URL | SDK-backed local HTTP fixture coverage, including callback state/issuer, refresh and cancellation; not real-provider acceptance |
| HTTP401/403 and refresh `invalid_grant` | Rejected credentials invalidated with token comparison; explicit retry returns to authorization; no automatic MCP POST replay |
| Concurrent owners | Atomic flow supersession, epoch-bound callbacks, authoritative reload and private OS store lock; latest cross-process execution limitation below |
| Provider error/code/token logging | Own freshness selection uses direct SDK refresh; scoped no-subscriber authentication futures prevent SDK secret logs, without changing global logging |
| Portable `extensions["com.openai"].auth` | Declaration retained privately with valid siblings and a diagnostic that pinned Codex rejects extensions; the dotted declaration form is recognized too |
| Portable discovery/provided public client/DCR/base scopes | Supported by current normalization/auth owner |
| Portable endpoint/resource/OIDC/default-scope overrides, client-secret/key provisioning, CIMD preference without host metadata URL, mixed authentication and API-key execution | Declaration retained but explicitly unsupported by this host; `is_supported()` and redacted `authenticationSupported` report the gap; no anonymous fallback claim |
| Legacy SSE transport | Explicit unsupported outcome matching pinned Codex; not full Agent Plugins transport support |

The fresh review identified five auth/normalization findings: rejected-token retry, SDK secret logging, concurrent start supersession, shared-store refresh serialization, and portable/legacy auth preservation. Their scoped fixes are present. Three meaningful pre-fix regressions reproduced stale Ready status, sentinel log leakage and duplicate refresh. Fix presence and passing local checks do not replace final integration review or real credential/service acceptance.

## Final local evidence

| Layer | Result | Acceptance boundary |
|---|---|---|
| Sources/packages | 27 passed: metadata 1, remote 11, store 15 | Local Git/npm fixtures; no live SSH/all registries claim |
| MCP | 24 unaffected checks passed | Client 7, concurrency 1, local GitHub 2, OAuth 6, optional 2, normalization 4, resources/forms 2 |
| Engine | Primary 24 passed; 1 restart probe unaccepted after SIGKILL | Admission 9, plugins 8, MCP runtime 7. Isolated lane's original integration harness passed 8, without closing the primary gap |
| Actual Core/CLI | CLI 8 and pinned Codex wire 6 passed | Pins, shared state, receipt deduplication and read-only recovery after response loss |
| Real GitHub | 5 passed | Original opaque ID, explicit mapping, official `api.githubcopilot.com`, one read-only `get_me` through Core journal, disconnect. No writes, DCR or real model acceptance |
| Native Electron Apps | 8 passed | Explicit Profile/model-only declared entrypoint, sandbox/private metadata, later visibility/same-server limits, draft/resources, model filtering and revocation |
| Native extensions | 5 passed | Settings changed fields once, mentions, legacy form ownership across Threads/accept/cancel, opaque file URI and actual read-only I/O |
| GUI/build | Workspace build, GUI build/typecheck/public boundary, official SDK and draft smokes passed | No CI, signed/notarized package, installation or cross-platform acceptance |

Source manifest SHA-256: `b63428ca03285806fc5fd2e11134e2bc11a9b25d39b6ce11f3c6e02337eea908`. Core binary SHA-256: `000307ca6e63e62afa3dcab51d22f1b08c20daccaa7f8eadcaa2b7f64d31de61`. Git-excluded evidence lives in `.scratch/codex-plugins/evidence/p1-p3/`, including `candidate.json`, logs/manifests and screenshots. It binds code, locks and schema without credentials or service-state directories.

Final independent source review: **SHIP, limited to inspected code**. Fixes cover auth retry/logging/concurrency, npm executable bits/Git sources, App process epoch, descriptor/CAS/write receipts, close races, server-name length, optional failure/reconnect, per-Connector credential isolation, and IPC incorrectly rejecting trusted Main file grants. Renderer-supplied paths remain forbidden; JSON cannot forge the trusted `serviceOnly` option.

## Unaccepted and uncovered requirements

- Final OAuth cross-process refresh and Engine restart children received SIGKILL (9), with empty stdout/stderr. Two existing MCP proxy fixtures also failed with no child output. Cause is unconfirmed; no bypass or retry loop. These checks remain open.
- Existing Engine `cargo test --lib` cannot compile three `TaskControl` literals missing `expected_run_id`. Credential-isolation RED/GREEN used temporary test-literal repairs in an isolated lane, restored afterward. This substituted harness is not final primary library-test acceptance.
- Core file write/CAS/receipts use Runtime descriptor helpers and have harness evidence. Native evidence covers reads only; real writable Runtime, native write/CAS and ancestor-directory swap acceptance remain absent.
- `ON_INSTALL/ON_USE` is retained/projected, while connection/auth remain explicit; complete automatic install-time authentication remains open. Portable auth limitations are listed above.
- Upload forms decline the whole schema; modern 2026 MRTR is unimplemented. Apps reopen after restart. Close stops delivery without per-resource unsubscribe.
- P2 hooks, private OpenAI registered services/catalog/sharing, sparse marketplace checkout, cross-platform, real vendor OAuth/models and signed/notarized distribution remain unaccepted. GitHub does not close these requirements.

## Reproduction

Run at the repository root with `AREAL_TEST_BIN_DIR`/`AREAL_CORE_BIN` pointing at the same workspace build. Run native scripts serially with isolated home/workspace; external inference uses deterministic fixtures. GitHub reads existing `gh` credentials privately in memory, performing only `get_me` without token argv/logging.

```sh
cargo build --locked --workspace
cargo test --locked -p areal-plugins --tests
cargo test --locked -p areal-mcp --tests
cargo test --locked -p areal-engine --test plugin_mcp_runtime --test codex_plugins --test admission_guards
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui run verify
node scripts/plugin-wire-smoke.mjs
node scripts/plugin-cli-p1-smoke.mjs
node scripts/plugin-github-smoke.mjs
node clients/gui/scripts/plugin-p1-p3-smoke.mjs
node clients/gui/scripts/plugin-p3-extensions-smoke.mjs
```

Complete commands include the recorded failures; they are not guaranteed green here. Resolve remaining contract/platform requirements before closing P1/P3 or claiming full compatibility.
