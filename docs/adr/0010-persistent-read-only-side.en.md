[中文](0010-persistent-read-only-side.md) | **English**

# Persist side chats and keep their read-only role immutable

Decision identifier: SCF-ADR03 · Status: proposed

Side discussions can contain durable decisions, while closing a window is distinct from ending Core execution. Persist a side chat when its first question is accepted; closing only hides its view. Core and Runtime enforce an immutable read-only role across recovery, accepting storage and navigation costs to avoid lost discussions and accidental privilege escalation.

## Trade-offs and consequences

Ephemeral-by-default chats and prompt-only restrictions are rejected. P0 has no in-place promotion, deletion or TTL. Unsent drafts retain the existing process-local GUI lifecycle. The persistent security role requires a data-version gate so older binaries cannot silently ignore it.
