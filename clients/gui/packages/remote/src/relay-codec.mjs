// @ts-check
export const RELAY_FRAME_BYTES = 512 * 1024;
/** @typedef {{framesPerSecond:number,bytesPerSecond:number,maxFrameBytes:number,heartbeatIntervalMs:number}} RelayLimits */
/** @typedef {{type:'ready',channel:string,limits?:undefined}|{type:'ready',limits:RelayLimits,channel?:undefined}|{type:'open'|'close',channel:string}|{type:'data',channel:string,data:string}|{type:'error',code:string}} RelayMessage */
/** @param {unknown} value @returns {value is string} */
const channelShape = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
/** @param {unknown} value @param {readonly string[]} keys @returns {value is Record<string,unknown>} */
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
/** @param {unknown} text @returns {RelayMessage} */
export function decodeRelayMessage(text, binary = false) {
  if (
    binary ||
    typeof text !== "string" ||
    text.length > RELAY_FRAME_BYTES ||
    new TextEncoder().encode(text).length > RELAY_FRAME_BYTES
  )
    throw new Error("Relay 帧无效");
  /** @type {unknown} */
  const message = JSON.parse(text);
  if (!isRelayMessage(message)) throw new Error("Relay 帧无效");
  return message;
}
/** @param {unknown} message @returns {message is RelayMessage} */
function isRelayMessage(message) {
  if (!exact(message, ["type", "channel", "limits", "data", "code"])) return false;
  const limits = message.limits;
  if (
    message?.type === "ready" &&
    ((exact(message, ["type", "channel"]) && channelShape(message.channel)) ||
      (exact(message, ["type", "limits"]) &&
        exact(limits, [
          "framesPerSecond",
          "bytesPerSecond",
          "maxFrameBytes",
          "heartbeatIntervalMs",
        ]) &&
        /** @type {readonly (readonly [string,number])[]} */ ([
          ["framesPerSecond", 80],
          ["bytesPerSecond", 2097152],
          ["maxFrameBytes", RELAY_FRAME_BYTES],
        ]).every(
          ([key, ceiling]) =>
            typeof limits[key] === "number" &&
            Number.isSafeInteger(limits[key]) &&
            limits[key] > 0 &&
            limits[key] <= ceiling,
        ) &&
        typeof limits.heartbeatIntervalMs === "number" &&
        Number.isFinite(limits.heartbeatIntervalMs) &&
        limits.heartbeatIntervalMs > 0 &&
        limits.heartbeatIntervalMs <= 15000))
  )
    return true;
  if (
    typeof message.type === "string" &&
    ["open", "close"].includes(message.type) &&
    exact(message, ["type", "channel"]) &&
    channelShape(message.channel)
  )
    return true;
  if (
    message?.type === "data" &&
    exact(message, ["type", "channel", "data"]) &&
    channelShape(message.channel) &&
    typeof message.data === "string" &&
    message.data.length > 0 &&
    message.data.length <= RELAY_FRAME_BYTES - 128 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)
  )
    return true;
  if (
    message?.type === "error" &&
    exact(message, ["type", "code"]) &&
    [
      "UNAVAILABLE",
      "REPLACED",
      "CAPACITY_EXCEEDED",
      "LIMIT_EXCEEDED",
      "INVALID_FRAME",
      "TIMEOUT",
    ].includes(typeof message.code === "string" ? message.code : "")
  )
    return true;
  return false;
}
/** @param {string} data */
export function decodeRelayData(data) {
  const decoded = atob(data);
  if (btoa(decoded) !== data) throw new Error("Relay 编码无效");
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
/** @param {string} channel @param {Uint8Array} bytes */
export function encodeRelayData(channel, bytes) {
  if (!channelShape(channel) || !bytes.length || bytes.length > 49152)
    throw new Error("Relay 数据超过传输上限");
  let data = "";
  for (let i = 0; i < bytes.length; i += 8192)
    data += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const text = JSON.stringify({ type: "data", channel, data: btoa(data) });
  if (text.length > RELAY_FRAME_BYTES) throw new Error("Relay 帧超过传输上限");
  return text;
}
