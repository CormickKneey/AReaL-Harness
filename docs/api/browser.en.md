[中文](browser.md) | **English**

# Browser v1 contract

**Proposed, not implemented.** Names below are proposals unless marked existing. Generate schemas and client types from canonical contract types. Preserve the existing [Core UNKNOWN rules](core.en.md#dynamic-tools).

## 1. Existing connections, new host capability

Reuse Core ↔ independent desktop adapter and the adapter’s authenticated local connection ↔ Electron Main. Renderer has no Core credentials. Add bounded reverse Browser requests/replies/cancellation on the latter channel, not a public browser port.

Actual execution uses existing `item/tool/call`, DynamicToolHost and `areal/tool/cancelled`. Add optional `areal.browser.host.v1` with protocol version, supported operations, browserHostId, hostGeneration and live Main availability. Only deployment-trusted clients register it. Validate IPC sender and owning window; identifiers alone are not permissions. Keep the adapter as the Thread’s single callback owner. A second `thread/resume` cannot steal an active host. Adapter survival after Main exit reports unavailable.

## 2. Model interface and discovery

The model tool `browser_v1` has a fixed envelope `{operation:string, parameters:object}` and rejects extra top-level fields. Size/depth are bounded; the selected operation strictly validates its parameters. This extensible envelope avoids changing persisted tool definitions as capabilities grow.

`describe` returns actual supported operations and concise documentation. Unknown operations/fields never become shell, JavaScript or raw CDP. Advertise only implemented capabilities. Supported intent surface:

| Operation | Purpose and constraints |
|---|---|
| describe | Current bound host documentation; no secrets or system endpoints |
| listPages / claimPage | Current Thread only; human-page metadata does not grant control; adoption preserves the object |
| newPage / navigate | Scoped HTTP(S) navigation and allocation; quotas and origin checks |
| observe | Scoped DOM/AX with Ref, truncation and frame coverage |
| capture | Provenance-bearing viewport/full/clip image; privacy and size limits |
| act | Single supported click/fill/key/scroll/hover/select/check/drag from an observation |
| wait | Bounded explicit state condition, not universal network-idle |
| closePage | Confirm closure of human/unknown-origin pages; no cross-Thread action |
| diagnostics | Bounded Console/network summaries, no default sensitive headers/body |
| runBatch | Up to8 known same-page actions/waits; per-step checks; no code or privilege escalation |

Every operation and user-facing error has behavioral tests. Core supplies Thread/Turn identity; model arguments cannot specify another thread, host, WebContents or CDP session. Unavailable operations fail explicitly rather than create a placeholder browser.

## 3. Trusted execution identity

This is a **new internal DTO illustration**, not an existing API or model-writable input.

```ts
interface BrowserExecutionContext {
  coreInstanceId: string;
  projectId: string;
  threadId: string;
  turnId: string;
  callId: string;
  requestId: string;
  browserHostId: string;
  hostGeneration: number;
  workspaceId: string;
  pageId?: string;
  pageGeneration?: number;
  controlEpoch: number;
  deadlineRemainingMs: number;
}
```

Use structural or unambiguous compound keys. Distinguish hostGeneration (host/native binding), pageGeneration (native object replacement), documentEpoch (main/frame document replacement), controlEpoch (claim/takeover/resume/revocation), viewportRevision (coordinate transform) and eventSequence (subscription cursor). A cursor is not authority. Every hop only narrows the remaining deadline.

## 4. Pages, contexts and events

One Browser Workspace per `(coreInstanceId, projectId, threadId)` initially, with multiple Pages. No cross-Thread transfers. Adopt an existing preview with its real Session; new sibling pages share that transient context; other Workspaces do not.

Controller provides atomic snapshot-and-subscribe. Install the snapshot sequence before consuming deltas; resnapshot after a gap. Do not assume independent read/subscribe is race-free. Broadcast metadata only; read DOM/images/network data on demand. Events: pageAdded/pageChanged/pageRemoved, controlChanged, operationChanged, hostAvailabilityChanged, viewportChanged and diagnosticsAvailable. GUI-only projections use the local channel; authoritative tool history remains Core Items. Filter by authorized project/Thread/window.

Orthogonal state dimensions: resource=`ready|suspended|crashed|closed`; control=`human|agent|transferring`; reachability=`connected|disconnected|incompatible`; operation=`prepared|dispatched|confirmed|rejected|unknown`. Controller owns physical facts; Core owns the official outcome. Restore a Page shell’s URL/title, not identity, forms, heap or login. Historic evidence is not a restored live page.

## 5. Observation and references

Observations include observationId, pageId, pageGeneration, documentEpoch, controlEpoch, URL/title, capturedAt, scope, truncation and frameCoverage. Visual observations also include CSS viewport, scroll offset, device scale, page zoom, bitmap size and viewportRevision. Capture is a timepoint, not a lock on the website.

Prefer meaningful visible text, role/name/state and actionable Refs. Preserve labels, errors, associations and frame provenance. Explicitly mark unsupported frames unavailable, not empty. Private Ref identity includes page generation, frame, frame document and backend node. Public IDs never recycle into a different node. Missing/stale Refs fail; there is no name/XPath fallback to a replacement target.

Prepare and dispatch check connectivity, visibility, actionability and hit-testing. Use bounded stability waits and real input rather than page-script click simulation. Whole-document mutation counters alone are insufficient. Coordinate actions use an explicit bitmap-to-CSS transform; never guess by multiplying DPR. Changed viewport/zoom/document requires a new screenshot.

## 6. Core approval and native execution: not a transaction

For mutating/navigation/external-effect operations:

1. Core records Tool Intent and validates the trusted bundle, Thread and policy.
2. A **new read-only server request** `areal/browser/prepare` resolves live target facts. It cannot send input, navigate, upload or allocate a new page. New-page allocation is planned only.
3. Host returns an expiring preparedActionId, canonical plan/digest, target description, Origin, scope, epochs, budget and risk reasons. Escape page-derived labels as untrusted text. Core persists the actual plan rather than trusting model intent.
4. Core extends its existing permission/ApprovalRequest domain for browser plans. Only Core decisions grant execution. High-impact or semantically unknown external submissions use human takeover. An explicitly authorized development Origin may have a bounded Workspace development grant.
5. Core adds the approved plan identity and grant to **trusted callback metadata**, not model arguments, on `item/tool/call`. Existing non-browser tools remain unchanged.
6. Host revalidates expiry, origin, all relevant generations, plan digest and target immediately before dispatch. Changed context returns plan_stale, never silently replans/retries.

This requires an optional read-only preparation interface on DynamicToolHost and a correlated prepare response. Core can record non-dispatch on prepare failure only when it knows no execute was sent. Existing tool errors are not globally reclassified. Core owns durable approvals; Controller holds short-lived prepared records, not a second persistent authorization database. Outer tool permission never overrides a local takeover fence.

## 7. Human takeover

The local takeover control synchronously increments controlEpoch, rejects old inputs, drains not-yet-dispatched work and pauses automated observations. It runs in a priority lane, not behind a long action. Release synthetic held keys/buttons within a bound; website effects already dispatched are not reversible.

The local fence is immediate, but opening human input requires a native input-quiescence barrier: settle dispatched synthetic input, release held keys and guarantee no further old-epoch input dispatch. This waits only on the local native channel, not Core. If quiescence cannot be established within a bound, remain transferring, prevent concurrent writers and offer safe page stop/closure. Do not label a requested takeover as completed. Already-triggered website/network effects may continue and remain UNKNOWN.

Then publish human state and notify Core. With no dispatched input, user_control is a known refusal and subsequent Browser admissions are blocked; other independent work may finish. Do not automatically start another Turn. Ambiguous in-flight input follows existing UNKNOWN fail-stop semantics.

Human control also pauses DOM/image/Console/network collection and delivery. Keep only internal safety/lifecycle signals; discard potentially sensitive diagnostics from manual login by default. Reads/captures begun before takeover must recheck controlEpoch before delivering to the model/history; discard stale-epoch results. Already-shared evidence cannot be retracted. Explicit resume starts a new epoch, clears old prepared/observation handles and requires fresh observation. “Resume and continue” may combine user-authorized control and an existing idempotent submission, but never replay an old call; UNKNOWN first requires inspection/acknowledgement.

## 8. Receipts, deduplication, deadlines and cancellation

Dedup key: `(hostGeneration, threadId, turnId, callId, stepIndex)`. requestId is transport correlation only. Equal key/equal parameters share one in-flight execution or return its known receipt; changed parameters conflict. The bounded cache must never treat missing historical state as permission to resend. Host restart does not restore execution eligibility.

| Facts | Core outcome | Consequence |
|---|---|---|
| Invalid/denied/stale/user-control/quota/unsupported and certainly not sent | success=false, code, dispatch=not_sent | Correct/observe, not automatic takeover |
| Confirmed action | success=true with receipt | Verify business result separately |
| Confirmed action but failed business check | action succeeds, verification fails | Inspect and decide a new action |
| Execute sent but receipt lost, timeout/crash/cancel ambiguous | RPC error/existing UNKNOWN | Stop automatic execution; inspect, never replay |
| Batch prior steps confirmed, later step certainly not sent | confirmed receipts + known failure + remaining not sent | Do not repeat prior steps |
| Any batch step ambiguous | tool UNKNOWN, preserve confirmed prefixes | Dispatch no remaining steps |

Separate prepare, approval, execution and transport timeouts. Inner work ends before outer deadline to return a structured receipt. Approval does not use the short action timeout. Initial policy: action5s default/30s maximum; wait3s default/30s maximum; batch≤8 steps/30s execution total. These are adjustable protection values, not measured performance claims. Local budgets use monotonic time.

Propagate existing `areal/tool/cancelled` by original request and generation. Best effort is not rollback. Late receipts may aid inspection but cannot resurrect a Turn or silently change finalized UNKNOWN.

## 9. Resources, media and safety

Keep the existing window-wide8-native-page cap, initially4 pages per Workspace. Pin executing pages, active human-control pages, blocking dialogs and file handoffs. Reject capacity if all candidates are pinned. Hide retains resources; eviction/suspension is explicit for idle pages with state-loss disclosure. Limit each Workspace queue to16 and reserve control capacity.

Observation defaults:200 actionable nodes/32KiB text; explicit expansion up to1000/128KiB. Console/network buffer per page≤200 entries/256KiB, no body by default. Mark truncation. These are initial policy limits, not optimized measurements.

Core’s4MiB WS frame limit governs end-to-end transport even if the adapter permits larger frames. Bound image pixel/encoded size. Reuse the current Core media/Blob upload, MediaRef and contentItems contracts; do not define a competing Browser media system. Use existing chunk upload only if available; otherwise reject or reduce preview resolution, never expose an unauthenticated file server. Full evidence is a Thread-authorized Core Blob. The model receives the supported image projection when visual judgment is needed, not only an inaccessible artifactId. Record redacted URL, time, viewport, page/document generations, callId and optional code/build identity; leave unknown provenance unknown.

Retain sandbox, contextIsolation, webSecurity, navigation/frame and IPC checks. No remote-page Node/preload/product bridge. Deny file/javascript/data top-level navigation, credential-bearing URLs, private product protocols and OS/shell access. Browser Profile is not Agent Profile. Block Core/adapter control endpoints even on localhost.

Authorize precise development Origins, not every local/private/metadata address. Check redirects and frames. Navigation allowlisting is not an egress sandbox: requests, workers and WebSocket need coverage or explicit disabling/restriction to trusted development sites. Never claim comprehensive exfiltration prevention from top-level URL checks alone.

Do not expose cookie/storage export, browser-wide CDP, arbitrary evaluate or host paths. Diagnostics are scoped and permissioned. Redact password/token values, sensitive query items and Authorization/Cookie/Set-Cookie. Mask identified sensitive image regions; unknown sensitive content is not guaranteed detected. Manual sensitive flows use takeover. Downloads and user-selected uploads require separate authorization; no automatic executable launch.

### Trust model and residual risk

The primary threats are hostile web content, model mistakes, cross-Thread routing and untrusted Renderer input. Core, the authenticated desktop adapter and Main are trusted. This design does not defend against compromised Main, an OS administrator or another tool already granted unrestricted disk/network execution. Browser restrictions do not sandbox independently authorized host execution.

Redaction applies to automatic Browser capture/projection; secrets already supplied in chat or held by the model cannot be promised retracted from history. Prefer manual credential entry and do not expose password fields as agent action values. Unknown sensitive page content still requires the user’s observation decision.

## 10. Proposed Core extensions

Discover these **new** APIs by capability. Do not rewrite existing fixed Codex-compatibility definitions.

| Method | Request | Meaning |
|---|---|---|
| areal/thread/tools/attach | requestId, threadId, expectedToolsetRevision, bundleId=areal.browser.v1 | Trusted interact+tools client; idle Thread; atomic append-only deployed bundle and current host binding; conflict on different same-name schema; idempotent |
| areal/thread/observe | threadId | Atomic snapshot plus deltas with observe permission, without ToolHost rebinding; existing resume semantics unchanged |

toolsetRevision is optional with legacy default0. If storage cannot accept the additive field, explicitly version the snapshot and disclose downgrade incompatibility. Never edit persisted JSON by hand. Existing dynamicTools entries are immutable; only the deployed bundle may be appended. No arbitrary replacement/deletion. Changed input under the same requestId conflicts. Busy Threads or another active host are not stolen.

New GUI Threads can register the dispatcher; legacy activation is explicit. CLI/TUI use observe rather than becoming an Electron driver. Authorized submissions to a GUI-hosted Thread retain that host. With no GUI, Browser is unavailable rather than a new Chrome. Child agents do not inherit parent browser control by default.

## 11. Versioning and rollback

Turning the feature off returns to ordinary preview while preserving Browser history and never replaying live objects. Do not remove stored tool definitions or pretend an older binary can execute them. Block incompatible storage downgrades and document backup rather than changing version numbers. Update schemas/types/docs/fixtures with each contract change.
