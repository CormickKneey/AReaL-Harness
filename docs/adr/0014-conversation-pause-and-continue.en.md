[中文](0014-conversation-pause-and-continue.md) | **English**

# Continue paused work in the original conversation

Status: accepted. Product semantics are confirmed. Implementation and acceptance are separate.

Stopping a regular conversation currently ends its active Turn. Users can send another message in the original Thread, but there is no explicit Continue Execution action for unfinished work. Retain the original conversation, objective and recorded progress, and require the user to choose when to continue, including after restarting the application, background service or computer.

## Confirmed semantics

- Pausing retains the objective, history and existing results of unfinished work. Continuing stays in the original main conversation without requiring the user to restate the original request.
- Reopening the application or conversation shows its recoverable state. Work advances after the user selects Continue Execution; opening a conversation or reconnecting alone does not start execution.
- Continuing uses historical evidence and current workspace conditions to address remaining work. It does not promise to freeze or revive old model requests, commands, processes or exact execution positions.
- When an operation's outcome is unknown, inspect its result before continuing. Recovery must not assume an unknown operation never happened and execute it again.

## Interaction and execution scope

Present the existing primary Stop action as Pause Execution while work is running, and offer Continue Execution in the same primary action position after pausing. A regular conversation that completes normally retains its existing completion behavior and waits for the next user input. Adding a continue action does not automatically turn it into a Goal that advances across turns.

Unexpected interruptions, including power loss and Core crashes, also offer a manual continuation path. Show that execution was unexpectedly interrupted and include the known reason. Preserve existing failure classifications and UNKNOWN operation outcomes rather than overwriting them to present a paused state.

While paused with an empty composer, show a play icon named Continue Execution. When the user enters new content, switch to the regular send icon. Send that content as a new user message in the original conversation. It can refine or change the request and must not be wrapped in a hidden instruction to resume the old objective. Editing a draft alone does not start execution.

## Trade-off

Retaining the objective and progress lets users return later without relying on old execution resources remaining alive. Historical observations may have become stale, so continuing requires checking relevant current conditions. Pausing does not roll back file changes or external effects.

Exact execution-position recovery would require retaining model streams, tools and external resource state. It cannot provide a common guarantee for regular conversations across restarts and is therefore excluded.

## Edit the last user message

Offer a pencil action on the last user message. Users can edit the prompt inline and select Cancel or Send. Cancel retains the original message. Send replaces that message and subsequent replies and executes the revision in the same conversation. Core atomically replaces history and creates a new execution Turn; the UI and subsequent model context exclude the replaced content. For a steered message, earlier items in its Turn remain; later continuation Turns are replaced as well. An edit binds the latest Turn, message ID, and configuration revision. Stale targets, active execution, pending queue items, and uninspected UNKNOWN outcomes reject admission and retain the draft. Unknown submissions only query the original receipt. Existing file changes and external effects remain. Editing arbitrary historical messages and maintaining a version tree are outside this change.

## Queue and history

Pausing retains existing queued messages in the order chosen by the user. Continuing prioritizes these previously submitted requirements rather than bypassing later constraints.

Use existing conversation management without a separate abandonment flow. Paused work can remain paused indefinitely. Users can handle pending messages and archive the conversation while retaining its history.

Regular conversations interrupted before upgrading also offer Continue Execution when their last turn is explicitly interrupted. If the reason is unavailable, show a neutral interrupted status without guessing whether the user paused or the service exited unexpectedly. Normally completed conversations do not acquire a pending continuation state.

The [Core contract](../api/core.en.md) owns existing execution, UNKNOWN and Goal recovery constraints. See the [product vocabulary](../../GLOSSARY.en.md) for main conversations, turns, pausing and continuing.
