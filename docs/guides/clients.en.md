[中文](clients.md) | **English**

# CLI, TUI and local Web

Complete the [quickstart](quickstart.en.md) first. Clients share Core history; Runtime executes tools without requiring a Codex binary.

## Launch

```sh
make tui
make tui ARGS='--resume THREAD_ID'
make tui ARGS='--workspace /absolute/task --allow-write --prompt "Describe the task"'
# Connect using the authentication file in the existing Core data directory
make tui ARGS='--endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json'
```

Without an endpoint, TUI uses its embedded launcher to start Core/Runtime on a random loopback port and shuts them down on exit. An explicit endpoint (alias `--remote`) connects to an existing service and only disconnects on exit. Local deployment arguments cannot be combined with endpoint mode.

The default data directory is `~/.areal-harness/state`, with `launch-*.log` files inside it. Keep data and trusted binaries outside writable workspaces. A data directory has an exclusive lock; configure separate directories for multiple instances. The launcher uses system `/usr/bin/python3 -I -S` without importing workspace code.

`areal -p 'prompt' --output-format stream-json --verbose` provides noninteractive CLI operation; `areal serve` starts a persistent service. See the [CLI contract](../api/claude-cli.en.md) for arguments, authentication, resume and exit codes. Web is served at `/ui`; log in with the local token from `security/auth.json` in the service data directory.

TUI `--input-file /absolute/input.json` is mutually exclusive with `--prompt` and accepts a Core Input array up to 2 MiB, for example `[{"type":"text","text":"Inspect the image"},{"type":"localImage","path":"/absolute/image.png"}]`. Both local and explicit-endpoint modes support it; the trusted launcher forwards `--tui --input-file`. Media paths and fields remain subject to [Core API](../api/core.en.md) validation.

## Web controls and appearance

Web uses a neutral workbench layout: a collapsible 240px sidebar, a task heading with view tabs, centered conversation content, and a rounded composer. Its light and dark appearance follows the AReaLGameAgent workbench. It follows the system by default; use “Settings → Appearance” at the bottom of the sidebar to override it. The preference is stored in the current browser. Narrow screens use a dismissible navigation drawer.

- Create, select, refresh, or paginate tasks from the sidebar. New tasks center the composer; once history exists, the composer stays at the bottom.
- Enter the access token in “Settings → Local connection”. Authentication errors appear inside settings. After a disconnect, authenticate again to reconnect and restore the current task snapshot.
- Enter sends; Shift + Enter inserts a newline. Confirming an input-method candidate does not send. While a task runs, send additional instructions or stop execution.
- Expand “Persistent goal” above the composer to inspect budget and progress, create or edit a goal, pause, resume, or clear it. The stop button pauses an active Goal; automatic continuation Turns retain their source label.
- “Task history” displays messages and expandable tool results; UNKNOWN tool results still require an inspection record. “Collaborative tasks and acceptance” retains plan submission, progress queries, cancellation, and revision controls.

The Web client owns appearance and navigation; task, permission, and execution state come from Core.

## TUI controls

| Control | Behavior |
|---|---|
| Enter | Start a Turn when idle; steer while running |
| `/`, Tab, Esc | Slash candidates, completion and dismissal |
| Ctrl-C / Ctrl-Q | Pause the current Goal and cancel its Turn (interrupt the Turn without a Goal) / exit |
| Ctrl-R | Reconnect and restore a snapshot without replay |
| F5, `/sessions`, `/new`, `/open ID` | Select, create or open sessions |
| F6, `/model` | Select a model or reset to default while idle |
| F2, `/theme` | Preview; Enter saves and Esc reverts |
| `/agents`, F3, `/topology` | Child-task tree and root topology |
| `/spawn prompt` | Manually spawn a child of the active Turn |
| `/tasks`, `/groups` | Plan and Workgroups |
| PageUp/PageDown/Home, End | Read history; End resumes following |

`--prompt` emits only the current Turn's text, writes Thread ID to stderr and exits nonzero on failure. It skips TUI preferences. See [appearance configuration](configuration.en.md#tui).

## History, recovery and observability

Core retains original history and tool intents/results; context compaction only changes future model input. Workspace-root `AGENTS.md` is read through Runtime (regular UTF-8 file, up to 32 KiB); nested instructions are not recursively loaded. Default delegation shares the workspace; use [Workgroups](workgroups.en.md) for isolated writes.

Restart marks unconfirmed tools/hooks UNKNOWN and blocks new Turns. Inspect actual files/processes, then record the inspection in Web or via `areal/tool/acknowledge`. History remains unknown. This neither replays operations nor approves permissions or restores old processes. Corrupt snapshots are not silently discarded.

```sh
export OTEL_SERVICE_NAME='areal-core'
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4318'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
make server
```

OTLP supports HTTP/protobuf only. It is disabled without an endpoint and can be disabled with `OTEL_SDK_DISABLED=true`. Default spans contain IDs, usage, status and timing rather than prompt bodies or credentials. Export failure does not change Turn outcomes.

<a id="goals"></a>
## Goal mode

No configuration change is needed. In TUI, `/goal Complete the module migration and pass its tests` creates and starts a Goal; `/goal` reads it. `/goal-pause` pauses; after Turn cleanup, `/goal-resume` resumes. `/goal-edit New objective` and `/goal-budget 200000` (or `none`) edit a stopped Goal while retaining usage. `/goal-clear` requires a stopped Goal with settled queues/resources. Web provides the same controls in its Goal panel.

Clients display status, token usage, active time, Turn count and stop reasons, and label automatic continuation Turns. Ordinary final text only ends its Turn. The model reports completion through `goal_update`; Core commits the final state after resource settlement. User input takes priority over automatic continuation and invalidates prior completion requests.

```sh
make tui ARGS='--goal "Complete the module migration and pass its tests" --goal-token-budget 200000'
target/debug/areal-tui --endpoint ws://127.0.0.1:4500 --goal 'Inspect the code and prepare migration recommendations'
```

`--goal` conflicts with `--prompt`/`--input-file`. `--resume THREAD_ID` can create a new Goal in an existing idle Thread. Headless mode waits across Turns, exits successfully only for completed, and prints Goal JSON/reasons with a nonzero exit for other stopped states. Remote headless exit/disconnection does not cancel server execution; local launcher exit shuts down its Core. Use interactive `/open` and `/goal-resume` for stopped Goals. Ordinary `--prompt` and Claude CLI retain single-execution semantics.

Core restart restores active Goals as paused/serverRestarted; `thread/resume` does not restart them. Unknown model usage retains its reservation; explicit Goal resume acknowledges it without erasing consumption. Tool UNKNOWN still needs inspection and acknowledgement. Budget, active-time, Turn or history exhaustion stops execution without automatic retry. See [configuration](configuration.en.md#goals) and [Core API](../api/core.en.md#goals).
