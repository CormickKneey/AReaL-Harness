[中文](0003-native-view-and-driver.md) | **English**

# Retain WebContentsView and a narrow CDP driver

**Status: accepted (user approval on 2026-10-10); production integration not implemented**

After reviewing the R0 native evidence, the user approved retaining the existing WebContentsView, a narrow Main debugger Driver, a trusted native input mask, and frozen screenshots as the preferred region-feedback surface. Implementation follows the existing ticket graph. Approval of the technical choice does not establish completion of Core tool routing, takeover, UNKNOWN handling or release acceptance.

The current preview uses WebContentsView without page preload, Node or the product bridge. Retain that boundary and use Main’s debugger transport for a scoped Browser Driver. Do not expose application-wide remote debugging or make a view-technology migration a prerequisite.

## Considered options

Borrow ZCode guest-control and observation ideas without migrating its webview surface. Use Playwright for real E2E. Any vendored internal injected script must be pinned, attributed and maintained as private API. Ego’s native snapshot dependency prevents a drop-in observation replacement.

## Consequences

Native views occlude React overlays: prove a trusted native overlay in real Electron. Frozen screenshots may back region annotation, but input fencing cannot be removed. DevTools attach/detach is an explicit lifecycle state, not concurrent CDP ownership.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).

The Driver must explicitly pause, invalidate the old debugging generation and detach before opening DevTools, and handle native open events. Automatic detach in a particular Electron version is not assumed. Closing DevTools requires reattachment and fresh observation. See the isolated [R0 experiment](../development/browser-testing.en.md#r0-native-experiment-entry); it does not establish production Driver integration with Core.
