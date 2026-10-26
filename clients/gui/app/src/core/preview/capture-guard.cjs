// @ts-check
"use strict";
/** @param {boolean} [includeFrames] */
const sensitiveCaptureScript = (includeFrames = true) => `(() => {
  const selector = 'input[type="password"],input[name*="token" i],input[name*="secret" i],input[name*="key" i]';
  const sensitiveAutocomplete = new Set(['current-password', 'new-password', 'cc-number', 'cc-csc', 'one-time-code']);
  const scan = root => {
    if (root.querySelector(selector)) return true;
    for (const input of root.querySelectorAll('input[autocomplete]')) {
      if (input.getAttribute('autocomplete').trim().toLowerCase().split(/\\s+/).some(token => sensitiveAutocomplete.has(token))) return true;
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot && scan(element.shadowRoot)) return true;
      if (!['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName)
        && [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|\\botp\\b|credential/i.test(child.textContent))) return true;
    }
    for (const frame of ${includeFrames ? "root.querySelectorAll('iframe,frame')" : "[]"}) {
      try { if (!frame.contentDocument || scan(frame.contentDocument)) return true; }
      catch { return true; }
    }
    return false;
  };
  return scan(document);
})()`;
/** @param {string} token @param {number} sequence @param {boolean} [includeFrames] */
const captureGuardStartScript = (token, sequence, includeFrames = true) => `(() => {
  if ((globalThis.__arealCaptureGuardSequence ?? 0) >= ${sequence}) return false;
  globalThis.__arealCaptureGuardSequence = ${sequence};
  const previous = globalThis.__arealCaptureGuard;
  for (const observer of previous?.observers ?? []) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  const guard = { token: ${JSON.stringify(token)}, changed: false, observers: [] };
  const watch = root => {
    const observer = new MutationObserver(() => { guard.changed = true; });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    guard.observers.push(observer);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) watch(element.shadowRoot);
      if (${includeFrames} && element.matches('iframe,frame')) {
        if (!element.contentDocument) throw new Error('Frame unavailable');
        watch(element.contentDocument);
      }
    }
  };
  try { watch(document); globalThis.__arealCaptureGuard = guard; return true; }
  catch { for (const observer of guard.observers) observer.disconnect(); return false; }
})()`;
/** @param {string} token @param {number} sequence */
const captureGuardStopScript = (token, sequence) => `(() => {
  globalThis.__arealCaptureGuardSequence = Math.max(globalThis.__arealCaptureGuardSequence ?? 0, ${sequence});
  const guard = globalThis.__arealCaptureGuard;
  if (!guard || guard.token !== ${JSON.stringify(token)}) return true;
  const changed = guard.changed || guard.observers.some(observer => observer.takeRecords().length > 0);
  for (const observer of guard.observers) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  return changed;
})()`;
/** @param {string} token */
const captureGuardChangedScript = (token) => `(() => {
  const guard = globalThis.__arealCaptureGuard;
  if (!guard || guard.token !== ${JSON.stringify(token)}) return true;
  guard.changed ||= guard.observers.some(observer => observer.takeRecords().length > 0);
  return guard.changed;
})()`;
const clearCaptureGuardScript = `(() => {
  for (const observer of globalThis.__arealCaptureGuard?.observers ?? []) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  return true;
})()`;
module.exports = {
  sensitiveCaptureScript,
  captureGuardStartScript,
  captureGuardStopScript,
  captureGuardChangedScript,
  clearCaptureGuardScript,
};
