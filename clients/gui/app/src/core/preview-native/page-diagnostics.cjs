// @ts-check
"use strict";
const { diagnosticText, diagnosticUrl } = require("../preview/diagnostics.cjs");
const MAX_DIAGNOSTICS = 200;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;

class PageDiagnostics {
  /**
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {(page:import("./model.js").Page) => void} revoke
   */
  constructor(workspace, revoke) {
    this.workspace = workspace;
    this.revoke = revoke;
  }
  /**
   * @param {import('./model.js').Page} page
   * @param {string} reason
   */
  clearDiagnostics(page, reason) {
    page.diagnosticsReady = false;
    page.diagnosticsStartedAt = null;
    page.diagnosticRequests?.clear();
    page.diagnosticEvents = [];
    page.diagnosticBytes = 0;
    page.diagnosticLoss = { after: page.diagnosticSequence ?? 0, reason };
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').DiagnosticEvent} event
   */
  addDiagnostic(page, event) {
    if (!this.workspace.pageStillOwned(page) || page.control !== "agent" || !page.diagnosticsReady)
      return;
    const record = {
      sequence: ++page.diagnosticSequence,
      at: new Date().toISOString(),
      pageGeneration: page.pageGeneration,
      documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch,
      ...event,
    };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    page.diagnosticEvents.push({ record, bytes });
    page.diagnosticBytes += bytes;
    while (
      page.diagnosticEvents.length > MAX_DIAGNOSTICS ||
      page.diagnosticBytes > MAX_DIAGNOSTIC_BYTES
    ) {
      const removed = page.diagnosticEvents[0];
      page.diagnosticEvents.shift();
      page.diagnosticBytes -= removed.bytes;
      page.diagnosticLoss = { after: removed.record.sequence, reason: "buffer_evicted" };
    }
    this.workspace.changed(page, "diagnosticsAvailable");
  }

  /**
   * @param {import('./model.js').DiagnosticsRequest} request
   */
  async diagnostics(request) {
    const { page, c } = this.workspace.actionPage(request);
    if (!page.diagnosticsReady || !c.debugger.isAttached())
      throw new Error("Browser diagnostics unavailable");
    const epoch = page.controlEpoch;
    const cursor = request.parameters.cursor ?? 0;
    const limit = request.parameters.limit ?? 50;
    const events = page.diagnosticEvents
      .filter(
        (item) => item.record.sequence > cursor && item.record.kind === request.parameters.kind,
      )
      .slice(0, limit)
      .map((item) => item.record);
    if (
      !this.workspace.pageStillOwned(page) ||
      page.control !== "agent" ||
      page.controlEpoch !== epoch
    )
      throw new Error("Browser observation was revoked");
    const first = page.diagnosticEvents[0]?.record.sequence ?? page.diagnosticSequence + 1;
    return {
      coreInstanceId: request.coreInstanceId,
      coreGeneration: request.coreGeneration,
      projectId: request.projectId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      pageId: page.id,
      browserHostId: this.workspace.browserHostId,
      hostGeneration: this.workspace.hostGeneration,
      pageGeneration: page.pageGeneration,
      controlEpoch: epoch,
      kind: request.parameters.kind,
      events,
      cursor: events.at(-1)?.sequence ?? page.diagnosticSequence,
      loss:
        cursor < first - 1 ||
        ((page.diagnosticLoss?.reason === "request_map_evicted" ||
          page.diagnosticLoss?.reason === "unattributed_request") &&
          cursor <= page.diagnosticLoss.after)
          ? {
              after: cursor,
              before: first,
              reason: page.diagnosticLoss?.reason ?? "unavailable_interval",
            }
          : null,
      bounded: { entries: MAX_DIAGNOSTICS, bytes: MAX_DIAGNOSTIC_BYTES },
      coverage: "live Electron Console and CDP Network metadata; no bodies or headers",
    };
  }

  /**
   * @param {import('./model.js').LivePage} page
   */
  attachDiagnostics(page) {
    const c = page.view.webContents;
    c.on("console-message", (details) => {
      if (page.control !== "agent" || !page.diagnosticsReady) return;
      const value = details;
      this.addDiagnostic(page, {
        kind: "console",
        level: ["error", "warning", "info", "debug"].includes(value.level) ? value.level : "log",
        message: diagnosticText(value.message),
        source: diagnosticUrl(value.sourceId),
        line: Number.isSafeInteger(value.lineNumber) ? value.lineNumber : null,
      });
    });
    c.debugger.on("message", (_event, method, params) => {
      if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe")
        page.commandFrameSessions.set(params.targetInfo.targetId, params.sessionId);
      if (method === "Target.detachedFromTarget")
        for (const [id, sessionId] of page.commandFrameSessions)
          if (sessionId === params.sessionId) page.commandFrameSessions.delete(id);
      if (method === "Page.javascriptDialogOpening")
        page.commandDialog = {
          type: params.type,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
        };
      if (method === "Page.javascriptDialogClosed") page.commandDialog = null;
      if (method === "Page.fileChooserOpened") {
        if (page.control === "agent") this.revoke(page);
        return;
      }
      if (
        !page.diagnosticsReady ||
        page.control !== "agent" ||
        !this.workspace.pageStillOwned(page)
      )
        return;
      if (method === "Network.requestWillBeSent") {
        if (typeof params?.requestId !== "string") return;
        // CDP's wallTime is the request's creation time. Reject any event
        // queued from the prior human phase, including one delivered late.
        if (
          !Number.isFinite(params.wallTime) ||
          params.wallTime < (page.diagnosticsStartedAt ?? 0)
        ) {
          page.diagnosticLoss = { after: page.diagnosticSequence, reason: "unattributed_request" };
          return;
        }
        const previous = page.diagnosticRequests.get(params.requestId);
        if (previous && previous.controlEpoch === page.controlEpoch && params.redirectResponse) {
          this.addDiagnostic(page, {
            kind: "network",
            url: previous.url,
            method: previous.method,
            status: Number.isSafeInteger(params.redirectResponse.status)
              ? params.redirectResponse.status
              : null,
            resourceType: previous.resourceType ?? null,
            failure: null,
            documentEpoch: previous.documentEpoch,
          });
        }
        const request = params.request ?? {};
        page.diagnosticRequests.set(params.requestId, {
          url: diagnosticUrl(request.url),
          method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request.method)
            ? request.method
            : "OTHER",
          documentEpoch: page.documentGeneration,
          controlEpoch: page.controlEpoch,
        });
        while (page.diagnosticRequests.size > MAX_DIAGNOSTICS) {
          page.diagnosticRequests.delete(page.diagnosticRequests.keys().next().value ?? "");
          page.diagnosticLoss = { after: page.diagnosticSequence, reason: "request_map_evicted" };
        }
      } else if (method === "Network.responseReceived") {
        const request = page.diagnosticRequests.get(params?.requestId);
        if (!request || request.controlEpoch !== page.controlEpoch) return;
        request.status = Number.isSafeInteger(params.response?.status)
          ? params.response.status
          : null;
        request.resourceType = diagnosticText(params.type, 40);
      } else if (method === "Network.loadingFailed" || method === "Network.loadingFinished") {
        const request = page.diagnosticRequests.get(params?.requestId);
        if (!request) return;
        page.diagnosticRequests.delete(params.requestId);
        if (request.controlEpoch !== page.controlEpoch) return;
        this.addDiagnostic(page, {
          kind: "network",
          url: request.url,
          method: request.method,
          status: request.status ?? null,
          resourceType: request.resourceType ?? null,
          failure:
            method === "Network.loadingFailed" ? diagnosticText(params.errorText, 120) : null,
          documentEpoch: request.documentEpoch,
        });
      }
    });
  }
}

module.exports = { PageDiagnostics };
