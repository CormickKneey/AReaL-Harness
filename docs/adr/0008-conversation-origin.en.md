[中文](0008-conversation-origin.md) | **English**

# Keep conversation provenance separate from agent delegation

Decision identifier: SCF-ADR01 · Status: proposed

Existing parent-child threads carry Session, Goal and parent-turn cancellation semantics. User-initiated forks and side chats instead receive independent root threads and sessions with separate origin metadata. This adds a relation understood by conversation navigation, while preserving the meaning of agent delegation.

Source implementation is available behind the development flag, as described in the [desktop API](../api/desktop.en.md#turn-fork-development-preview). The decision remains proposed while native desktop and complete P0 acceptance are pending; focused source checks do not establish those results.

## Trade-offs and consequences

Reusing parentThreadId would save a field but conflate provenance with control, budget and authorization. Evaluations and reporting must use explicit entry threads and conversation kinds rather than treating every root thread as the primary task.
