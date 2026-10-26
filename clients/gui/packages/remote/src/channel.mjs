// @ts-check
import { noise } from "@chainsafe/libp2p-noise";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { pushable } from "it-pushable";
import { encode, decode } from "it-length-prefixed";
import { AbstractMessageStream } from "@libp2p/utils";

/** @param {Uint8Array} bytes */
export const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
/** @param {string} value */
export const unbase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
export async function createIdentity() {
  return base64(privateKeyToProtobuf(await generateKeyPair("Ed25519")));
}
/** @param {string} identity */
export function identityId(identity) {
  return peerIdFromPrivateKey(privateKeyFromProtobuf(unbase64(identity))).toString();
}
/** @param {string} value */
export function relayUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Error("中继必须使用 WSS；本机开发可使用 loopback WS");
  return url.href;
}
/** @type {ReturnType<import('@chainsafe/libp2p-noise').NoiseComponents['logger']['forComponent']>} */
const silent = Object.assign(() => {}, {
  error() {},
  trace() {},
  enabled: false,
  newScope() {
    return silent;
  },
});

// Noise owns authentication and encryption. This adapter keeps the transport's
// existing iterable entrypoints while implementing libp2p's MessageStream API.
class NoiseByteStream extends AbstractMessageStream {
  /** @param {(bytes:Uint8Array)=>void|Promise<void>} write @param {()=>void} terminate */
  constructor(write, terminate) {
    super({
      log: silent,
      maxReadBufferLength: 2 * 1024 * 1024,
      maxWriteBufferLength: 2 * 1024 * 1024,
      inactivityTimeout: 0,
    });
    this.write = write;
    this.terminate = terminate;
    this.source = pushable({ objectMode: false });
    this.pendingWriteBytes = 0;
    this.stopped = false;
  }
  /** @param {AsyncIterable<Pick<Uint8Array,'subarray'>>|Iterable<Pick<Uint8Array,'subarray'>>} source */
  async sink(source) {
    for await (const bytes of source) {
      if (this.stopped) throw new Error("连接已断开");
      await this.write(bytes.subarray());
    }
  }
  async attach() {
    try {
      for await (const bytes of this.source) this.onData(bytes);
      this.onTransportClosed();
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error(String(error)));
    }
  }
  /** @param {Parameters<AbstractMessageStream['sendData']>[0]} data */
  sendData(data) {
    const result = this.write(data.subarray());
    if (!result) return { sentBytes: data.byteLength, canSendMore: true };
    this.pendingWriteBytes = data.byteLength;
    void result.then(
      () => {
        this.pendingWriteBytes = 0;
        this.onMuxerDrain();
      },
      (error) => this.abort(error instanceof Error ? error : new Error(String(error))),
    );
    return { sentBytes: data.byteLength, canSendMore: false };
  }
  sendReset() {
    void this.close();
  }
  // WebSocket peers do not expose a pause protocol. Inbound queues are bounded.
  sendPause() {}
  sendResume() {}
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.source.end();
    this.onTransportClosed();
    this.terminate();
  }
}
/** @param {(bytes:Uint8Array)=>void|Promise<void>} write @param {()=>void} terminate */
export function byteChannel(write, terminate) {
  const stream = new NoiseByteStream(write, terminate);
  return {
    get bufferedBytes() {
      return stream.source.readableLength + stream.readBufferLength;
    },
    stream,
    /** @param {Uint8Array} bytes */
    receive(bytes) {
      if (stream.source.readableLength + stream.readBufferLength + bytes.length > 2 * 1024 * 1024)
        throw new Error("连接接收缓冲已满");
      stream.source.push(bytes);
    },
    close() {
      void stream.close();
    },
  };
}
/** @param {ReturnType<typeof byteChannel>} wire @param {string} identity @param {string|undefined} hostPeer
 * @param {{maxMessageBytes?:number,maxBufferedBytes?:number}} [limits] */
export async function secureChannel(wire, identity, hostPeer, limits = {}) {
  const privateKey = privateKeyFromProtobuf(unbase64(identity));
  const encryption = noise({ prologueBytes: new TextEncoder().encode("areal.remote.v1") })({
    privateKey,
    peerId: peerIdFromPrivateKey(privateKey),
    logger: { forComponent: () => silent },
    upgrader: { getStreamMuxers: () => new Map() },
  });
  void wire.stream.attach();
  let secured;
  try {
    const options = { signal: AbortSignal.timeout(15000), skipStreamMuxerNegotiation: true };
    secured = hostPeer
      ? await encryption.secureOutbound(wire.stream, {
          ...options,
          remotePeer: peerIdFromString(hostPeer),
        })
      : await encryption.secureInbound(wire.stream, options);
  } catch (error) {
    wire.close();
    throw error;
  }
  const output = pushable({ objectMode: false });
  const input = pushable({ objectMode: false });
  secured.connection.maxReadBufferLength = 2 * 1024 * 1024;
  /** @param {{data:Pick<Uint8Array,'subarray'>}} event */
  const receive = (event) => {
    const bytes = event.data.subarray();
    if (input.readableLength + bytes.length > 2 * 1024 * 1024) {
      input.end(new Error("连接接收缓冲已满"));
      wire.close();
      return;
    }
    input.push(bytes);
  };
  secured.connection.addEventListener("message", receive);
  secured.connection.addEventListener("close", (event) => {
    input.end(event.error);
    output.end();
  });
  /** @type {unknown} */ let failure;
  const maxMessageBytes = limits.maxMessageBytes ?? 24 * 1024 * 1024;
  const maxBufferedBytes = limits.maxBufferedBytes ?? 32 * 1024 * 1024;
  secured.connection.maxWriteBufferLength = maxBufferedBytes;
  const done = (async () => {
    for await (const bytes of encode(output)) {
      if (!secured.connection.send(bytes)) await secured.connection.onDrain();
    }
  })().catch((error) => {
    failure = error;
    wire.close();
  });
  const bufferedBytes = () =>
    output.readableLength +
    secured.connection.writeBufferLength +
    wire.stream.writeBufferLength +
    wire.stream.pendingWriteBytes;
  return {
    peer: secured.remotePeer.toString(),
    done,
    // 只读排队字节用于验证发送各阶段的总预算，不暴露消息内容。
    get bufferedBytes() {
      return bufferedBytes();
    },
    get receiveBufferedBytes() {
      return input.readableLength + secured.connection.readBufferLength;
    },
    /** @param {unknown} value */
    send(value) {
      const data = new TextEncoder().encode(JSON.stringify(value));
      if (data.length > maxMessageBytes || bufferedBytes() + data.length > maxBufferedBytes) {
        wire.close();
        throw new Error("数据超过传输上限");
      }
      output.push(data);
    },
    /** @returns {AsyncGenerator<unknown,void,unknown>} */
    async *messages() {
      try {
        for await (const frame of decode(input, { maxDataLength: maxMessageBytes }))
          yield JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray()));
        if (failure) throw failure;
      } finally {
        secured.connection.removeEventListener("message", receive);
        output.end();
        wire.close();
      }
    },
    close() {
      output.end();
      wire.close();
    },
  };
}

export { decodeRelayMessage, decodeRelayData, encodeRelayData } from "./relay-codec.mjs";
