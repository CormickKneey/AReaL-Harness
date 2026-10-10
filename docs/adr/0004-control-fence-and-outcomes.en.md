[中文](0004-control-fence-and-outcomes.md) | **English**

# Local human-control fences precede coordination; ambiguous actions never replay

**Status: proposed; not implemented**

Human takeover can race cross-process input. The Controller increments its control epoch and rejects old input before notifying Core. Core remains the approval/history authority. Potentially dispatched actions retain UNKNOWN semantics rather than becoming false success or failure on takeover or reconnect.

## Considered options

Pausing the model does not cancel queued or in-flight CDP input, and RPC cancellation does not undo website effects. End-to-end exactly-once would be a misleading promise for forms or payments.

## Consequences

Pause agent observation and diagnostics during human control. Resume requires new authorization and observation. UNKNOWN requires inspection and the existing acknowledgement flow; original history remains unknown. Check the fence at every batch step.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).
