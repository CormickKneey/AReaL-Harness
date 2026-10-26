// @ts-check
"use strict";
/** @param {unknown} value */
function webUrl(value) {
  const text = String(value ?? "").trim();
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^(localhost|[\d.]+):\d+(\/|$)/i.test(text);
  const url = new URL(
    explicit ? text : `${/^(localhost|127\.|\[::1\])/.test(text) ? "http" : "https"}://${text}`,
  );
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("预览仅支持不含凭据的 HTTP(S) 地址");
  return url.href;
}
/** @param {string} value */
function observationUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}
module.exports = { webUrl, observationUrl };
