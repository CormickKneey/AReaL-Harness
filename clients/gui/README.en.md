[中文](README.md) | **English**

# AReaL Harness GUI

The complete desktop client contains a React renderer, Electron native adapter, and public dependencies. It is a peer of CLI/TUI/Web in the Clients layer. Core owns sessions, history, model loops, and scheduled tasks; Runtime executes tools. Mobile source migration is deferred; desktop pairing remains available.

## Development

Run from the repository root with Node.js 22.19+, pnpm 11.7.0 and the repository Rust toolchain:

```sh
make build
make gui-install
make gui
```

`make gui-build` builds only the renderer. `pnpm --dir clients/gui typecheck` checks renderer types; `pnpm --dir clients/gui run verify` checks the public source boundary. This module has its own pnpm lockfile; existing SDKs retain npm. Dependencies use the public npm registry; initial Electron/Core tool installation needs network access.

`AREAL_CORE_BIN` selects an absolute trusted Core path; development defaults to `target/debug/areal`. Development data is isolated under `AReaL Harness GUI Dev/<checkout digest>`; installed builds use `AReaL Harness GUI`. Existing desktop installations and data are not imported or replaced. `AREAL_GUI_USER_DATA`, `AREAL_CORE_HOME`, `AREAL_HARNESS_HOME`, and `AREAL_CORE_CONFIG` explicitly select isolated directories/configuration.

Both development and installed macOS builds require a working `/usr/bin/python3` to launch Runtime and trusted tool helpers; install Xcode Command Line Tools with `xcode-select --install`. The interpreter is not bundled. Shared-service startup checks availability and returns an actionable error.

## Composer

New drafts and existing chats share the grouped action/Skills catalog and search through `+` and `/`. Arrow keys select, Enter confirms, and Esc closes it. Skills attach to the current message; Core reads their content before sending, and failures preserve the draft and tags. The model control opens effort first, then the actual model catalog. Effort values come from Core adapter capabilities; remote provider support needs separate verification.

Images show thumbnails. “Show in text box” appends UTF-8 text attachments to the body. Pasting more than 200 characters or at least five lines creates a text card; expansion is limited to 1 MiB. Removing files or skills preserves the body. Goal mode uses the same editor; goal creation consumes only the objective and leaves other attachments unsent. `pnpm --dir clients/gui run test:composer` verifies these paths with isolated Electron/Core/Runtime instances.

## Subtasks and delivery

Describe the objective in the ordinary composer; Core arranges child execution. The Subtasks panel presents progress, verification evidence, and delivery status together. Open a child's process to inspect its history; Core continues to own waits and cancellation. Passing checks, pending application, conflicts, partial application, and unknown outcomes remain distinct. Candidate deliveries support paginated file previews and whole-change application managed by Core. If the original task is no longer active, continue it to accept delivery; the interface never labels an unapplied candidate as success.

Advanced legacy delegation and Workgroup history retains manual read-only delegation, explicit plans, and historical inspection. These controls are not prerequisites for ordinary tasks. When an older Core lacks the unified execution interface, the panel explains the limitation and keeps legacy history accessible.

## Lifecycle

The renderer accesses the desktop adapter through narrow preload IPC. The independent adapter connects through `areal service ensure/restart/stop --json`, without managing Core PIDs. GUI exit disconnects the interface and settles GUI-owned terminals; Core Turn/Goal and configured scheduled tasks continue. Reopening restores authoritative snapshots without replaying submissions. Stopping the background service is explicit; safe stop rejects busy instances.

The adapter retains credential encryption, subscription forwarding, and mobile pairing, without another Agent loop. The subscription transport's local capability and fixed loopback port persist in a mode-0600 file under a private directory; upstream account/API credentials use OS secure storage. Adapter exit interrupts active forwarded HTTP responses. Stable transport identity supports subsequent requests, not uninterrupted streams through crashes. Normal GUI exit retains the adapter.

The registry defaults to `~/.areal/gui/<GUI data directory digest>` to keep macOS Unix socket paths short. CLI clients must explicitly use the GUI's `AREAL_HARNESS_HOME` and instance descriptor to reach the same instance; default CLI and GUI data locations are separate. Authentication descriptors never enter the renderer. See [shared local services](../../docs/api/local-service.en.md).

## Local installation and acceptance

```sh
make gui-package
make gui-smoke
```

Packaging defaults to the already-built debug Core. Run `make release` and set `AREAL_CORE_PROFILE=release` to package release Core. `clients/gui/dist/local-*/` contains a copy-installable `.app`, ZIP, dependency inventory, and Core integrity manifest. `AREAL_GUI_PACKAGE_DIR` selects a fresh output directory. This local acceptance target is macOS arm64; packaging performs no Developer ID signing, notarization, or publishing. The app and Core executables use local ad-hoc signatures without private signing materials. Existing installation upgrades and update-feed continuity are deferred.

`make gui-smoke` runs real Electron/Core/Runtime against a deterministic local HTTP model with native sandboxing enabled. The project picker is injected with an isolated temporary workspace. Local model requests connect directly over loopback, preserving and merging existing `NO_PROXY` / `no_proxy` entries. Screenshots and `manifest.json` remain in the printed temporary directory; the manifest records Core binary checksums before and after the run and any failure reason. Set `AREAL_GUI_EXECUTABLE` to the absolute installed app executable for package testing; that mode uses bundled Core instead of an external binary. Real account login, paid models, other operating systems, and signed distribution require separate acceptance.

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md). Runtime icons retain the source repository's versions; capture archives, development Skills/AGENTS, and source Git history are excluded.
