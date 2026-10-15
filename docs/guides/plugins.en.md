[中文](plugins.md) | **English**

# Codex plugin packages

Shared Core owns plugin installation and selection; GUI and CLI read the same state. Current scope covers local/Git marketplaces, pinned Git/npm packages, Skills/onboarding, trusted MCP connections and desktop Apps. GitHub is the first real Connector service. See [upstream pins](../../upstream/pins.json) and the [implementation/acceptance plan](../development/codex-plugins-plan.en.md).

## Plugins, Skills, and MCP

Settings → Plugins has three views: Plugins, Skills, and MCP. Plugins manages actual packages. Skills and MCP include standalone resources and installed package components, with their sources shown. Resources with the same name retain separate owner identities and configurations.

Packages follow the OpenAI plugin layout. Portable packages use root `plugin.json`, `skills/`, and `mcp.json`, with OpenAI-specific settings under `extensions.com.openai`. Compatibility manifests retain their existing parsing rules. AReaL keeps installation, selection, authentication, and connections with their existing owners, without rewriting package declarations.

Standalone skills retain their existing preview, creation, and scoped enable controls. Standalone MCP servers retain configuration and connection controls. The scope selector filters only standalone resources. Package components show the plugin's effective state for the current project. Manage Plugin opens the owning package detail and retains package selection, digest trust, authentication, and submission recovery. Package components cannot be modified through standalone resource commands. Listing a resource does not expand a chat's allowed skills or tools.

Interactive apps and hooks remain in package details or existing workspace entrypoints. Users manage GitHub as a plugin. Connector remains an internal service mapping and credential binding.

## Discovery and installation

Declare a local package in project/personal `.agents/plugins/marketplace.json`:

```json
{
  "name": "team-tools",
  "plugins": [{
    "name": "review-helper",
    "source": {"source": "local", "path": "./plugins/review-helper"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
    "category": "Productivity"
  }]
}
```

Paths resolve against the marketplace root, not the catalog directory. GUI Settings → Plugins → Plugins can add another local root, inspect components and install. Installation binds the selected source and digest; changes after preview require refresh and renewed selection. Installation runs no scripts, MCP, hooks or setup.

CLI commands connect to an already running Core with its configuration:

```sh
areal service ensure --workspace /absolute/workspace --json
areal plugin --workspace /absolute/workspace list --json
areal plugin --workspace /absolute/workspace marketplace-add /absolute/marketplace
areal plugin --workspace /absolute/workspace marketplace-add-git https://github.com/TEAM/catalog.git --ref-name main
areal plugin --workspace /absolute/workspace resolve review-helper@team-tools
areal plugin --workspace /absolute/workspace read review-helper@team-tools
areal plugin --workspace /absolute/workspace install review-helper@team-tools --scope project
areal plugin --workspace /absolute/workspace setup review-helper@team-tools
areal plugin --workspace /absolute/workspace connect review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST
areal plugin --workspace /absolute/workspace mcp-list
areal plugin --workspace /absolute/workspace disconnect review-helper@team-tools
areal plugin --workspace /absolute/workspace disable review-helper@team-tools --scope project
```

An explicit project selection overrides the user default; neither represents an enforced requirement. Explicit Profiles do not acquire every package. MCP connections require explicit trust in the installed digest; Connectors require an original-ID mapping and account credentials. Unsupported hook handlers/auth mechanisms/commands/dependencies remain diagnostic. Installed does not mean connected.

## Skills and setup

Ordinary chats can select enabled package skills. Skills that prohibit implicit invocation remain available for explicit selection. Resources use paginated lazy reads. Shared package resources resolve relative to the skill while remaining within its pinned package root. Standalone skills retain live-file and traversal contracts.

Rust embedders enable plugins through `Engine::install_plugin_store`. Pure Engine sessions without a default Profile or plugin Store retain their lightweight state; the presence of plugin code alone does not inject desktop instructions or change context budgets.

Run Setup selects the packaged onboarding skill in an ordinary chat, with results and approvals accessible there. It uses ordinary Core inference and submission receipts, not privileged installation scripts. Side and restricted Profiles cannot expand their boundary through setup. Configure a usable model before running setup.

## Versions, disabling and recovery

Installed copies retain content identity; source edits do not change installed resources. Active Turns pin skill revisions; subsequent Turns use available versions. Disabling/uninstalling revokes subsequent reads while retaining historical packages and writable data. Explicit connection starts MCP. Active Turns retain their admitted generation; disable/uninstall revoke subsequent calls and reads. Unconfirmed process cleanup blocks reconnection. Hooks require separate current-definition trust; see the P2 section below.

Applying standalone skill configuration to a new chat can restart Core. The desktop restores previously connected standalone MCP servers and trusted plugin MCP connections. Plugin restoration still requires the original installed digest. Failures do not replay tool calls. After creating a chat, an interactive app reads the current connection for the same plugin version before its first open request.

Mutations require `requestId` and applicable `expectedRevision`; RPC installation additionally requires selected `source` and `expectedDigest`. Identical requests recover their prior result; reused keys with different parameters reject. Check Plugin Submission queries receipts after an unknown outcome without replay:

```sh
areal plugin --workspace /absolute/workspace submission REQUEST_ID
```

Core enforces permissions; observers and Thread-scoped identities cannot perform global plugin management. State lives under the Core configuration home's `plugins/`, without modifying Codex caches/configuration.

## Current limits

Git/npm sources, modern MRTR, native stdio resource snapshots, portable auth, App subscriptions and explicit GitHub mapping are implemented. Full compatibility is not accepted: P2 hooks, private OpenAI catalog/sharing, cross-platform, real provider OAuth and signed/notarized package evidence remain open. Some local subprocess checks receive unexplained SIGKILL. Source completion and partial passes do not close full acceptance. Hosted service methods return explicit capability errors. See the [acceptance matrix](../development/codex-plugins-p1-p3-acceptance.en.md).

## Git/npm and MCP

Add a Git marketplace in the GUI. Entries accept `git-subdir` with `url/ref/path` and `npm` with `package/version/registry`. Resolve and preview before installation, reviewing the pinned commit, concrete npm version, integrity and content digest. Git refs and npm ranges become immutable candidates; installation runs no lifecycle scripts. Candidate and installed digests remain separate. Explicitly trust the installed digest before connection, and review upgrades again.

Portable and legacy adapters normalize fields privately. Auth supports provided/DCR/CIMD preference, declared endpoint/resource/OIDC/scope overrides and API-key bearer/basic/custom headers. CIMD preference without a trusted host metadata URL falls back to DCR; it never impersonates an OpenAI client. Main stores client secrets and signing keys securely; Core stores references. ON_INSTALL exposes pending authentication and gates declared auth services; ON_USE requests auth when needed, allowing mixed public access anonymously. OAuth uses PKCE and private storage. Empty scope overrides remain exact through refresh. Challenge-driven upgrades retain proven grants across cancelled retries in the same binding; pending requests are not grants and new configurations/accounts do not inherit them. Private challenges reject the exact sent token without deleting concurrent refreshed tokens or replaying MCP operations.

Codex marketplace/add accepts top-level sparsePaths. Nonempty paths use Git cone directory selection, retained across updates. Callers include the catalog and required package paths; selection is never silently widened. Missing/empty paths retain full checkout; local directory sources reject nonempty sparse selection.

## Desktop Apps and GitHub

Interactive apps in package details and global/thread/file entrypoints use the official MCP Apps AppBridge. A package detail shows only its own apps and app settings. Pages run under isolated origins in sandbox frames with no Node, product bridge or credentials. Calls bind project, Thread, package digest and connection generation, stay on the originating server, and use ordinary Core execution, approval and journal paths. Persisted Apps become stale after Core restart and must be reopened.

`ui/message` adds typed text/resources to drafts while preserving unfinished human input; only `send:true` submits. Titles and `_meta` stay in UI/history; recursive `_meta` removal precedes model projection. Context is grouped by instance and can be updated/removed. Settings, mentions and form previews use advertised tools/resources, without guessed methods or endpoints.

GitHub preserves the original `.app.json` Connector ID. Enter that ID and a GitHub token in plugin details, save through system secure storage, then explicitly connect. Core maps that configured ID to `https://api.githubcopilot.com/mcp/`; opaque IDs never imply a provider. Missing mapping, missing credentials and unsupported declarations are distinct. Real read-only `get_me` evidence is separate from deterministic model/desktop fixtures.

File entrypoints expose opaque URIs. Core validates saved grants and reuses Runtime descriptor traversal for actual I/O; Main owns windows/watchers. Reads are capped at 2 MiB, atomic writes at 64 KiB with `too-large` responses. ETag/CAS and durable request receipts ensure same-key retries return prior results without overwriting later edits.

Modern MCP 2026-07-28 supports MRTR forms; direct older connections retain legacy elicitation. Each round preserves original arguments and Core ownership, rechecks authority and never replays UNKNOWN. Resource updates target subscribed App/URI owners; the final owner releases the shared wire subscription.

Native form selection imports immutable local file/directory snapshots: 16 MiB per file, 256 files/64 MiB per logical call and depth16. Grants bind form, field and server generation, and clear on cancellation, close, revocation or settlement. Only same-host stdio receives these snapshots. HTTP without a publicly defined upload channel returns explicit unsupported behavior while server-provided resources remain selectable.

## Hooks (P2 candidate)

Package, user and project hooks share the Core execution owner. User sources are `hooks.json` in the selected home and `[hooks]` in the selected TOML; project sources are `.codex/hooks.json` and `[hooks]` in `.codex/config.toml`. JSON precedes TOML cumulatively within each layer; package declarations retain their original format and overlay rules. Project files supply only hooks and cannot replace models, credentials or the user feature gate. Codex `hooks.state` trust claims are not imported.

In Settings → Plugins, review the current package/source digest, definition digest, events, matchers, command/MCP inputs and full definitions before checking the explicit consent box. User/project sources require separate review. Installation, activation and MCP connection do not authorize hooks; changed definitions require a new review. CLI commands use the same Core state:

```sh
areal plugin --workspace /absolute/workspace hooks-list
areal plugin --workspace /absolute/workspace hooks-trust review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST --definition-digest REVIEWED_DEFINITION_DIGEST
areal plugin --workspace /absolute/workspace hooks-revoke review-helper@team-tools
```

Wired events are SessionStart/SessionEnd, UserPromptSubmit, PreToolUse/PermissionRequest/PostToolUse, PreCompact/PostCompact, SubagentStart/SubagentStop, Stop/Interrupt. Commands use existing Runtime scopes; MCP handlers call only already-connected, still-authorized package tools without recursive model-tool approvals. MCP active execution time pauses during real human form waits while cancellation and revocation remain live. Denial, input rewriting and feedback after actual tool completion are independent; Stop may continue within one Turn, and automatic continuation does not synthesize user submissions. Package commands receive package/data environment variables; configuration commands receive neither package environment nor additional path authority. Provider secrets do not propagate to hook descendants.

Core retains admission records in `desktop.hookRuns`. UNKNOWN blocks further execution; after inspecting actual effects/resources, `areal/hook/acknowledge` stores a bounded explanation while retaining UNKNOWN and never replaying. Archive and close cancel and join admitted tasks before SessionEnd; closing Sessions reject new Turns. Background results project only at safe points or the next user Turn, without starting an idle Turn.

Trusted command hooks now use bounded Runtime task write groups: same-task hook/tool overlap is admitted within a fixed window; ordinary/ordinary and cross-task conflicts remain exclusive. The window cannot be extended, and operations after sealing may queue behind foreign tasks. P2 remains open: Side, research and restricted Profiles remain excluded; ordinary read-only children require separate command consent. Windows shell, the full configuration stack and pinned Codex binary comparisons are unaccepted. See the [P2 matrix](../development/codex-plugins-p2-acceptance.en.md).

Ordinary read-only child command hooks require a separate consent box after reviewing the current definitions. CLI adds `--allow-read-only-commands` to `hooks-trust`; leaving it out removes this extra consent. The workspace/package remain read-only, private child scratch and own plugin data are writable, and network/provider-secret inheritance is denied. Redirected data directories reject execution. Side, research, nativeTaskAgent, restricted Profiles and read-only root Sessions remain excluded; MCP handlers are excluded from this consent.
