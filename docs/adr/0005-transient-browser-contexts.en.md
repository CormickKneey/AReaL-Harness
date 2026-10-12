[中文](0005-transient-browser-contexts.md) | **English**

# Ship transient isolation before persistent Profiles

**Status: implemented in source; unified native acceptance pending**

Shared-page work requires current transient state, while persistent identity management and credential import add scope. Use an independent transient storage context per Browser Workspace, shared by its pages but not other Threads. Adopt an existing preview object without copying login data.

## Considered options

One global Profile risks cross-task state changes; one context per page breaks popup/redirect workflows. Choose Workspace-scoped transient contexts. Cross-Thread page transfers are unsupported initially.

## Consequences

Explicit Workspace closure after its last page, owner archive or GUI exit releases the context. Temporary login is supported only in the current run; no restart persistence is promised. This is not process/network isolation and does not guarantee embedded site-login compatibility.

Main assigns each Workspace an in-memory Electron Session. Siblings retain it through claim, hide and idle replacement. Releasing the last Page closes its request policy and clears connections, storage, cache and authentication. Ordinary human public/local browsing uses Chromium system proxy, DNS, redirects and cross-origin dependencies with HTTP(S)/WebSocket. It imports no personal browsing state, changes no OS/Surge configuration and applies no public/private or fake-IP classification to ordinary requests. No per-Origin grant or injected/deleted/rewritten site CSP, Connection-Allowlist or attachment headers are required. Main reserves active Core/adapter control ports across all hostnames against DNS aliases, rebinding and proxy fake-IP bypass; unrelated sites on the same active port are also refused. Closed contexts retain denial, and existing Human Frame grants remain scoped to their Page and parent document. Agent reads/actions separately pass Core Page/epoch permissions; web content still has no product bridge. This boundary is not an OS network sandbox. Unified real Core/GUI native and package acceptance remains pending.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).
