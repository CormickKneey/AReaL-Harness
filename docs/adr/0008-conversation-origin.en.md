[中文](0008-conversation-origin.md) | **English**

# Keep conversation provenance separate from agent delegation

Decision identifier: SCF-ADR01 · Status: proposed

Existing parent-child threads carry Session, Goal and parent-turn cancellation semantics. User-initiated forks and side chats instead receive independent root threads and sessions with separate origin metadata. This adds a relation understood by conversation navigation, while preserving the meaning of agent delegation.

## Trade-offs and consequences

Reusing parentThreadId would save a field but conflate provenance with control, budget and authorization. Evaluations and reporting must use explicit entry threads and conversation kinds rather than treating every root thread as the primary task.
