// @ts-check
"use strict";
const { hasNativePage } = require("./workspace.cjs");
const { workspaceKey, pageKey } = require("./identity.cjs");

class HumanBrowserInput {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(control, presentation, workspace) {
    this.control = control;
    this.presentation = presentation;
    this.workspace = workspace;
    /** @type {import("./model.js").HumanGesture|null} */
    this.humanMouseGesture = null;
    /** @type {string|null} */
    this.nativeInputOwner = null;
    this.presentation.window.on("blur", () =>
      this.cancelHumanGesture(this.humanMouseGesture?.page),
    );
    // 人工输入来源只在 Main 记录；Renderer 没有通用 sendInputEvent 能力。
    this.presentation.window.webContents.on("before-mouse-event", (event, mouse) => {
      if (this.presentation.suppressedPresentation) return;
      const page =
        this.presentation.owner === null
          ? undefined
          : this.workspace.pages.get(this.presentation.owner);
      if (!page?.view || !this.presentation.window.isFocused()) return;
      const bounds = page.view.getBounds();
      const x = Math.round(mouse.x - bounds.x),
        y = Math.round(mouse.y - bounds.y);
      const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      const gesture = this.humanMouseGesture;
      const continuation =
        !!gesture &&
        gesture.page === page &&
        !gesture.cancelled &&
        gesture.generation === page.pageGeneration &&
        gesture.document === page.documentGeneration &&
        ["mouseUp", "mouseMove"].includes(mouse.type) &&
        (mouse.type !== "mouseUp" || mouse.button === gesture.button);
      if (["mouseUp", "mouseMove"].includes(mouse.type) && !continuation) {
        if (mouse.type === "mouseUp" && gesture?.page === page && mouse.button === gesture.button)
          this.cancelHumanGesture(page);
        return;
      }
      if (mouse.type === "mouseDown" && !inside) this.nativeInputOwner = null;
      if (
        (!inside && !continuation) ||
        (!continuation && page.view.getVisible()) ||
        !page.requestedVisible ||
        (!continuation && !["agent", "transferring"].includes(page.control)) ||
        !["mouseDown", "mouseUp", "mouseWheel", "mouseMove"].includes(mouse.type)
      )
        return;
      event.preventDefault();
      this.nativeInputOwner = page.id;
      void this.humanInput(page.projectId, page.threadId, page.id, { ...mouse, x, y }).catch(
        () => {},
      );
    });
    this.presentation.window.webContents.on("before-input-event", (event, input) => {
      if (this.presentation.suppressedPresentation) return;
      const page =
        this.presentation.owner === null
          ? undefined
          : this.workspace.pages.get(this.presentation.owner);
      if (
        !page?.view ||
        page.id !== this.nativeInputOwner ||
        page.view.getVisible() ||
        !page.requestedVisible ||
        !this.presentation.window.isFocused() ||
        !["agent", "transferring"].includes(page.control)
      )
        return;
      event.preventDefault();
      void this.humanKey(page, input).catch(() => {});
    });
  }
  /**
   * @param {import('./model.js').Page} page
   * @param {import('electron').Input} input
   */
  async humanKey(page, input) {
    const type = input.type;
    if (type !== "keyDown" && type !== "keyUp") return;
    /** @type {('shift'|'control'|'alt'|'meta')[]} */
    const names = ["shift", "control", "alt", "meta"];
    const modifiers = names.filter((name) => input[name]);
    const keyCode = input.key === " " ? "Space" : input.key;
    const pending = [
      this.humanInput(page.projectId, page.threadId, page.id, {
        type,
        keyCode,
        modifiers,
      }),
    ];
    if (
      input.type === "keyDown" &&
      input.key.length === 1 &&
      !input.control &&
      !input.meta &&
      !input.isComposing
    )
      pending.push(
        this.humanInput(page.projectId, page.threadId, page.id, {
          type: "char",
          keyCode: input.key,
          modifiers,
        }),
      );
    await Promise.all(pending);
  }

  /**
   * @param {import('./model.js').Page|null|undefined} page
   */
  cancelHumanGesture(page) {
    const gesture = this.humanMouseGesture;
    if (!gesture || gesture.page !== page) return;
    this.humanMouseGesture = null;
    gesture.cancelled = true;
    const c = page.view?.webContents;
    if (
      gesture.delivered &&
      c &&
      !c.isDestroyed() &&
      page.pageGeneration === gesture.generation &&
      page.documentGeneration === gesture.document
    )
      c.sendInputEvent({ type: "mouseUp", button: gesture.button, x: -1, y: -1 });
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string} pageId
   * @param {import('electron').MouseInputEvent | import('electron').MouseWheelInputEvent | import('electron').KeyboardInputEvent} input
   */
  async humanInput(projectId, threadId, pageId, input) {
    const page = this.workspace.page(projectId, threadId, pageId);
    const c = page?.view?.webContents;
    const current = () =>
      !this.workspace.profile.status().busy &&
      !!c &&
      !c.isDestroyed() &&
      this.workspace.pageStillOwned(page) &&
      this.presentation.owner === pageKey(page.coreInstanceId, projectId, threadId, pageId) &&
      this.workspace.selected.get(workspaceKey(page.coreInstanceId, projectId, threadId)) ===
        pageId &&
      page.requestedVisible &&
      !page.annotationCaptureId &&
      this.presentation.window.isVisible() &&
      !this.presentation.window.isMinimized() &&
      this.presentation.window.isFocused();
    /** @param {string} message @returns {never} */
    const rejectInput = (message) => {
      if (
        input.type === "mouseUp" &&
        this.humanMouseGesture &&
        this.humanMouseGesture.page === page &&
        input.button === this.humanMouseGesture.button
      )
        this.cancelHumanGesture(page);
      throw new Error(message);
    };
    if (!hasNativePage(page) || !c || !current()) return rejectInput("人工输入页面已变化");
    const bounds = page.view.getBounds();
    const gesture = this.humanMouseGesture;
    const continuation =
      !!gesture &&
      gesture.page === page &&
      gesture.generation === page.pageGeneration &&
      gesture.document === page.documentGeneration &&
      ["mouseUp", "mouseMove"].includes(input.type) &&
      (input.type !== "mouseUp" || input.button === gesture.button);
    if (["mouseUp", "mouseMove"].includes(input.type) && !continuation)
      rejectInput("人工输入手势已变化");
    if (
      (input.type === "mouseDown" ||
        input.type === "mouseMove" ||
        input.type === "mouseUp" ||
        input.type === "mouseEnter" ||
        input.type === "mouseLeave" ||
        input.type === "contextMenu" ||
        input.type === "mouseWheel") &&
      (!Number.isSafeInteger(input.x) ||
        !Number.isSafeInteger(input.y) ||
        (!continuation &&
          (input.x < 0 || input.y < 0 || input.x >= bounds.width || input.y >= bounds.height)))
    )
      rejectInput("人工输入坐标已变化");
    // fence 必须在首个 await 之前完成，后续输入按同一代次串行交付。
    // 隐藏 View 仍可能保留焦点；先迁到 Main，让 drain 期间的真实 up/char 继续进入 Main 队列。
    if (c.isFocused?.()) {
      this.nativeInputOwner = page.id;
      this.presentation.window.webContents.focus();
    }
    this.control.noteHumanInput(page);
    const epoch = page.controlEpoch,
      generation = page.pageGeneration,
      document = page.documentGeneration;
    if (input.type === "mouseDown")
      this.humanMouseGesture = { page, generation, document, button: input.button };
    const ownedGesture = this.humanMouseGesture;
    const deliver = async () => {
      if (page.control === "transferring") await this.control.convergeInput(page);
      if (
        !current() ||
        ownedGesture?.cancelled ||
        page.control !== "human" ||
        page.controlEpoch !== epoch ||
        page.pageGeneration !== generation ||
        page.documentGeneration !== document
      )
        throw new Error("人工输入页面已变化");
      c.focus();
      c.sendInputEvent(input);
      if (input.type === "mouseDown" && ownedGesture) ownedGesture.delivered = true;
      if (input.type === "mouseUp" && this.humanMouseGesture === ownedGesture)
        this.humanMouseGesture = null;
      return this.presentation.state(page);
    };
    const pending = (page.humanInputPending ?? Promise.resolve()).then(deliver);
    page.humanInputPending = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.humanMouseGesture === ownedGesture && ["mouseDown", "mouseUp"].includes(input.type))
        this.cancelHumanGesture(page);
      throw error;
    } finally {
      if (page.humanInputPending === pending) page.humanInputPending = null;
    }
  }

  /**
   * @param {import('./model.js').LivePage} page
   */
  attachNativeInput(page) {
    const c = page.view.webContents;
    const { projectId, threadId } = page;
    c.on("before-input-event", (event, input) => {
      if (this.workspace.profile.status().busy || !this.workspace.pageStillOwned(page)) {
        event.preventDefault();
        return;
      }
      // 仅当前台窗口中当前可见页面由人工控制时，才允许将焦点移回应用。
      if (
        input.type === "keyDown" &&
        input.key === "F6" &&
        !input.isAutoRepeat &&
        page.control === "human" &&
        this.workspace.owns(projectId, threadId) &&
        this.presentation.owner === pageKey(page.coreInstanceId, projectId, threadId, page.id) &&
        page.view.getVisible() &&
        this.presentation.window.isFocused() &&
        c.isFocused()
      ) {
        event.preventDefault();
        this.nativeInputOwner = null;
        this.presentation.window.webContents.focus();
        return;
      }
      if (
        page.control === "human" &&
        c.isFocused() &&
        input.type === "keyDown" &&
        ["Enter", "Space"].includes(input.key)
      )
        page.userPopupIntentUntil = Date.now() + 1000;
      // CDP keys may echo while the native view is hidden. Only an action on a
      // page without native focus may pass here; a focused page is local input.
      if (
        page.control === "agent" &&
        (!page.activeAction?.syntheticInput ||
          (page.view.getVisible() && !page.commandSurface) ||
          (this.presentation.window.isFocused() && c.isFocused()))
      ) {
        event.preventDefault();
        void this.humanKey(page, input).catch(() => {});
      } else if (page.control === "transferring") event.preventDefault();
      else if (page.control === "human") this.control.noteHumanInput(page);
    });
    c.on("before-mouse-event", (event, mouse) => {
      if (this.workspace.profile.status().busy || !this.workspace.pageStillOwned(page)) {
        event.preventDefault();
        return;
      }
      if (
        page.control === "human" &&
        mouse.type === "mouseUp" &&
        this.humanMouseGesture?.page === page
      )
        this.humanMouseGesture = null;
      if (page.control === "human" && mouse.type === "mouseDown" && c.isFocused())
        page.userPopupIntentUntil = Date.now() + 1000;
      if (
        page.control === "agent" &&
        page.view.getVisible() &&
        !page.commandSurface &&
        ["mouseDown", "mouseWheel"].includes(mouse.type)
      ) {
        event.preventDefault();
        this.nativeInputOwner = page.id;
        void this.humanInput(projectId, threadId, page.id, mouse).catch(() => {});
      } else if (page.control === "transferring") event.preventDefault();
      else if (page.control === "human" && ["mouseDown", "mouseWheel"].includes(mouse.type)) {
        this.control.noteHumanInput(page);
      }
    });
    c.on("focus", () => {
      if (this.workspace.pageStillOwned(page) && this.presentation.window.isFocused())
        this.nativeInputOwner = page.id;
    });
  }
}

module.exports = { HumanBrowserInput };
