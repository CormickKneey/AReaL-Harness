// @ts-check
"use strict";
const { safeText, diagnosticUrl } = require("../preview/diagnostics.cjs");
const { workspaceKey, pageKey } = require("./identity.cjs");
const { randomUUID } = require("node:crypto");
const { basename } = require("node:path");
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;

class HumanDownloads {
  /**
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {(page:import("./model.js").Page,event:Electron.Event,item:import("electron").DownloadItem) => boolean} acceptCommandDownload
   */
  constructor(presentation, workspace, acceptCommandDownload) {
    this.presentation = presentation;
    this.workspace = workspace;
    this.acceptCommandDownload = acceptCommandDownload;
  }
  /**
   * @param {import('./model.js').LivePage} page
   */
  downloadHandler(page) {
    const c = page.view.webContents;
    const { projectId, threadId } = page;
    /** @param {Electron.Event} event @param {import("electron").DownloadItem} item */
    return (event, item) => {
      if (this.acceptCommandDownload(page, event, item)) return;
      const intent = page.fileHandoff;
      const key = pageKey(page.coreInstanceId, projectId, threadId, page.id);
      const current = () =>
        this.workspace.pageStillOwned(page) &&
        page.view?.webContents === c &&
        this.presentation.owner === key &&
        this.workspace.selected.get(workspaceKey(page.coreInstanceId, projectId, threadId)) ===
          page.id &&
        page.control === "human" &&
        page.controlEpoch === intent?.controlEpoch &&
        page.pageGeneration === intent?.pageGeneration &&
        // A download link may start navigation without committing a new
        // document; it remains the original Page only while getURL is unchanged.
        [intent?.documentGeneration, (intent?.documentGeneration ?? NaN) + 1].includes(
          page.documentGeneration,
        ) &&
        c.getURL() === intent?.url &&
        page.requestedVisible &&
        page.view.getVisible() &&
        this.presentation.window.isVisible() &&
        !this.presentation.window.isMinimized() &&
        this.presentation.window.isFocused() &&
        !c.isDestroyed() &&
        !page.crashed;
      if (
        !intent ||
        intent.kind !== "download" ||
        Date.now() > intent.expiresAt ||
        !current() ||
        page.downloads.size >= 1
      ) {
        event.preventDefault();
        if (this.workspace.pageStillOwned(page)) {
          page.error = "下载需要当前页面的明确文件交接；未保存文件";
          this.workspace.changed(page);
        }
        return;
      }
      clearTimeout(intent.timer);
      page.fileHandoff = null;
      const total = item.getTotalBytes();
      const id = randomUUID();
      let pageOrigin = "unknown";
      try {
        pageOrigin = new URL(c.getURL()).origin;
      } catch {
        /* Current Page origin stays unknown. */
      }
      /** @type {import("./model.js").FileReceipt} */
      const record = {
        id,
        pageId: page.id,
        threadId,
        openerId: page.openerId,
        pageOrigin,
        initiator: "unknown",
        source: diagnosticUrl(item.getURL()),
        name: safeText(basename(item.getFilename()), 120),
        sizeBytes: Number.isSafeInteger(total) && total > 0 ? total : null,
        receivedBytes: 0,
        target: null,
        status: "choosing",
        reason: null,
        networkOutcome: "unknown",
      };
      if (record.sizeBytes !== null && record.sizeBytes > MAX_FILE_BYTES) {
        event.preventDefault();
        record.status = "cancelled";
        record.reason = "size_limit";
        this.workspace.fileReceipt(page, record);
        return;
      }
      // Electron opens its native Save dialog before creating a destination.
      // setSavePath is intentionally absent: only the user supplies a path.
      try {
        item.setSaveDialogOptions({
          title: "保存网页下载",
          message: `${pageOrigin} · 最大 64 MiB`,
        });
      } catch {
        event.preventDefault();
        record.status = "cancelled";
        record.reason = "native_dialog_unavailable";
        this.workspace.fileReceipt(page, record);
        return;
      }
      page.downloads.add(item);
      page.downloadRecords.set(item, record);
      record.timer = setTimeout(() => {
        if (page.downloads.has(item)) {
          record.status = "unknown";
          record.reason = "download_timeout_after_dispatch";
          item.cancel();
          this.workspace.fileReceipt(page, record);
        }
      }, DOWNLOAD_TIMEOUT_MS);
      item.on("updated", (_event, state) => {
        if (!page.downloads.has(item)) return;
        const received = item.getReceivedBytes();
        record.receivedBytes =
          Number.isSafeInteger(received) && received >= 0 ? received : record.receivedBytes;
        const target = item.getSavePath();
        if (target) record.target = safeText(basename(target), 120);
        if (record.receivedBytes > MAX_FILE_BYTES) {
          record.status = "unknown";
          record.reason = "size_limit_after_dispatch";
          item.cancel();
        } else if (record.status !== "unknown")
          record.status = state === "interrupted" ? "interrupted" : "downloading";
        this.workspace.fileReceipt(page, record);
      });
      item.once("done", (_event, state) => {
        clearTimeout(record.timer);
        delete record.timer;
        // Closing a Page removes its ownership before Electron settles the
        // cancelled DownloadItem. Its late callback must not restore receipts.
        if (!this.workspace.pageStillOwned(page) || page.downloadRecords.get(item) !== record)
          return;
        page.downloads.delete(item);
        page.downloadRecords.delete(item);
        const target = item.getSavePath();
        if (target) record.target = safeText(basename(target), 120);
        if (record.status !== "unknown")
          record.status = ["completed", "cancelled", "interrupted"].includes(state)
            ? state
            : "unknown";
        if (state === "cancelled" && !target && !record.reason) record.reason = "chooser_cancelled";
        this.workspace.fileReceipt(page, record);
      });
      this.workspace.fileReceipt(page, record);
    };
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {string} reason
   */
  cancelFileOperations(page, reason) {
    if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
    page.fileHandoff = null;
    for (const item of page.downloads ?? []) {
      const record = page.downloadRecords?.get(item);
      if (record && !["completed", "cancelled", "interrupted", "unknown"].includes(record.status)) {
        record.status = "unknown";
        record.reason = reason;
        this.workspace.fileReceipt(page, record);
      }
      item.cancel();
      if (record?.timer) clearTimeout(record.timer);
    }
    page.downloads?.clear();
    page.downloadRecords?.clear();
  }
}

module.exports = { HumanDownloads };
