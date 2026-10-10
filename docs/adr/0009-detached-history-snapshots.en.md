[中文](0009-detached-history-snapshots.md) | **English**

# Use detached immutable history snapshots owned by the target

Decision identifier: SCF-ADR02 · Status: proposed

A historical boundary can span cold segments, summaries and media references, so copying hot turns is insufficient. Creation materializes the selected logical prefix into a target-owned immutable snapshot, used as inherited history by forks and reference evidence by side chats. Bounded creation-time I/O is accepted in exchange for verifiable independence from source changes and archival.

## Trade-offs and consequences

Client-side transcript copying and a general mutable parent-chain or branch DAG are rejected for P0. Content-addressed bytes may still be shared. Current source checkpoints are not copied; summaries are rebuilt from the exact raw prefix, and garbage collection must retain snapshot references.
