[中文](context-management.md) | **English**

# Context management

Core owns request budgeting, compaction and durable history. The [Core contract](../api/core.en.md) defines the public projection; the [configuration guide](../guides/configuration.en.md) describes settings. The fallback window is 131072 tokens and default HTTP output cap is 16384 tokens.

## Problem and goal

One allocator plans complete requests, retaining the latest real user request and unresolved tool operations. Older material can be summarized or retrieved. Durable history is independent of model projection trimming. A larger window does not replace retention policy.

## Configuration consolidation

| Setting | Behavior |
|---|---|
| `model.context_window_tokens` | Common setting declaring the actual window; global fallback is 131072 tokens |
| `model.max_output_tokens` | Common setting; overridable per-model HTTP request default of 16384, strictly positive |
| `context.mode` | Keep auto / manual / disabled |
| `context.target_tokens`, `context.recent_tokens` | Automatic target/recent defaults are 0; positive legacy values remain compatibility boundary preferences with source diagnostics |
| `context.output_reserve_tokens` | Keep as an advanced minimum reserve; normal use reserves the output cap automatically |
| Legacy token / byte fields | Continue parsing with existing semantics; remove from common examples without silently ignoring explicit values |
| Internal input and evidence quotas | Remove the two independent fixed quotas and allocate from the complete request budget |
| History storage, request bytes and tool-result protection | Keep their independent responsibilities; token budgets do not replace storage or transport protection |

Do not add a retained-input quota setting. Common settings are window, output and compaction mode, preserving provider/model parameter precedence. Summary-specific reasoning effort and output settings remain advanced options rather than becoming ineffective configuration.

## Unified planning for complete requests

For window W, reserve R is the larger of the request output cap and explicit reserve floor. Available input is W − R, giving default HTTP requests 114688 tokens for the entire input. Planning and sending share message construction and accounting, including live instructions, tool schemas, media and protocol envelopes. Preserve full provider input-usage calibration and conservative headroom for media estimates. Compaction also obeys the same raw conservative estimate used by final preflight: smaller historical usage cannot bypass the hard window gate, while larger actual usage can still trigger earlier compaction.

Allocate in this order, retaining original roles and chronology:

1. Fixed instructions, the current Turn's latest real user request with attachments, unresolved calls and required paired results are mandatory. Automatic Goal continuation is not a new human request.
2. Include complete tool rounds and user corrections from newest to oldest as space permits. The initial question has no permanent priority.
3. Represent older material with one bounded checkpoint containing a summary, retrievable original references and execution receipts. Originals, evidence and summary share the remaining budget; prefer references for completed tool results.
4. Never trim the latest request to satisfy the old soft quota. If mandatory content cannot fit, return `LLM_CONTEXT_WINDOW_EXCEEDED` instead of answering an older task.

Initially retain the 60%-of-available-input compaction target as internal policy to provide headroom. When that target is unreachable but the hard window can still be met, record why and avoid repeated compaction without progress. Replan after model switches. Manual/disabled modes retain their explicit compaction and overflow boundaries.

## Compaction commits and failure

Compaction builds, validates and atomically commits a candidate. Before replacing the previous checkpoint, the candidate must cover a valid settled prefix, preserve the latest request and tool pairing, reduce context size and pass complete solve-request preflight. Summaries remain historical evidence with lower priority than new user instructions.

Summary request failures such as HTTP 400 preserve the previous checkpoint and originals, without committing a degraded summary that loses meaning. Only received but malformed summaries use the existing bounded validation repair. Do not repeat identical permanently invalid HTTP requests as validation retries. Transient network recovery retains cancellation, watchdog and Goal accounting constraints.

Continue only if the previous projection can fit the current request; otherwise report both summary failure and insufficient window. Check history boundaries and new steer before committing; replan if they changed. Store still writes immutable archive segments before snapshot references, without replaying execution effects.

## Module responsibilities

| Module | Responsibility |
|---|---|
| `core/engine/src/context.rs`, `history.rs` | One allocator and chronological projections, original retrieval, complete round boundaries and validated candidates |
| `core/engine/src/generation.rs` | Build actual live context, share accounting, preflight and rebuild after compaction or steer |
| `core/engine/src/desktop/context.rs` | Recorded-instruction/current-tool budget diagnostics and manual compaction |
| `core/config`, `core/server` | Defaults, explicit parameter precedence and legacy configuration compatibility |
| `core/protocol`, desktop schema | Public failure notification and budget projection; Clients consume Core diagnostics |

Preserve Clients → Core → Runtime ownership. GUI displays Core budgets and outcomes without trimming authoritative history itself. Read old checkpoints compatibly and generate the new projection at the next successful compaction; do not bulk-rewrite user sessions.

## Acceptance

Use local model fixtures for multi-image corrections, an oversized latest input, superseded initial requests, repeated compaction and restart, old checkpoints, smaller-window model switches, explicit output overrides, reduced Goal output allowances, complete tool pairing, summary HTTP 400/empty/oversized content, cancellation and steer during compaction. Assert actual HTTP input, checkpoint commits and durable originals separately. Provider tokenizer accuracy and service compatibility require separate integration verification.
