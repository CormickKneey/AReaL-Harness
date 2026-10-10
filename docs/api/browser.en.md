[中文](browser.md) | **English**

# Browser v1 contract

**Design contract, partly implemented.** The current slice supports explicit claiming of an existing native preview in a new Browser-enabled Thread or an idle older Thread after Browser attachment, `describe`/`observe`/`capture`/`diagnostics`, Core-prepared Ref and screenshot-coordinate `act` and bounded `wait`, local takeover revocation, and missing-host rejection. Other operations below remain proposals. Existing [Core UNKNOWN rules](core.en.md#dynamic-tools) remain in force. Ticket 04's native B-10–B-13 acceptance is pending the unified M1 run.

The new-chat Composer Browser switch registers the fixed `browser_v1` tool package; an idle older Thread can enable the same package in Preview. After opening the current Thread's preview, the user clicks “Let Agent inspect this page”; Main claims the same WebContentsView and registers it through the authenticated service connection. The Thread's bound Core connection handles model callbacks. The extensible `operation:string` envelope is fixed. Secondary validation accepts `describe` (empty parameters), `observe` (`pageId`, optional document scope, Ref and budget), `capture` (current viewport), `act` (pageId, snapshotId and advertised Ref/screenshot-coordinate actions) and `wait` (pageId, 1–30000 ms). Bounded native accessibility reads report actual Frame coverage and expose role, name, state, value, and parent association where available. Refs bind to native node identity and generations; a budget-limited observation does not itself invalidate an omitted live Ref. Tool URLs omit query and fragment values. Capture is limited to 8 million pixels, 4096 pixels per side, and a 2 MiB PNG, then uses the existing Core Blob and tool media path for model and chat access. Automatic capture refuses known sensitive forms and unreadable Frames; this is not image masking and cannot identify every secret. Persistent Profiles are not available. Human takeover, navigation, and Core/host generation changes revoke reading; cancelled or timed-out calls are never replayed.

Known-sensitive capture checks and viewport measurements run in Electron's isolated world so page scripts cannot replace the DOM query methods or viewport getters used by those checks. Unknown sensitive content can still escape detection; the page itself remains untrusted.

The current action slice only prepares an explicitly claimed HTTP loopback page. Core approval may remember a development operation for that exact Origin, page and action kind. External pages return `human_takeover_required` at prepare. Each plan is short lived and binds the current snapshot, target, document, control epoch and viewport; a stale plan returns `plan_stale` with no retargeting. A confirmed input receipt leaves business verification as `not_checked`.

For the development loop, the Agent can inspect or start the current Thread's existing Core-managed service through `development_service_inspect` and `development_service_start`. The Process pane offers only explicit loopback URLs found in complete output of a running managed process; the user chooses one to open in the same native Preview. This output is endpoint evidence, not proof of listener readiness or a Browser permission grant. The Preview verification card links Core check, Browser observation/capture and file-write Items, with the original screenshot Blob and turn diff. It keeps command exit, visual judgment, loaded build identity and post-refresh behavior separate; a source fingerprint alone does not identify the loaded page. B-35/B-36 real desktop acceptance remains pending the unified M2 run.

Ticket 05 wires local control through Main: trusted takeover first synchronously revokes the old epoch, plans, and reads, then enters `transferring`. Main hides the native view, waits for dispatched CDP input to settle, and releases held synthetic keys and mouse buttons through the same channel. Human input resumes only after convergence is confirmed. If it remains unproved, the view stays hidden with stop-loading and close-page options. Visible local key and mouse-down events trigger takeover. Before a synthetic action, Main moves focus from a foreground native page to the product view and refuses dispatch if the page still owns focus; hiding the view alone is not treated as keyboard isolation. Automated observation and capture are rejected during human control, and late results are discarded by epoch. Explicit handback clears old observations and plans and requires a fresh observation before an action. “Hand back and continue” uses the existing `send` user-submission path for a new request; it never replays an old tool call. Existing inspection handles historical UNKNOWN; evidence already delivered to Core or the model cannot be retracted. Native and Core/GUI B-14–B-16 acceptance awaits the unified M1 run.

Ticket 11 adds trusted, user-initiated Preview IPC `captureElement`, `cancelElementSelection`, and `checkElement`; it does not add a model-writable `browser_v1` operation. Controller enables DOM and Overlay in one CDP session on the visible human Page, receives `inspectNodeRequested`, disables the overlay, then takes the existing privacy-guarded capture and reads the node's actual AX role/name, bitmap bounds, and Page/document/control identity. Selection and later reads check Core/Thread/Page/native WebContentsView identity, generations, display state and deadlines; cancellation or a page switch discards late results. The `human:` evidence Ref never enters the Agent-action Ref cache. A pre-stage change in node identity, semantics, bounds or viewport marks the original evidence `stale`. Only the crop and provenance enter the original Thread's Composer draft; explicit send uses the existing Core Blob/MediaRef and message-admission path. React source location is unavailable without an actual project-provided attributed mapping. Canvas or unresolvable iframe/Shadow content supplies a reason and region feedback entry; the existing capture privacy guard refuses an image for unreadable cross-origin Frames, so no crop is claimed in that case. Real native and Core/GUI B-29/B-30 acceptance remains pending M2.

Ticket 15 adds trusted GUI human Preview IPC `beginStyleTrial`, `applyStyleTrial`, `undoStyleTrial`, `redoStyleTrial`, `captureStyleTrialAfter`, and `clearStyleTrial`; the model tool definition stays fixed. Main accepts only a bounded text/color/font/spacing/size vocabulary on the private backend node chosen by Ticket 11's native inspection. It rejects arbitrary CSS, URLs, scripts, and Renderer selectors. Each step checks actual current property values, node connection, and Page/document/control generations in an isolated world. Application replacement or changes to an edited property stop replay. There are at most 20 steps. Clear restores an old value only while the current value still equals this trial's override; uncertainty requires reload rather than claiming source verification. Cross-document navigation discards old overrides; same-document navigation reloads the new route to discard any surviving override. Both before and after images use the existing privacy guard; only selected-element crops and the user's intent enter the original Thread's Composer draft. Explicit send uses existing Core media and message admission. Unknown source location stays labeled unknown. Real native and Core/GUI B-37/B-38 acceptance remains pending M2.

Ticket 12 adds the read-only `diagnostics` operation in source: `pageId`, `kind=console|network`, optional nonnegative integer `cursor`, and optional `limit=1–200` (default 50). Results include page/control/document generations, event sequence, next cursor, loss marker, and a per-page 200-entry/256 KiB buffer cap. Console uses live events from the current WebContents; network uses request/response/failure metadata from that page's CDP owner. Collection does not enable `Runtime` or `Console` CDP domains that may replay older logs. It retains query- and fragment-free URLs, methods, statuses and bounded errors, without bodies, headers or credentials; sensitive text is conservatively hidden. Takeover immediately clears and stops the buffer; handback begins a new control epoch, and late network requests are excluded by native creation time. Opening DevTools revokes Agent control; closing it requires a fresh claim and observation. Diagnostic tool results are Core Items scoped to the Thread, linked from the Preview verification card. Real Electron/Core/GUI B-31/B-32 acceptance remains pending M2; source checks do not prove native event timing.

Ticket 09's resource lifecycle source limits native Pages to eight per window and logical Pages to four per Workspace, checking before native allocation. Executing, transferring, visible human, prepared-plan, and file-handoff Pages are excluded from idle eviction; a new Page is refused when no candidate can be evicted. Eviction keeps the same Page shell's URL and title and reports state loss; reopening advances `pageGeneration`. Hiding alone does not navigate or close a Page. Archive, project hide, and window close revoke ownership and close the last reference to the temporary context; cancellation and late results cannot reveal an old Page or turn a dispatched operation into a known unsent one. Browser file handoff is not yet available, so downloads are refused before a file is created. B-24–B-26 still await unified real Electron/Core/GUI acceptance at M1.

The private Ref cache retains at most 1000 live identities per page. Current emitted Refs take priority; older evicted Refs return `stale_ref`, and public IDs are never reused. Capture checks known sensitive fields, including password, payment security code, and one-time-code autocomplete tokens with optional section prefixes, before and after the native image and refuses any observed DOM mutation during the capture interval. The guard covers the main document, readable Frames, and open Shadow roots; transient canvas pixels and inaccessible closed Shadow content cannot be proven clean, so automatic capture remains unsuitable for pages with unknown secrets.

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

Electron Main's sole Page map owns native objects. The trusted main view installs `preview.subscribe` and receives its snapshot; later events carry Page metadata only, and a sequence gap triggers resubscription. Human new, select and close Page commands come from the main view; closing a human or unknown-source Page requires explicit user intent. `browser_v1` `navigate` and `newPage` prepare read-only, pass Core approval, then execute against a Page ID and generations. For `newPage`, `pageId` names the opener and the receipt returns the new Page ID. A website popup may join the same transient context only after recent, one-use local human input; Main denies other native window requests.

Orthogonal state dimensions: resource=`ready|suspended|crashed|closed`; control=`human|agent|transferring`; reachability=`connected|disconnected|incompatible`; operation=`prepared|dispatched|confirmed|rejected|unknown`. Controller owns physical facts; Core owns the official outcome. Restore a Page shell’s URL/title, not identity, forms, heap or login. Historic evidence is not a restored live page.

## 5. Observation and references

Observations include observationId, pageId, pageGeneration, documentEpoch, controlEpoch, URL/title, capturedAt, scope, truncation and frameCoverage. Visual observations also include CSS viewport, scroll offset, device scale, page zoom, bitmap size and viewportRevision. Capture is a timepoint, not a lock on the website.

Prefer meaningful visible text, role/name/state and actionable Refs. Preserve labels, errors, associations and frame provenance. Explicitly mark unsupported frames unavailable, not empty. Private Ref identity includes page generation, frame, frame document and backend node. Public IDs never recycle into a different node. Missing/stale Refs fail; there is no name/XPath fallback to a replacement target.

Ref actions check connectivity, visibility, actionability and hit-testing at prepare and dispatch. Use bounded stability waits and real input rather than page-script click simulation. Whole-document mutation counters alone are insufficient. Coordinate actions use an explicit bitmap-to-CSS transform; never guess by multiplying DPR. Changed viewport/zoom/document requires a new screenshot.

The current screenshot-coordinate actions use the latest visible viewport `capture` observationId as `snapshotId`. `clickAt(x,y)`, `drag(fromX,fromY,toX,toY,steps)`, and `pressAt(x,y,key)` take integer screenshot bitmap pixels inside the actual image; drag steps are 1–20. `describe` advertises supported actions. Main converts with the captured bitmap and CSS viewport sizes and binds the converted target into the Core approval plan. Canvas without a Ref requires this screenshot path; it must not invent a DOM selector. A fresh capture is required after every action before another coordinate input. Capture records CSS viewport, scroll, DPR, page zoom, GUI zoom, native DIP bounds, and bitmap size. Renderer CSS bounds are converted to native DIP bounds using GUI zoom. Hidden, minimized, and zero-sized pages cannot provide an automatic capture. Viewport, zoom, scroll, or document changes invalidate prior screenshot coordinates and prepared plans; stable Refs still receive fresh actionability checks. Native B-33/B-34 matrix acceptance remains pending M2.

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

## 10. Existing Threads and Core extensions

`areal/thread/tools/attach` is implemented; `areal/thread/observe` remains a proposal. Discover attachment through the `areal/capabilities` method list, `features.browserToolAttachment`, and `browserToolBundles`. Do not rewrite existing fixed Codex compatibility definitions.

| Method | Request | Meaning |
|---|---|---|
| areal/thread/tools/attach | requestId, threadId, expectedToolsetRevision, bundleId=areal.browser.v1 | Trusted interact+tools client; idle Thread; atomic append-only deployed bundle and current host binding; conflict on different same-name schema; idempotent |
| areal/thread/observe | threadId | Atomic snapshot plus deltas with observe permission, without ToolHost rebinding; existing resume semantics unchanged |

`Thread.toolsetRevision` is optional and defaults to 0 for older Threads. Core defines the fixed `areal.browser.v1` bundle; the request carries no tool schema. Attachment returns `threadId`, `toolsetRevision`, and `bundleId`. The same principal, method, `requestId`, and input replay the original durable Thread receipt; changed input conflicts. Busy or archived Threads, stale revisions, a same-name different definition, or another live host conflict. Existing `dynamicTools` entries and history remain intact. Attachment neither ends nor starts a Turn.

After commit, Core emits `areal/thread/tools/attached` with `threadId`, the new `toolsetRevision`, and the complete `dynamicTools` array. The GUI projects that authoritative event onto an open Thread, and an older snapshot cannot undo the newer toolset. Tool callbacks remain checked by the bound Core host and native page claim, not a potentially stale GUI projection.

The current GUI host executes only `browser_v1`. A Thread with other existing client dynamic tools allows attachment only on the same live original host connection. Once that host disconnects, rebinding to a GUI callback that cannot execute those tools is refused. Their definitions and history remain readable.

Storage version increases from 12 to 13. The new Core reads older Threads with revision 0. Older Core binaries reject version 13 records; back up data and use a Core that understands version 13 rather than editing the version field or dropping tool history. The GUI hides activation when an older Core does not advertise support.

New GUI Threads can register the dispatcher; legacy activation is explicit. CLI/TUI use observe rather than becoming an Electron driver. Authorized submissions to a GUI-hosted Thread retain that host. With no GUI, Browser is unavailable rather than a new Chrome. Child agents do not inherit parent browser control by default.

## 11. Versioning and rollback

Turning the feature off returns to ordinary preview while preserving Browser history and never replaying live objects. Do not remove stored tool definitions or pretend an older binary can execute them. Block incompatible storage downgrades and document backup rather than changing version numbers. Update schemas/types/docs/fixtures with each contract change.
