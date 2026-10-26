// @ts-check
"use strict";
const { performance } = require("node:perf_hooks");
const { readIsolated, nativeWithin } = require("./read-session.cjs");

class BrowserWaitConditions {
  /**
   * @param {InstanceType<typeof import('./native-targets.cjs').NativePageTargets>} native_targets
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(native_targets, workspace) {
    this.native_targets = native_targets;
    this.workspace = workspace;
  }
  /**
   * @param {Extract<import('./model.js').ActionRequest,{operation:'wait'}>} request
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').WebContents} c
   * @param {import('./model.js').SavedAction} saved
   * @param {import('./model.js').ActionLease} action
   * @param {Promise<never>} stop
   * @param {boolean} readiness
   */
  async waitForAction(request, page, c, saved, action, stop, readiness) {
    const started = performance.now(),
      expires = started + request.parameters.timeoutMs;
    const condition = request.parameters.condition;
    if (!condition) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, request.parameters.timeoutMs)),
        stop,
      ]);
    } else {
      if (!c.debugger.isAttached()) c.debugger.attach("1.3");
      const current = () => {
        this.workspace.actionPage(request);
        if (
          action.cancelled ||
          request.batchGuard?.() ||
          new URL(c.getURL()).origin !== saved.plan.origin ||
          (!readiness &&
            (c.getURL() !== saved.pageUrl || page.documentGeneration !== saved.plan.documentEpoch))
        )
          throw new Error("plan_stale");
      };
      /** @template T @param {Promise<T>} promise @returns {Promise<T|null>} */
      const read = async (promise) => {
        const document = page.documentGeneration;
        try {
          return await Promise.race([nativeWithin(promise, expires), stop]);
        } catch (error) {
          current();
          if (performance.now() >= expires) throw new Error("condition_timeout");
          if (readiness && (c.isLoadingMainFrame() || page.documentGeneration !== document))
            return null;
          throw error;
        }
      };
      for (;;) {
        current();
        let matched;
        if (condition.kind === "documentReady") {
          const document = page.documentGeneration;
          const state = c.isLoadingMainFrame()
            ? null
            : await read(readIsolated(c, "document.readyState"));
          matched =
            page.documentGeneration === document &&
            !c.isLoadingMainFrame() &&
            (state === condition.state ||
              (condition.state === "interactive" && state === "complete"));
        } else {
          const node = this.native_targets.refNode(page, condition.ref);
          if (node.identity !== saved.waitIdentity) throw new Error("stale_ref");
          if (condition.kind === "checked" || condition.kind === "enabled") {
            const native = (await read(this.native_targets.nativeControl(page, c, condition.ref)))
              ?.control;
            if (
              !native ||
              !saved.waitNative ||
              native.identity !== saved.waitNative?.identity ||
              native.kind !== saved.waitNative.kind ||
              native.type !== saved.waitNative.type
            )
              throw new Error("stale_ref");
            matched = native[condition.kind] === condition.value;
          } else {
            /** @type {import("./model.js").CdpResult<"Accessibility.getPartialAXTree">|null} */
            const ax = await read(
              c.debugger.sendCommand("Accessibility.getPartialAXTree", {
                backendNodeId: node.backendNodeId,
                fetchRelatives: false,
              }),
            );
            const value = ax?.nodes?.find(
              (value) => value.backendDOMNodeId === node.backendNodeId && !value.ignored,
            );
            if (!value) throw new Error("stale_ref");
            matched = value.name?.value === condition.name;
          }
        }
        current();
        if (matched) break;
        const remaining = expires - performance.now();
        if (remaining <= 0) throw new Error("condition_timeout");
        await Promise.race([
          new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining))),
          stop,
        ]);
        if (performance.now() >= expires) throw new Error("condition_timeout");
      }
    }
    return {
      condition: condition ?? null,
      satisfied: true,
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

module.exports = { BrowserWaitConditions };
