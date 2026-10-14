[中文](codex-plugins-p0-acceptance.md) | **English**

# Codex plugins P0 acceptance record

2026-10-13, branch `codex/codex-plugins-p0`. Baseline: Codex 0.162.1 / Agent Plugins 1.0.0. P0 source implementation, local integration and automated Electron user journeys pass. Full compatibility still requires P1–P3; see the [implementation plan](codex-plugins-plan.en.md) and [plugin guide](../guides/plugins.en.md).

| Evidence boundary | Result | Coverage |
|---|---|---|
| Rust workspace build | PASS | Locked dependencies; Core, CLI, Runtime and shared service |
| Package/Store integration | 15/15 PASS | Both manifests/overlays, local catalogs, digest/CAS/restart, scope precedence, unsafe files, invalid metadata never committed |
| Engine integration/regression | 33/33 PASS | Plugins8, standalone Skills7, Agents14, queue transfer4; frozen Turns, retained references after component removal, revocation, Profile/Side, explicit invocation and setup content boundaries |
| Actual Core/CLI RPC | 11 checks PASS | Authorization denials, no package execution, install deduplication, shared resources, source drift, revocation/CAS, setup/lost-response receipts, shared CLI state, restart and uninstall |
| GUI static/build | PASS | Types, CJS syntax, public source boundaries and production renderer build |
| Real Electron/Core | 5 checks PASS | Catalog→install→setup→accessible chat/sidebar→disable/enable→uninstall; lost successful Main-to-renderer response recovers using actual Core receipt with one model invocation |
| Documentation and independent review | PASS / SHIP | Language pairing and links; identified state, authority and compatibility failures fixed |

The Core/CLI script also drops one response for an executed setup at the WebSocket boundary and then reads the receipt without replay. GUI fault injection occurs at the Main-to-renderer response boundary; it does not establish every real-network disconnect case. Discovery and installation make zero model calls.

Local evidence resides in `.scratch/codex-plugins/evidence/` (excluded from commits): `core-manifest.json`, `gui-manifest.json`, integration/build logs, two desktop screenshots and review records. Both manifests bind Core SHA-256 `497e74273750f639e1bc5caed808b3dee3cd080b78cb34f764a4a9d174d0deff` and modified source-file hashes; completion checks confirm those source hashes remain unchanged. Reproduction commands are in the [testing guide](testing.en.md#codex-plugins-p0).

Real providers, signed/notarized packages, physical input, other operating systems and remote CI were not exercised. Existing library-level tests cannot compile because three pre-existing `TaskControl.expected_run_id` initializers are missing; this batch does not alter those unrelated Task tests or claim whole-suite success. Isolated Workgroup workers do not automatically deploy plugins and deny restricted references; cross-Engine deployment requires later acceptance. Git/npm, MCP/OAuth, public hooks, MCP Apps, desktop extensions, Connectors and the experimental Codex management wire adapter remain unimplemented.
