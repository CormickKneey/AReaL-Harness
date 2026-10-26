// @ts-check
"use strict";
const { observationUrl } = require("./urls.cjs");
const sensitive =
  /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|\botp\b|credential/i;
const diagnosticSensitive =
  /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|bearer|cookie|session.?id|one.?time.?code|\botp\b|credential/i;
/** @param {unknown} value @param {number} [limit] */
function safeText(value, limit = 500) {
  const text = String(value ?? "").slice(0, limit);
  return sensitive.test(text) ? "[redacted]" : text;
}
/** @param {unknown} value @param {number} [limit] */
function diagnosticText(value, limit = 500) {
  const text = String(value ?? "").slice(0, limit);
  if (diagnosticSensitive.test(text)) return "[redacted]";
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      return observationUrl(raw);
    } catch {
      return "[redacted URL]";
    }
  });
}
/** @param {string} value */
function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return "[redacted URL]";
    return diagnosticText(observationUrl(url.href), 500);
  } catch {
    return "[redacted URL]";
  }
}
module.exports = { sensitive, safeText, diagnosticText, diagnosticUrl };
