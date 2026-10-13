[中文](plugins.md) | **English**

# Codex plugin packages

Shared Core owns plugin installation and selection; GUI and CLI read the same state. Current scope covers local/Git marketplaces, pinned Git/npm packages, Skills/onboarding, trusted MCP connections and desktop Apps. GitHub is the first real Connector service. See [upstream pins](../../upstream/pins.json) and the [implementation/acceptance plan](../development/codex-plugins-plan.en.md).

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

Paths resolve against the marketplace root, not the catalog directory. GUI Settings → Plugins → Plugin packages can add another local root, inspect components and install. Installation binds the selected source and digest; changes after preview require refresh and renewed selection. Installation runs no scripts, MCP, hooks or setup.

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

An explicit project selection overrides the user default; neither represents an enforced requirement. Explicit Profiles do not acquire every package. MCP connections require explicit trust in the installed digest; Connectors require an original-ID mapping and account credentials. Unsupported hooks/auth mechanisms/commands/dependencies remain diagnostic. Installed does not mean connected.

## Skills and setup

Ordinary chats can select enabled package skills. Skills that prohibit implicit invocation remain available for explicit selection. Resources use paginated lazy reads. Shared package resources resolve relative to the skill while remaining within its pinned package root. Standalone skills retain live-file and traversal contracts.

Run Setup selects the packaged onboarding skill in an ordinary chat, with results and approvals accessible there. It uses ordinary Core inference and submission receipts, not privileged installation scripts. Side and restricted Profiles cannot expand their boundary through setup. Configure a usable model before running setup.

## Versions, disabling and recovery

Installed copies retain content identity; source edits do not change installed resources. Active Turns pin skill revisions; subsequent Turns use available versions. Disabling/uninstalling revokes subsequent reads while retaining historical packages and writable data. Explicit connection starts MCP. Active Turns retain their admitted generation; disable/uninstall revoke subsequent calls and reads. Unconfirmed process cleanup blocks reconnection. Hooks remain unsupported.

Mutations require `requestId` and applicable `expectedRevision`; RPC installation additionally requires selected `source` and `expectedDigest`. Identical requests recover their prior result; reused keys with different parameters reject. Check Plugin Submission queries receipts after an unknown outcome without replay:

```sh
areal plugin --workspace /absolute/workspace submission REQUEST_ID
```

Core enforces permissions; observers and Thread-scoped identities cannot perform global plugin management. State lives under the Core configuration home's `plugins/`, without modifying Codex caches/configuration.

## Current limits

Git/npm sources, MCP connections, desktop Apps and an explicit GitHub Connector mapping are integrated. Full compatibility is not accepted: P2 hooks, native form uploads, modern 2026 MRTR, some portable auth mechanisms, private OpenAI catalog/sharing, cross-platform and packaged acceptance remain gaps. Unsupported upload forms decline the entire schema. Hosted service methods return explicit capability errors. See the [acceptance matrix](../development/codex-plugins-p1-p3-acceptance.en.md).

## Git/npm and MCP

Add a Git marketplace in the GUI. Entries accept `git-subdir` with `url/ref/path` and `npm` with `package/version/registry`. Resolve and preview before installation, reviewing the pinned commit, concrete npm version, integrity and content digest. Git refs and npm ranges become immutable candidates; installation runs no lifecycle scripts. Candidate and installed digests remain separate. Explicitly trust the installed digest before connection, and review upgrades again.

Portable and legacy adapters normalize command/environment/HTTP/auth fields privately. Server policy controls tool enablement, required status, approvals and model output limits. OAuth uses private storage and a loopback PKCE callback; explicit retries recover rejected credentials and refresh/login ownership is coordinated. MCP operations are never replayed after auth failure. Unsupported portable mechanisms remain visible in the acceptance matrix.

## Desktop Apps and GitHub

The Apps tab and global/thread/file entrypoints use the official MCP Apps AppBridge. Pages run under isolated origins in sandbox frames with no Node, product bridge or credentials. Calls bind project, Thread, package digest and connection generation, stay on the originating server, and use ordinary Core execution, approval and journal paths. Persisted Apps become stale after Core restart and must be reopened.

`ui/message` adds typed text/resources to drafts while preserving unfinished human input; only `send:true` submits. Titles and `_meta` stay in UI/history; recursive `_meta` removal precedes model projection. Context is grouped by instance and can be updated/removed. Settings, mentions and form previews use advertised tools/resources, without guessed methods or endpoints.

GitHub preserves the original `.app.json` Connector ID. Enter that ID and a GitHub token in plugin details, save through system secure storage, then explicitly connect. Core maps that configured ID to `https://api.githubcopilot.com/mcp/`; opaque IDs never imply a provider. Missing mapping, missing credentials and unsupported declarations are distinct. Real read-only `get_me` evidence is separate from deterministic model/desktop fixtures.

File entrypoints expose opaque URIs. Core validates saved grants and reuses Runtime descriptor traversal for actual I/O; Main owns windows/watchers. Reads are capped at 2 MiB, atomic writes at 64 KiB with `too-large` responses. ETag/CAS and durable request receipts ensure same-key retries return prior results without overwriting later edits.
