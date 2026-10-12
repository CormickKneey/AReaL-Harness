[中文](0006-agent-interface-and-reuse.md) | **English**

# Use a constrained interface instead of a second programmable host

**Status: proposed; not implemented**

The Harness already owns its model loop, tools and history. Use a versioned dispatcher, semantic observation and bounded action sequences with Core approval and evidence. Do not import Ego’s global native binding, Page Ledger or arbitrary Node executor wholesale. This prioritizes same-page experience while deferring general programmable workflows.

## Considered options

An external Ego instance is a useful experiment but controls another app. Emulating all native bindings requires implementing snapshot and task spaces. A full Playwright/agent-browser service adds resource and connection ownership. Choose a narrow driver; require concrete demand before another provider.

## Consequences

Borrow Ego’s scoped Ref identities and stop semantics, and ZCode’s claiming/bridge patterns. Pin and review dependencies, license and behavior before extracting code. Batches are not transactions. Arbitrary evaluation and raw CDP are not low-privilege escape hatches.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).
