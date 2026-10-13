import { byteChannel } from "./channel.mjs";
import {
  decodeRelayMessage,
  decodeRelayData,
  encodeRelayData,
  RELAY_FRAME_BYTES,
} from "./relay-codec.mjs";

export function remoteLocator(fragment) {
  const host = fragment.get("host"),
    room = fragment.get("room");
  if (host !== null && !/^[A-Za-z0-9]{20,128}$/.test(host)) throw new Error("Host 身份无效");
  if (room !== null && !/^[a-f0-9]{64}$/.test(room)) throw new Error("Relay 房间无效");
  if (room !== null && !host) throw new Error("Relay 缺少 Host 身份");
  return { host, room };
}
export function publicLocator({ host, room }) {
  const result = new URLSearchParams();
  if (host) result.set("host", host);
  if (room) result.set("room", room);
  remoteLocator(result);
  return result.toString();
}

// socket 始终由调用方以当前页面 origin 构造；此层不接受 URL、身份或业务请求。
export function createRemoteWire(socket, { room = null } = {}) {
  if (room !== null && !/^[a-f0-9]{64}$/.test(room)) throw new Error("Relay 房间无效");
  socket.binaryType = "arraybuffer";
  let channel,
    settled = false,
    resolveReady,
    rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finish = () => {
    settled = true;
    clearTimeout(deadline);
    resolveReady();
  };
  const failure = () => {
    clearTimeout(deadline);
    if (!settled) {
      settled = true;
      rejectReady(new Error("Host 暂不可用，请检查连接"));
    }
    wire.close();
  };
  const write = (bytes) => {
    if (!settled || socket.readyState !== 1 || (room && !channel)) throw new Error("Host 尚未连接");
    const send = (value) => {
      const size = typeof value === "string" ? value.length : value.length;
      if (size > RELAY_FRAME_BYTES || socket.bufferedAmount + size > 1024 * 1024)
        throw new Error("连接发送缓冲已满");
      socket.send(value);
    };
    if (!room) send(bytes);
    else
      for (let offset = 0; offset < bytes.length; offset += 49152)
        send(encodeRelayData(channel, bytes.subarray(offset, offset + 49152)));
  };
  const wire = byteChannel(
    (bytes) => {
      try {
        write(bytes);
      } catch (error) {
        failure();
        throw error;
      }
    },
    () => socket.close(),
  );
  const deadline = setTimeout(failure, 15000);
  socket.addEventListener("open", () => {
    if (room) socket.send(JSON.stringify({ protocol: "areal.relay.v1", role: "client", room }));
    else finish();
  });
  socket.addEventListener("message", (event) => {
    try {
      if (!room) {
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > RELAY_FRAME_BYTES)
          throw new Error();
        wire.receive(new Uint8Array(event.data));
      } else {
        const message = decodeRelayMessage(event.data);
        if (!channel) {
          if (message.type !== "ready" || !message.channel) throw new Error();
          channel = message.channel;
          finish();
        } else if (message.channel === channel && message.type === "data")
          wire.receive(decodeRelayData(message.data));
        else if (message.channel === channel && message.type === "close") failure();
        else throw new Error();
      }
    } catch {
      failure();
    }
  });
  socket.addEventListener("close", failure);
  socket.addEventListener("error", failure);
  return { wire, ready };
}
