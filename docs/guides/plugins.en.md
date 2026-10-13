[中文](plugins.md) | **English**

# Codex plugin packages (P0)

Shared Core owns plugin installation and selection; GUI and CLI read the same state. Current scope covers local marketplaces, root Agent Plugins `plugin.json`, `.codex-plugin/plugin.json` skills and explicit onboarding. See [upstream pins](../../upstream/pins.json) and the [implementation/acceptance plan](../development/codex-plugins-plan.en.md).

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
areal plugin --workspace /absolute/workspace install review-helper@team-tools --scope project
areal plugin --workspace /absolute/workspace setup review-helper@team-tools
areal plugin --workspace /absolute/workspace disable review-helper@team-tools --scope project
```

An explicit project selection overrides the user default; neither represents an enforced requirement. Explicit Profiles do not acquire every package. Unsupported MCP, hooks, Apps, command migration and dependencies produce diagnostics. Installed does not mean every component can run.

## Skills and setup

Ordinary chats can select enabled package skills. Skills that prohibit implicit invocation remain available for explicit selection. Resources use paginated lazy reads. Shared package resources resolve relative to the skill while remaining within its pinned package root. Standalone skills retain live-file and traversal contracts.

Run Setup selects the packaged onboarding skill in an ordinary chat, with results and approvals accessible there. It uses ordinary Core inference and submission receipts, not privileged installation scripts. Side and restricted Profiles cannot expand their boundary through setup. Configure a usable model before running setup.

## Versions, disabling and recovery

Installed copies retain content identity; source edits do not change installed resources. Active Turns pin skill revisions; subsequent Turns use available versions. Disabling/uninstalling revokes subsequent reads while retaining historical packages and writable data. P0 does not run package MCP/hooks and makes no drain claim for those processes.

Mutations require `requestId` and applicable `expectedRevision`; RPC installation additionally requires selected `source` and `expectedDigest`. Identical requests recover their prior result; reused keys with different parameters reject. Check Plugin Submission queries receipts after an unknown outcome without replay:

```sh
areal plugin --workspace /absolute/workspace submission REQUEST_ID
```

Core enforces permissions; observers and Thread-scoped identities cannot perform global plugin management. State lives under the Core configuration home's `plugins/`, without modifying Codex caches/configuration.

## Current limits

Git/npm acquisition, full MCP/authentication, public hooks, MCP Apps/OpenAI desktop extensions and hosted Connector access remain subsequent stages. Parsing does not grant account access. Report source, filesystem integration, Core/CLI, deterministic-model, native desktop and packaged-install evidence separately. Full compatibility requires all necessary acceptance in the implementation plan.
