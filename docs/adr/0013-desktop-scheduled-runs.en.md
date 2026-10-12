[中文](0013-desktop-scheduled-runs.md) | **English**

# Separate desktop schedules from individual runs

Status: proposed. This records settled product direction; the complete contract remains under design and the feature is not implemented.

## Product direction

The GUI scheduling entry expresses what work to initiate and when, without a foreground/background selector. Schedules support one-time and recurring execution. Runs use ordinary desktop task interactions and depend on the desktop Host. Operations requiring approval show why execution is blocked and await user approval; approval does not expand deployment permissions.

Each run creates a new conversation without automatically inheriting previous model history; results remain associated with the same Schedule. This does not isolate working directories or file state. Desktop execution does not start while the Host is unavailable. On recovery, missed triggers coalesce into one catch-up execution. Triggers arriving while the previous run remains unfinished are skipped, without queuing or overlapping runs.

Project association reuses existing capabilities: users can select an existing project or use the GUI's existing independent workspace preparation path. Removing the need to select a project does not require introducing a new Core Workspace domain object.

## Interaction, recovery and controls

After approval timeout, preserve the blocked run and release current execution resources. An expired approval does not become a lasting authorization. When the user later chooses to continue, revalidate the current operation and request approval again. Blocked runs remain unfinished, so subsequent triggers are skipped.

If Host exit or service restart interrupts a started run, preserve its conversation and execution record and require explicit user recovery, without automatically restarting from the beginning. This differs from catch-up of unstarted schedules after Host recovery. Unknown side effects must not be automatically replayed.

Pausing a Schedule stops future triggers without stopping its current run. Stopping the current run does not cancel a recurring Schedule. Changes to work instructions or timing affect subsequent runs only. At the start of each run, read current model/configuration from its project or independent execution environment and freeze it for that run; later configuration changes do not alter started runs.

## Trade-offs

Reusing a conversation preserves continuity but carries earlier conclusions and instructions into subsequent checks. New conversations make model-context boundaries explicit. Cross-run material must be supplied deliberately, while execution records remain available together.

A single catch-up execution preserves an opportunity to perform missed work without accumulating a backlog. Skipping busy triggers avoids duplicate approvals and concurrent work from one Schedule, but does not guarantee a result for every planned timestamp.

## Current capabilities and design constraints

Current Core scheduled Tasks bind a fixed root Thread and reject interactive interactions and client dynamic tools. Ordinary desktop approvals wait 300 seconds by default. New conversations, Host availability and recoverable approvals require explicit extensions; asynchronous question Channels cannot substitute for tool authorization.

Core currently owns authoritative Task/Run state, while the desktop Host supplies client capabilities. Implementation should reuse these owners rather than introduce a Renderer timer or a second execution ledger. The precise scheduling and Host-readiness handshake remains undecided.

## Open boundaries

- GUI creation/editing flows, initial timing rules and their timezone semantics.
- Presentation of Schedule details, execution conversations and items requiring user attention.
- Compatible migration of existing schedules and execution records.
- Contracts between Core scheduling, desktop Host readiness and new-conversation admission; approval re-preparation and recovery of unknown side effects.

Current facts are described by the [Task contract](../api/tasks.en.md), [ordinary desktop approvals](../../core/engine/src/desktop/interactions.rs) and [client tool Host](../../core/app-server/src/dynamic_tools.rs).
