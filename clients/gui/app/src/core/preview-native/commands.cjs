// @ts-check
"use strict";
const { hasNativePage } = require("./workspace.cjs");
const { preparedActionId } = require("../preview/approval.cjs");
const { webUrl, observationUrl } = require("../preview/urls.cjs");
const { workspaceKey, pageKey } = require("./identity.cjs");
const { randomUUID, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { basename } = require("node:path");
const {
  validateBrowserCommand,
  browserCommandResultSchema,
  supportedMethods,
  unsupportedCapabilities,
} = require("@areal/browser-automation");
const { nativeWithin } = require("./read-session.cjs");
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;

class BrowserCommands {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./lifecycle.cjs').NativePageLifecycle>} lifecycle
   * @param {InstanceType<typeof import('./native-command.cjs').NativeCommandExecution>} native_command
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(control, lifecycle, native_command, presentation, workspace) {
    this.control = control;
    this.lifecycle = lifecycle;
    this.native_command = native_command;
    this.presentation = presentation;
    this.workspace = workspace;
  }
  /**
   * @param {import('./model.js').CommandRequest} request
   * @param {import('./model.js').Page} page
   */
  commandIdentity(request, page) {
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
      controlEpoch: page.controlEpoch,
    };
  }

  /**
   * @param {import('./model.js').Page} page
   */
  commandFacts(page) {
    return {
      pageId: page.id,
      pageGeneration: page.pageGeneration,
      documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch,
      control: page.control,
      humanRevision: page.humanRevision ?? 0,
      url: page.view?.webContents.getURL() ?? page.url,
      viewportRevision: page.viewportRevision,
      bounds: page.view?.getBounds() ?? null,
      zoom: page.view?.webContents.getZoomFactor() ?? null,
    };
  }

  /**
   * @param {import('./model.js').CommandRequest} request
   * @param {import('./model.js').BrowserCommand} command
   * @param {import('./model.js').Page} page
   */
  commandTargets(request, command, page) {
    const ids = ["finalizeTabs", "closeSession", "turnEnded"].includes(command.method)
      ? this.workspace.workspacePages(request.projectId, request.threadId).map((item) => item.id)
      : [("tabId" in command ? command.tabId : undefined) ?? page.id];
    if (command.method === "finalizeTabs") ids.push(...command.keep.map((item) => item.tabId));
    return [...new Set(ids)].map((id) => {
      const target = this.workspace.page(request.projectId, request.threadId, id);
      if (
        !target ||
        !this.workspace.pageStillOwned(target) ||
        !hasNativePage(target) ||
        target.crashed ||
        target.view.webContents.isDestroyed() ||
        target.view.webContents.isDevToolsOpened()
      )
        throw new Error("plan_stale");
      if (
        !["claimTab", "listUserTabs", "finalizeTabs", "closeSession", "turnEnded"].includes(
          command.method,
        ) &&
        target.control !== "agent"
      )
        throw new Error("human_takeover_required");
      if (!["agent", "human"].includes(target.control)) throw new Error("plan_stale");
      return target;
    });
  }

  /**
   * @param {import('./model.js').CommandRequest} request
   */
  async prepareCommand(request) {
    const { page, c } = this.workspace.actionPage(request);
    const command = validateBrowserCommand(request.parameters.command);
    if (request.parameters.pageId !== page.id) throw new Error("plan_stale");
    const management = [
      "recordingStatus",
      "recordingCancel",
      "getDialog",
      "handleDialog",
      "cancelRequest",
      "close",
      "closeSession",
      "turnEnded",
    ].includes(command.method);
    if (
      page.activeRead ||
      page.activePrepare ||
      (page.activeAction && !management) ||
      this.workspace.workspaceOutstanding(page.projectId, page.threadId) >= 16
    )
      throw new Error("not_sent");
    const targets = this.commandTargets(request, command, page);
    if (
      command.method === "navigate" &&
      command.url !== "about:blank" &&
      !page.networkPolicy.canAuthorize(webUrl(command.url))
    )
      throw new Error("not_sent");
    const source = c.getURL() || "about:blank";
    const commandPage =
      targets.find(
        (target) => target.id === (("tabId" in command ? command.tabId : undefined) ?? page.id),
      ) ?? page;
    if (!hasNativePage(commandPage)) throw new Error("plan_stale");
    const targetSource = commandPage.view.webContents.getURL() || "about:blank";
    const parameters = structuredClone(request.parameters);
    /** @type {import("./model.js").CommandPlan} */
    const plan = {
      preparedActionId: randomUUID(),
      operation: "command",
      pageId: page.id,
      origin: new URL(targetSource).origin,
      url: observationUrl(targetSource),
      parameters,
      ...(command.method === "navigate"
        ? {
            targetUrl: command.url === "about:blank" ? command.url : webUrl(command.url),
            targetOrigin: new URL(command.url === "about:blank" ? command.url : webUrl(command.url))
              .origin,
          }
        : {}),
      target: { pages: targets.map((target) => this.commandFacts(target)) },
      pageGeneration: page.pageGeneration,
      documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch,
      browserHostId: this.workspace.browserHostId,
      hostGeneration: this.workspace.hostGeneration,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      expiresAt: Date.now() + 300000,
    };
    plan.fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    page.plans.set(plan.preparedActionId, {
      kind: "command",
      plan: structuredClone(plan),
      pageUrl: source,
      targets,
      dialog: command.method === "handleDialog" ? commandPage.commandDialog : undefined,
    });
    return { ...this.commandIdentity(request, page), plan };
  }

  /**
   * @param {import('./model.js').CommandRequest} request
   */
  async executeCommand(request) {
    const { page, c } = this.workspace.actionPage(request);
    const approval = request.browserApproval?.plan;
    const id = preparedActionId(approval);
    const candidate = id === undefined ? undefined : page.plans.get(id);
    const saved = candidate?.kind === "command" ? candidate : undefined;
    const approved = saved && isDeepStrictEqual(saved.plan, approval) ? saved.plan : undefined;
    if (
      !saved ||
      !approved ||
      !isDeepStrictEqual(saved.plan, approved) ||
      approved.operation !== "command" ||
      saved.pageUrl !== (c.getURL() || "about:blank") ||
      approved.pageId !== page.id ||
      approved.threadId !== request.threadId ||
      approved.turnId !== request.turnId ||
      approved.callId !== request.callId ||
      approved.expiresAt < Date.now() ||
      approved.documentEpoch !== page.documentGeneration ||
      approved.pageGeneration !== page.pageGeneration ||
      approved.controlEpoch !== page.controlEpoch ||
      !isDeepStrictEqual(approved.parameters, request.parameters) ||
      saved.targets.some(
        (target, index) =>
          !this.workspace.pageStillOwned(target) ||
          !isDeepStrictEqual(this.commandFacts(target), approved.target.pages[index]),
      )
    )
      throw new Error("plan_stale");
    page.plans.delete(approved.preparedActionId);
    const command = validateBrowserCommand(request.parameters.command);
    const target =
      saved.targets.find(
        (item) => item.id === (("tabId" in command ? command.tabId : undefined) ?? page.id),
      ) ?? page;
    if (command.method === "handleDialog" && saved.dialog !== target.commandDialog)
      throw new Error("plan_stale");
    const identity = this.commandIdentity(request, page);
    const result = await this.runBrowserCommand(request, target, command, approved, saved.targets);
    return {
      ...identity,
      commandResult: browserCommandResultSchema.parse(result.commandResult),
      ...(result.createdPage ? { createdPage: result.createdPage } : {}),
      ...(result.controlPermits ? { controlPermits: result.controlPermits } : {}),
      ...(result.closedPageIds ? { closedPageIds: result.closedPageIds } : {}),
      ...(result.revokedPageIds ? { revokedPageIds: result.revokedPageIds } : {}),
      dispatch: "confirmed",
      preparedActionId: approved.preparedActionId,
    };
  }

  /**
   * @param {import('./model.js').CommandRequest} request
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').BrowserCommand} command
   * @param {import('./model.js').CommandPlan} approved
   * @param {import('./model.js').Page[]} targets
   * @returns {Promise<import('./model.js').CommandOutcome>}
   */
  async runBrowserCommand(request, page, command, approved, targets) {
    if (!hasNativePage(page)) throw new Error("plan_stale");
    const started = Date.now();
    /** @param {Omit<import("@areal/browser-automation").BrowserCommandResult,"elapsedMs">} partial */
    const done = (partial) => ({ commandResult: { elapsedMs: Date.now() - started, ...partial } });
    /** @param {import("./model.js").Page} target @returns {import("@areal/browser-automation").BrowserTabSummary} */
    const summary = (target) => ({
      tabId: target.id,
      viewport: target.commandViewport ?? {
        width: target.view?.getBounds().width || 1280,
        height: target.view?.getBounds().height || 720,
      },
      url: target.view?.webContents.getURL() || target.url || "about:blank",
      title: target.view?.webContents.getTitle() || target.title,
      lifecycle: target.commandLifecycle ?? "active",
      active:
        this.workspace.selected.get(
          workspaceKey(page.coreInstanceId, page.projectId, page.threadId),
        ) === target.id,
    });
    /** @param {import("./model.js").Page} target */
    const permit = (target) => ({
      pageId: target.id,
      pageGeneration: target.pageGeneration,
      controlEpoch: target.controlEpoch,
    });
    /** @param {import("./model.js").Page} target */
    const close = (target) =>
      this.lifecycle.release(
        pageKey(target.coreInstanceId, target.projectId, target.threadId, target.id),
        {
          notifyRevocation: false,
        },
      );
    switch (command.method) {
      case "capabilities":
        return done({
          ok: true,
          value: { backend: "iab", supportedMethods, unsupportedCapabilities },
        });
      case "list":
        return done({
          ok: true,
          tabs: this.workspace.workspacePages(page.projectId, page.threadId).map(summary),
        });
      case "listUserTabs":
        return done({
          ok: true,
          userTabs: this.workspace
            .workspacePages(page.projectId, page.threadId)
            .filter((item) => item.control === "human")
            .map((item) => ({ id: item.id, title: item.title, url: item.url })),
        });
      case "nameSession": {
        const context = this.workspace.contexts.get(
          workspaceKey(page.coreInstanceId, page.projectId, page.threadId),
        );
        if (!context) throw new Error("plan_stale");
        context.commandName = command.name;
        return done({ ok: true });
      }
      case "browserVisibilityGet":
        return done({ ok: true, value: { visible: page.requestedVisible } });
      case "browserVisibilitySet":
        page.requestedVisible = command.visible;
        page.view.setVisible(
          command.visible &&
            this.presentation.owner ===
              pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id) &&
            !this.presentation.suppressedPresentation &&
            !page.activeAction,
        );
        this.workspace.changed(page);
        return done({ ok: true, value: { visible: command.visible } });
      case "activateTab":
        this.workspace.selected.set(
          workspaceKey(page.coreInstanceId, page.projectId, page.threadId),
          page.id,
        );
        this.workspace.changed(page);
        return done({ ok: true, tab: summary(page) });
      case "claimTab": {
        if (page.control !== "agent")
          await this.control.claim(page.projectId, page.threadId, page.id);
        return { ...done({ ok: true, tab: summary(page) }), controlPermits: [permit(page)] };
      }
      case "newTab": {
        const id = randomUUID(),
          epoch = page.controlEpoch;
        const child = this.lifecycle.create(
          pageKey(page.coreInstanceId, page.projectId, page.threadId, id),
          page.projectId,
          page.threadId,
          { id, openerId: page.id, origin: "agent" },
        );
        try {
          await child.view.webContents.loadURL("about:blank");
          if (
            !this.workspace.pageStillOwned(page) ||
            page.control !== "agent" ||
            page.controlEpoch !== epoch
          )
            throw new Error("outcome_unknown");
          await this.control.claim(page.projectId, page.threadId, child.id);
          if (
            !this.workspace.pageStillOwned(page) ||
            page.control !== "agent" ||
            page.controlEpoch !== epoch
          )
            throw new Error("outcome_unknown");
        } catch (error) {
          close(child);
          throw new Error("outcome_unknown", { cause: error });
        }
        return {
          ...done({ ok: true, tab: summary(child) }),
          createdPage: permit(child),
          controlPermits: [permit(child)],
        };
      }
      case "finalize":
        page.commandLifecycle = command.deliverable === false ? "active" : "deliverable";
        this.workspace.changed(page);
        return done({ ok: true });
      case "markDeliverable":
      case "markHandoff":
        page.commandLifecycle = command.method === "markHandoff" ? "handoff" : "deliverable";
        this.workspace.changed(page);
        return done({ ok: true });
      case "finalizeTabs": {
        const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
        const closedPageIds = [];
        for (const target of targets) {
          const status = keep.get(target.id);
          if (status !== undefined) {
            target.commandLifecycle = status;
            this.workspace.changed(target);
          } else if (target.origin === "agent") {
            closedPageIds.push(target.id);
            close(target);
          }
        }
        return { ...done({ ok: true }), closedPageIds };
      }
      case "turnEnded":
        for (const target of targets) {
          if (!command.turnId || target.activeAction?.turnId === command.turnId)
            target.activeAction?.cancel();
          target.commandRecording?.controller.abort();
        }
        return done({ ok: true });
      case "closeSession": {
        const closedPageIds = [],
          revokedPageIds = [];
        for (const target of targets) {
          target.commandRecording?.controller.abort();
          if (command.closeTabs) {
            closedPageIds.push(target.id);
            close(target);
          } else {
            revokedPageIds.push(target.id);
            this.control.revoke(target, { notify: false });
          }
        }
        return { ...done({ ok: true }), closedPageIds, revokedPageIds };
      }
      case "close":
        close(page);
        return { ...done({ ok: true }), closedPageIds: [page.id] };
      case "cancelRequest":
        if (page.activeAction?.requestId === command.requestId) page.activeAction.cancel();
        return done({ ok: true });
      case "getDialog":
        return done({ ok: true, dialog: page.commandDialog ?? null });
      case "handleDialog": {
        if (!page.commandDialog)
          return done({
            ok: false,
            error: { code: "execution_error", message: "No pending JavaScript dialog" },
          });
        const epoch = page.controlEpoch;
        try {
          await nativeWithin(
            this.control.dispatchInput(page, "Page.handleJavaScriptDialog", {
              accept: command.accept,
              ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
            }),
            performance.now() + 5000,
          );
          if (
            !this.workspace.pageStillOwned(page) ||
            page.control !== "agent" ||
            page.controlEpoch !== epoch
          )
            throw new Error("outcome_unknown");
          return done({ ok: true });
        } catch (error) {
          throw new Error("outcome_unknown", { cause: error });
        }
      }
      case "recordingStatus":
      case "recordingCancel": {
        const entry = page.commandRecordings?.get(command.recordingId);
        if (!entry)
          return done({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "Recording belongs to another or closed page",
            },
          });
        if (command.method === "recordingCancel") {
          entry.controller.abort();
          await entry.promise;
        }
        if (command.method === "recordingStatus" && command.outputPath && entry.artifact) {
          if (!request.workspacePath) throw new Error("not_sent");
          const fs = require("node:fs/promises"),
            path = require("node:path");
          const destination = path.resolve(request.workspacePath, command.outputPath);
          const parent = path.dirname(destination);
          const realRoot = await fs.realpath(request.workspacePath);
          let directory = realRoot;
          for (const part of path
            .relative(request.workspacePath, parent)
            .split(path.sep)
            .filter(Boolean)) {
            directory = path.join(directory, part);
            await fs.mkdir(directory).catch((error) => {
              if (error.code !== "EEXIST") throw error;
            });
            const stat = await fs.lstat(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("not_sent");
          }
          const realParent = await fs.realpath(parent);
          if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep))
            throw new Error("not_sent");
          entry.publications ??= new Set();
          if (!entry.publications.has(destination)) {
            await fs.copyFile(
              entry.artifact.path,
              destination,
              require("node:fs").constants.COPYFILE_EXCL,
            );
            entry.publications.add(destination);
          }
          return done({
            ok: true,
            recording: {
              ...this.commandRecordingStatus(entry),
              artifact: { ...entry.artifact, path: destination },
            },
          });
        }
        return done({ ok: true, recording: this.commandRecordingStatus(entry) });
      }
    }
    return this.native_command.executeNativeCommand(request, page, command);
  }

  /**
   * @param {import('./model.js').Page} page
   */
  commandArtifactRoot(page) {
    if (!page.commandArtifactRoot)
      page.commandArtifactRoot = require("node:fs").mkdtempSync(
        require("node:path").join(require("node:os").tmpdir(), "areal-browser-artifacts-"),
      );
    return page.commandArtifactRoot;
  }

  /**
   * @param {import('./model.js').Recording} entry
   * @returns {import('@areal/browser-automation').BrowserRecordingJob}
   */
  commandRecordingStatus(entry) {
    return {
      id: entry.id,
      status: entry.status,
      phase: entry.phase,
      startedAt: entry.startedAt,
      progress:
        entry.status === "completed"
          ? 1
          : entry.phase === "finalizing"
            ? 0.9
            : entry.phase === "capturing"
              ? 0.5
              : 0,
      updatedAt: entry.finishedAt ?? Date.now(),
      ...(entry.artifact ? { artifact: entry.artifact } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {Electron.Event} event
   * @param {import('electron').DownloadItem} item
   */
  acceptCommandDownload(page, event, item) {
    const intent = page.commandDownloadIntent;
    const approved =
      (page.activeAction?.command && page.activeAction.dispatched) ||
      (intent &&
        intent.controlEpoch === page.controlEpoch &&
        intent.pageGeneration === page.pageGeneration &&
        intent.expiresAt > Date.now());
    if (page.control !== "agent" || !approved || !this.workspace.pageStillOwned(page)) return false;
    if (item.getTotalBytes() > MAX_FILE_BYTES || page.commandDownloads.size >= 8) {
      event.preventDefault();
      return true;
    }
    const id = randomUUID(),
      path = require("node:path").join(
        this.commandArtifactRoot(page),
        id + "-" + basename(item.getFilename()),
      );
    /** @type {import("./model.js").CommandDownload & {controlEpoch:number}} */
    const record = {
      id,
      path,
      state: "pending",
      item,
      consumed: false,
      controlEpoch: page.controlEpoch,
    };
    page.commandDownloads.set(id, record);
    item.setSavePath(path);
    const timer = setTimeout(() => item.cancel(), DOWNLOAD_TIMEOUT_MS);
    item.on("updated", () => {
      if (
        item.getReceivedBytes() > MAX_FILE_BYTES ||
        !this.workspace.pageStillOwned(page) ||
        page.control !== "agent" ||
        page.controlEpoch !== record.controlEpoch
      )
        item.cancel();
    });
    item.once("done", (_event, state) => {
      clearTimeout(timer);
      record.state = state;
      delete record.item;
    });
    return true;
  }
}

module.exports = { BrowserCommands };
