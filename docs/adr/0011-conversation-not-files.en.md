[中文](0011-conversation-not-files.md) | **English**

# Separate conversational forks from filesystem state

Decision identifier: SCF-ADR04 · Status: proposed

Choosing a historical turn can suggest that files also return to that point, but the current system has no complete workspace snapshot for every turn. P0 forks only the conversation and explicitly selects and displays the shared current workspace without Git resets, stashes or implicit worktrees. Consequently it cannot promise concurrent-write isolation between branches.

## Trade-offs and consequences

Full file snapshots and isolated worktrees are separate future capabilities. An idle-source check is not a workspace lock. Historical tool observations do not prove that current files are unchanged, and both the model and UI must preserve this distinction.
