[中文](0012-explicit-areal-contract.md) | **English**

# Expose an explicit AReaL derivation contract

Decision identifier: SCF-ADR05 · Status: proposed

The repository implements only a pinned subset of Codex, while this design also needs before-turn boundaries, durable business keys and independent provenance. Define these behaviors in explicit areal extension methods advertised through capabilities rather than changing the pinned upstream schema to imply full thread/fork compatibility. Clients need adaptation, but the semantics and authorization remain testable.

Source implementation is available behind the development flag, as described in the [desktop API](../api/desktop.en.md#turn-fork-development-preview). The decision remains proposed while native desktop and complete P0 acceptance are pending; focused source checks do not establish those results.

## Trade-offs and consequences

Storage-version gates protect persistent security semantics; API capabilities describe supported operations. P0 rejects creation by threadIds-scoped principals rather than implicitly deriving ACLs from provenance. Scoped creation requires a separate future review.
