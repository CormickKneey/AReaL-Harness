export const RELAY_FRAME_BYTES = 512 * 1024;
const channelShape = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
export function decodeRelayMessage(text, binary = false) {
  if (
    binary ||
    typeof text !== "string" ||
    text.length > RELAY_FRAME_BYTES ||
    new TextEncoder().encode(text).length > RELAY_FRAME_BYTES
  )
    throw new Error("Relay 帧无效");
  const message = JSON.parse(text);
  if (
    message?.type === "ready" &&
    ((exact(message, ["type", "channel"]) && channelShape(message.channel)) ||
      (exact(message, ["type", "limits"]) &&
        exact(message.limits, [
          "framesPerSecond",
          "bytesPerSecond",
          "maxFrameBytes",
          "heartbeatIntervalMs",
        ]) &&
        [
          ["framesPerSecond", 80],
          ["bytesPerSecond", 2097152],
          ["maxFrameBytes", RELAY_FRAME_BYTES],
        ].every(
          ([key, ceiling]) =>
            Number.isSafeInteger(message.limits[key]) &&
            message.limits[key] > 0 &&
            message.limits[key] <= ceiling,
        ) &&
        Number.isFinite(message.limits.heartbeatIntervalMs) &&
        message.limits.heartbeatIntervalMs > 0 &&
        message.limits.heartbeatIntervalMs <= 15000))
  )
    return message;
  if (
    ["open", "close"].includes(message?.type) &&
    exact(message, ["type", "channel"]) &&
    channelShape(message.channel)
  )
    return message;
  if (
    message?.type === "data" &&
    exact(message, ["type", "channel", "data"]) &&
    channelShape(message.channel) &&
    typeof message.data === "string" &&
    message.data.length > 0 &&
    message.data.length <= RELAY_FRAME_BYTES - 128 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)
  )
    return message;
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
    ].includes(message.code)
  )
    return message;
  throw new Error("Relay 帧无效");
}
export function decodeRelayData(data) {
  const decoded = atob(data);
  if (btoa(decoded) !== data) throw new Error("Relay 编码无效");
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
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
