[中文](0005-transient-browser-contexts.md) | **English**

# Ship transient isolation before persistent Profiles

**Status: implemented in source; unified native acceptance pending**

Shared-page work requires current transient state, while persistent identity management and credential import add scope. Use an independent transient storage context per Browser Workspace, shared by its pages but not other Threads. Adopt an existing preview object without copying login data.

## Considered options

One global Profile risks cross-task state changes; one context per page breaks popup/redirect workflows. Choose Workspace-scoped transient contexts. Cross-Thread page transfers are unsupported initially.

## Consequences

Explicit Workspace closure after its last page, owner archive or GUI exit releases the context. Temporary login is supported only in the current run; no restart persistence is promised. This is not process/network isolation and does not guarantee embedded site-login compatibility.

Main assigns each Workspace an in-memory Electron Session. Sibling pages retain it through claim, hide and idle page replacement. Releasing the last page closes its request policy and clears connections, storage, cache and authentication state. Main grants exact Origins for trusted navigation and refuses active Core/adapter ports; Session request hooks cover redirects, frames, workers and HTTP requests. Chromium's connection allowlist and a restrictive CSP further constrain page-initiated transports. These controls are not an OS-level network sandbox or a guarantee against DNS rebinding. B-21–B-23 require unified native Core/GUI evidence.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).
