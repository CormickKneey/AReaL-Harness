import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Passive renderer observations + original CDP frames. No layout/state setters,
 * virtual time, transition suppression, or online video encoder. Idle CDP frames
 * may be omitted: timestamps, not the number of frames, own elapsed time. */
export async function captureConversationMotion(page, directory, selectors) {
  await mkdir(join(directory, "frames"), { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [], writes = [], errors = [], marks = [];
  const startedAt = Date.now();
  cdp.on("Page.screencastFrame", event => {
    const index = frames.length, file = `frames/${String(index).padStart(6, "0")}.jpg`;
    frames.push({ index, file, receivedAt: Date.now(), ...event.metadata });
    // ACK immediately; file I/O/encoding must not backpressure the compositor.
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(e => errors.push(String(e)));
    writes.push(writeFile(join(directory, file), Buffer.from(event.data, "base64")));
  });
  await page.evaluate(selectors => {
    const samples = [], inputs = [], listeners = [];
    const rect = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect(), css = getComputedStyle(el);
      return { x: r.x, y: r.y, width: r.width, height: r.height, opacity: css.opacity, scale: css.scale, transform: css.transform, textLength: el.textContent?.length, hidden: el.hidden, expanded: el.getAttribute("aria-expanded"), scrollTop: el.scrollTop, total: el.scrollHeight, client: el.clientHeight };
    };
    const describe = el => el ? { tag: el.tagName, label: el.getAttribute("aria-label"), slot: el.dataset?.slot, class: (el.getAttribute("class") ?? "").slice(0, 180), text: el.textContent?.slice(0, 70) } : null;
    const onInput = e => inputs.push({ t: performance.now(), type: e.type, key: e.key, deltaY: e.deltaY, target: describe(e.target) });
    for (const name of ["click", "keydown", "wheel", "pointerdown", "pointerup"]) { document.addEventListener(name, onInput, true); listeners.push(name); }
    let handle;
    function sample(t) {
      samples.push({ t, wall: Date.now(), observedNow: performance.now(), reduced: document.documentElement.dataset.reducedMotion, mediaReduce: matchMedia("(prefers-reduced-motion: reduce)").matches, focus: describe(document.activeElement), elements: Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, rect(document.querySelector(selector))])), animations: document.getAnimations().filter(a => a.playState === "running").map(a => ({ name: a.animationName, property: a.transitionProperty, state: a.playState, current: a.currentTime, target: describe(a.effect?.target), timing: a.effect?.getComputedTiming() })) });
      handle = requestAnimationFrame(sample);
    }
    handle = requestAnimationFrame(sample);
    window.__conversationMotionObservation = { samples, inputs, stop: () => { cancelAnimationFrame(handle); for (const name of listeners) document.removeEventListener(name, onInput, true); } };
  }, selectors);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1509, maxHeight: 949, everyNthFrame: 1 });
  let stopped = false;
  return {
    async mark(name) { const clock = await page.evaluate(() => ({ t: performance.now(), wall: Date.now() })); marks.push({ name, ...clock }); return clock; },
    async segment(name, action, hold = 420) {
      await this.mark(`${name}:before`); await action(); await this.mark(`${name}:action-returned`);
      // This is a motion observation window, never a business completion oracle.
      await new Promise(r => setTimeout(r, hold)); await this.mark(`${name}:after`);
    },
    async stop() {
      if (stopped) return; stopped = true;
      const observation = await page.evaluate(() => { const x = window.__conversationMotionObservation; x.stop(); const data = { samples: x.samples, inputs: x.inputs, timeOrigin: performance.timeOrigin, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio }; delete window.__conversationMotionObservation; return data; });
      await cdp.send("Page.stopScreencast"); await cdp.detach(); await Promise.all(writes);
      await writeFile(join(directory, "motion.json"), JSON.stringify({ startedAt, endedAt: Date.now(), frameMode: "original CDP JPEG; change-driven; no fixed FPS guarantee", frames, marks, errors, ...observation }, null, 2));
    },
  };
}
