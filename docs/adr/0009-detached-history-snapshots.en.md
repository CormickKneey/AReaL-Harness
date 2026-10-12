[中文](0009-detached-history-snapshots.md) | **English**

# Use detached immutable history snapshots owned by the target

Decision identifier: SCF-ADR02 · Status: proposed

A historical boundary can span cold segments, summaries and media references, so copying hot turns is insufficient. Creation materializes the selected logical prefix into a target-owned immutable snapshot, used as inherited history by forks and reference evidence by side chats. Bounded creation-time I/O is accepted in exchange for verifiable independence from source changes and archival.

Source implementation is available behind the development flag, as described in the [desktop API](../api/desktop.en.md#turn-fork-development-preview). The decision remains proposed while native desktop and complete P0 acceptance are pending; focused source checks do not establish those results.

## Trade-offs and consequences

Client-side transcript copying and a general mutable parent-chain or branch DAG are rejected for P0. Content-addressed bytes may still be shared. Current source checkpoints are not copied; summaries are rebuilt from the exact raw prefix, and garbage collection must retain snapshot references.
