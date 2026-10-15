[中文](context-management.md) | **English**

# Context management simplification proposal

This page proposes a budget and compaction refactor. The [Core contract](../api/core.en.md) and [configuration guide](../guides/configuration.en.md) describe implemented behavior. The 131072-token fallback window, 16384-token default HTTP output cap and full retention of the latest compacted user request are implemented. The unified allocator and failure commit rules below remain proposed.

## Problem and goal

Solve windows, recent originals, checkpoint inputs, evidence, summary input and summary output currently have separate budgets. Retained inputs and evidence each have an internal soft quota of min(8192, available input window / 4). These local budgets do not establish whether the final request is complete, and prioritizing the initial question can displace subsequent corrections. A larger window only delays this failure; retention policy must address it.

Core should allocate tokens for each complete request, always retaining the latest real user request and unresolved tool operations. Older material can be summarized or retrieved. Durable history remains independent of model projection trimming.

## Configuration consolidation

| Setting | Proposed behavior |
|---|---|
| `model.context_window_tokens` | Common setting declaring the actual window; global fallback is 131072 tokens |
| `model.max_output_tokens` | Common setting; overridable per-model HTTP request default of 16384, strictly positive |
| `context.mode` | Keep auto / manual / disabled |
| `context.target_tokens`, `context.recent_tokens` | Move to compatibility handling; automatic policy covers normal use, while explicit legacy values remain effective and retain source diagnostics |
| `context.output_reserve_tokens` | Keep as an advanced minimum reserve; normal use reserves the output cap automatically |
| Legacy token / byte fields | Continue parsing with existing semantics; remove from common examples without silently ignoring explicit values |
| Internal input and evidence quotas | Remove the two independent fixed quotas and allocate from the complete request budget |
| History storage, request bytes and tool-result protection | Keep their independent responsibilities; token budgets do not replace storage or transport protection |

Do not add a retained-input quota setting. Common settings are window, output and compaction mode, preserving provider/model parameter precedence. Summary-specific reasoning effort and output settings remain advanced options rather than becoming ineffective configuration.

## Unified planning for complete requests

For window W, reserve R is the larger of the request output cap and explicit reserve floor. Available input is W − R, giving default HTTP requests 114688 tokens for the entire input. Planning and sending share message construction and accounting, including live instructions, tool schemas, media and protocol envelopes. Preserve full provider input-usage calibration and conservative headroom for media estimates.

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

## Implementation stages

| Stage | Location | Deliverable |
|---|---|---|
| Request retention and defaults | `core/engine/src/history.rs`, `model.rs`, `lib.rs`, `core/config/src/resolve.rs` | Mandatory latest request, 128k / 16k defaults and explicit parameter precedence; implemented |
| Unified planning | `core/engine/src/context.rs`, `history.rs` and existing solve entry points | One plan drives splitting, checkpoint assembly and final preflight; remove independent input/evidence quotas and initial-question priority |
| Transactional compaction | Existing `compact_context` and Store commit paths | Commit validated candidates only, preserve state on summary failure, check concurrent steer |
| Configuration and diagnostics | `core/config`, `core/server`, public protocol and Clients projections | Adapt legacy fields; show window, reserve, full input estimate, compaction reason and failure classification; synchronize types, SDKs and bilingual documentation |

Preserve Clients → Core → Runtime ownership. GUI displays Core budgets and outcomes without trimming authoritative history itself. Read old checkpoints compatibly and generate the new projection at the next successful compaction; do not bulk-rewrite user sessions.

## Acceptance

Use local model fixtures for multi-image corrections, an oversized latest input, superseded initial requests, repeated compaction and restart, old checkpoints, smaller-window model switches, explicit output overrides, reduced Goal output allowances, complete tool pairing, summary HTTP 400/empty/oversized content, cancellation and steer during compaction. Assert actual HTTP input, checkpoint commits and durable originals separately. Provider tokenizer accuracy and service compatibility require separate integration verification.
