// @ts-check
"use strict";
const {
  sensitiveCaptureScript,
  captureGuardStartScript,
  captureGuardStopScript,
} = require("../preview/capture-guard.cjs");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { nativeWithin } = require("./read-session.cjs");

/** @param {import("electron").WebContents} c @param {import("./model.js").FrameGrant} grant
 * @param {import("./model.js").PromiseBound} bounded @param {()=>boolean} valid @param {string} token @param {number} sequence */
async function captureHumanFrames(c, grant, bounded, valid, token, sequence) {
  if (c.debugger.isAttached()) throw new Error("页面调试器正在使用，无法检查嵌入站点");
  /** @type {Map<string,string>} */
  const targets = new Map();
  /** @type {{id:number;sid:string|undefined}[]} */
  const contexts = [];
  let attached = false;
  const current = () => valid() && grant.valid() && grant.status === "active";
  /** @template {import("./model.js").CdpMethod} M @param {M} method @param {object} [params] @param {string} [sessionId] @returns {Promise<import("./model.js").CdpResult<M>>} */
  const command = async (method, params = {}, sessionId) => {
    if (!current()) throw new Error("嵌入站点截图授权已失效");
    const result = await bounded(c.debugger.sendCommand(method, params, sessionId));
    if (!current()) throw new Error("嵌入站点截图授权已失效");
    return result;
  };
  /** @param {unknown} _event @param {string} method @param {Record<string,unknown>} params */
  const onMessage = (_event, method, params) => {
    if (
      method === "Target.attachedToTarget" &&
      params.targetInfo &&
      typeof params.targetInfo === "object" &&
      "type" in params.targetInfo &&
      params.targetInfo.type === "iframe" &&
      "targetId" in params.targetInfo &&
      typeof params.targetInfo.targetId === "string" &&
      typeof params.sessionId === "string"
    )
      targets.set(params.targetInfo.targetId, params.sessionId);
    if (method === "Target.detachedFromTarget")
      for (const [id, sid] of targets) if (sid === params.sessionId) targets.delete(id);
  };
  const snapshot = async () => {
    const root = (await command("Page.getFrameTree")).frameTree;
    /** @type {{id:string;loaderId:string;url:string;origin:string;parent:string|null;sid:string|undefined}[]} */
    const frames = [];
    /** @param {import("./model.js").CdpFrameTree} node @param {string|null} parent @param {string} [sid] */
    const walk = (node, parent, sid) => {
      const frame = node.frame;
      frames.push({
        id: frame.id,
        loaderId: frame.loaderId,
        url: frame.url,
        origin: frame.securityOrigin,
        parent: parent ?? frame.parentId ?? null,
        sid,
      });
      for (const child of node.childFrames ?? []) walk(child, frame.id, sid);
    };
    walk(root, null);
    for (const [id, sid] of targets) {
      const child = (await command("Page.getFrameTree", {}, sid)).frameTree;
      if (child.frame.id !== id || child.frame.parentId !== root.frame.id)
        throw new Error("嵌入站点 Frame 归属无法确认");
      walk(child, null, sid);
    }
    const parentOrigin = new URL(grant.parentURL).origin;
    if (
      frames.length !== c.mainFrame.framesInSubtree.length ||
      new Set(frames.map((frame) => frame.id)).size !== frames.length ||
      frames.length > 32 ||
      frames[0].url !== grant.parentURL ||
      frames.some(
        (frame) =>
          frame.origin !== parentOrigin &&
          (frame.origin !== grant.origin || frame.parent !== root.frame.id),
      )
    )
      throw new Error("嵌入站点 Frame 隐私覆盖不完整");
    return frames.sort((a, b) => a.id.localeCompare(b.id));
  };
  try {
    c.debugger.attach("1.3");
    attached = true;
    c.debugger.on("message", onMessage);
    await command("Page.enable");
    await command("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    });
    const before = await snapshot();
    for (const frame of before) {
      const world = await command(
        "Page.createIsolatedWorld",
        {
          frameId: frame.id,
          worldName: `areal-human-capture-${token}`,
        },
        frame.sid,
      );
      const context = { id: world.executionContextId, sid: frame.sid };
      contexts.push(context);
      /** @param {string} expression */
      const run = (expression) =>
        command(
          "Runtime.evaluate",
          { expression, contextId: context.id, returnByValue: true },
          context.sid,
        );
      if (
        (await run(captureGuardStartScript(token, sequence, false))).result?.value !== true ||
        (await run(sensitiveCaptureScript(false))).result?.value !== false
      )
        throw new Error("嵌入站点包含敏感内容或截图保护不可用，未生成图片");
    }
    const image = await bounded(c.capturePage());
    if (!current()) throw new Error("嵌入站点截图授权已失效");
    for (const context of contexts) {
      /** @param {string} expression */
      const run = (expression) =>
        command(
          "Runtime.evaluate",
          { expression, contextId: context.id, returnByValue: true },
          context.sid,
        );
      if (
        (await run(sensitiveCaptureScript(false))).result?.value !== false ||
        (await run(captureGuardStopScript(token, sequence))).result?.value !== false
      )
        throw new Error("嵌入站点在截图期间发生变化，未生成图片");
    }
    if (!isDeepStrictEqual(before, await snapshot()))
      throw new Error("嵌入站点 Frame 已变化，未生成图片");
    return { image, frames: before.map(({ id, loaderId, origin }) => ({ id, loaderId, origin })) };
  } finally {
    // 清理即使授权已失效也要执行；仅清理本次固定上下文，不重放截图或页面动作。
    const cleanupDeadline = performance.now() + 500;
    await Promise.allSettled(
      contexts.map((context) =>
        !c.isDestroyed() && c.debugger.isAttached()
          ? nativeWithin(
              c.debugger.sendCommand(
                "Runtime.evaluate",
                {
                  expression: captureGuardStopScript(token, sequence),
                  contextId: context.id,
                  returnByValue: true,
                },
                context.sid,
              ),
              cleanupDeadline,
            )
          : Promise.resolve(),
      ),
    );
    c.debugger.removeListener("message", onMessage);
    if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
  }
}

module.exports = { captureHumanFrames };
