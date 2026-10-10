[中文](0005-transient-browser-contexts.md) | **English**

# Ship transient isolation before persistent Profiles

**Status: proposed; not implemented**

Shared-page work requires current transient state, while persistent identity management and credential import add scope. Use an independent transient storage context per Browser Workspace, shared by its pages but not other Threads. Adopt an existing preview object without copying login data.

## Considered options

One global Profile risks cross-task state changes; one context per page breaks popup/redirect workflows. Choose Workspace-scoped transient contexts. Cross-Thread page transfers are unsupported initially.

## Consequences

Explicit Workspace closure after its last page, owner archive or GUI exit releases the context. Temporary login is supported only in the current run; no restart persistence is promised. This is not process/network isolation and does not guarantee embedded site-login compatibility.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).
