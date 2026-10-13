[中文](codex-plugins-plan.md) | **English**

# Codex plugin implementation and acceptance

This plan implements the approved design in ordered vertical slices. P0 is the current batch; P1–P3 remain required for the final compatibility claim. A phase passes only with its own evidence.

## Baseline and controls

Codex 0.162.1 (`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`), Agent Plugins 1.0.0, and OpenAI MCP Extensions `0d606217705e0e71eb21fff009619b67b80611dc`. Core owns installation and selection; existing Skill/MCP/Runtime owners execute components. Private service access remains an external prerequisite.

Do not execute package code during discovery/install, overwrite explicit Profiles, mutate an active Turn revision, replay UNKNOWN effects, or share credentials with Renderer. Preserve existing standalone Skills/MCP and Native Hosts.

## P0 · Local packages and Skills

| Task | Owner/entry | Work | Observable acceptance |
|---|---|---|---|
| P0-01 | `upstream/pins.json`, design/task docs | Pin compatibility evidence and capabilities | Pin Codex 0.162.1 / Agent Plugins 1.0.0; surface unsupported components |
| P0-02 | `core/plugins/src/package.rs` | Parse both manifests and overlay | Unchanged packages; empty inline overlay replaces legacy; no schema downgrade |
| P0-03 | `core/plugins/src/lib.rs` | Discover/add local marketplaces | Pinned path precedence; entry failures isolated; root sources work |
| P0-04 | `core/plugins` installation Store | Transactional install, digest, CAS and restart | Bind selected source/digest; no script execution; immutable cache; visible conflicts |
| P0-05 | `core/engine/src/desktop/{skills,catalog}.rs` | Integrate skills/resource reads | Ordinary selection; explicit Profile bounded; shared package resources contained |
| P0-06 | Engine Turn/queue and Store | Invocation policy, Turn versions and disabling | Explicit use of implicit-disabled skills; pinned Turns; revoke subsequent reads |
| P0-07 | Engine plugins and existing submission ledger | Explicit onboarding and receipt recovery | Setup uses normal chats; deduplicate clicks/reconnects; query UNKNOWN receipts |
| P0-08 | app-server, CLI plugins, GUI PluginsSettings | Core/CLI/GUI management acceptance | Shared installation authority; real desktop journey; auth/restart evidence |

P0 dependencies: freeze the baseline in 01; establish package/catalog boundaries in 02/03; finish installation transactions in 04; integrate Skills and lifecycle in 05/06; complete setup, clients and combined acceptance in 07/08. P1 reuses P0 immutable packages and state ownership; P2 integrates existing Engine/Runtime permissions and events; P3 adds desktop and hosted-service support after MCP, authentication and lifecycle are ready.

## P1 · Sources, MCP and connection lifecycle

| Task | Work | Observable acceptance |
|---|---|---|
| P1-01 | Git marketplaces and source pins | Resolve refs to commits; contain subdirectories; preserve old install |
| P1-02 | npm sources and integrity | Pin versions/integrity; never run lifecycle scripts |
| P1-03 | Portable/legacy MCP adapters | Format-specific env/cwd/header/transport normalization and diagnostics |
| P1-04 | OAuth and secure credentials | Registration/refresh/cancel/failure; no secrets in renderer/logs |
| P1-05 | Authentication and tool policies | Distinct auth timing, tool enablement and approvals |
| P1-06 | Metadata, results and revision catalogs | Preserve instructions/results/media; stable active schemas |
| P1-07 | Updates, revocation, drain and recovery | Generation ownership; visible unconfirmed cleanup; no UNKNOWN replay |
| P1-08 | Real MCP and cross-instance acceptance | Original stdio/HTTP packages; concurrent connect/update/disable/restart |

## P2 · Full public hook semantics

| Task | Work | Observable acceptance |
|---|---|---|
| P2-01 | Configuration, grants and platform shells | Discovery/override, regex/aliases, seconds timeout, Windows override |
| P2-02 | Session/Turn lifecycle events | Pinned events; no repeat on attachments; defined ordering/ownership |
| P2-03 | Tool interception and permission decisions | Distinct denial/rewrite/approval/post feedback; deployment policy remains |
| P2-04 | Background command and MCP handlers | Safe-point output; no recursion; cancellation; late-response isolation |
| P2-05 | Outputs, failures and unsupported behavior | Pinned exit2/JSON/stderr/unsupported-field behavior |
| P2-06 | Comparison, faults and recovery | Same owned fixtures on fixed hosts; no side-effect replay |

## P3 · Desktop extensions, Connectors and full acceptance

| Task | Work | Observable acceptance |
|---|---|---|
| P3-01 | MCP Apps resources and isolated host | Metadata, initialization/bridge/CSP and window ownership |
| P3-02 | OpenAI desktop extensions | Accept pinned entrypoint/settings/mention/file/context capabilities |
| P3-03 | Connector resolver and authorized services | Original IDs; distinct auth/access/support states; real services |
| P3-04 | Experimental Codex management adapter | Pinned wire types; shared handlers; honest remote service gaps |
| P3-05 | Original-package corpus, platforms and distribution | Separate package/execution/UI/service/distribution evidence |
| P3-06 | Final compatibility claim | All required capabilities/services accepted with explicit prerequisites |

## Verification and status

Before implementation, define failure assertions at the actual boundary. Prefer integration/E2E evidence; source checks, a local deterministic model, real providers, native desktop and packaged distribution are separate claims. Run only affected checks during development and relevant end-to-end acceptance at closure.

Current status: P0 source implementation and local combined acceptance pass; P1–P3 have not started. All 48 package/Engine integration checks, actual Core/CLI authorization and lost-response recovery, GUI types/public contracts/build, real Electron installation/setup/disable/uninstall and explicit receipt recovery pass. Independent review is SHIP. See the [P0 acceptance record](codex-plugins-p0-acceptance.en.md) for evidence and exclusions. This does not claim compatibility with the complete Codex plugin protocol.

Before P3 acceptance, name the required desktop extension set, services/Connectors and supported platforms. Format parsing does not grant access to hosted services. Every unresolved requirement remains open in the final matrix.
