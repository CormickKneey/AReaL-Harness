import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ceilings = Object.freeze({ maxHosts: 100, maxRooms: 10000, maxEnrollmentCodes: 1024, maxConnections: 256,
  maxPending: 32, maxChannelsPerHost: 16, maxFrameBytes: 524288, maxBufferedBytesPerChannel: 2097152,
  framesPerSecond: 80, bytesPerSecond: 2097152, upgradePerSecond: 50, enrollPerSecond: 10,
  handshakeTimeoutMs: 15000, idleTimeoutMs: 45000 });
export function readConfig(file) {
  const input = JSON.parse(readFileSync(file, 'utf8'));
  const origin = new URL(input.publicOrigin);
  const development = input.development === true;
  if (origin.origin !== input.publicOrigin || origin.username || origin.password ||
      (development ? origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) : origin.protocol !== 'https:')) throw new Error('CONFIG_ORIGIN');
  // 后端仅绑定本机；生产 TLS 代理必须保留配置中的 Host，不信任转发头。
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(input.listen);
  if (!match || +match[2] < 1 || +match[2] > 65535 || (!development && input.trustedLocalTlsProxy !== true)) throw new Error('CONFIG_LISTEN');
  if (!Array.isArray(input.allowedClientOrigins) || !input.allowedClientOrigins.length || input.allowedClientOrigins.some(value => {
    try { const u = new URL(value); return u.origin !== value || u.protocol !== origin.protocol || (development && !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)); } catch { return true; }
  })) throw new Error('CONFIG_CLIENT_ORIGIN');
  const limits = {};
  for (const [key, max] of Object.entries(ceilings)) {
    const value = input[key] ?? max;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('CONFIG_LIMIT');
    limits[key] = value;
  }
  if (input.payloadLogging !== undefined && input.payloadLogging !== false) throw new Error('CONFIG_LOGGING');
  if (typeof input.dataDir !== 'string' || !input.dataDir) throw new Error('CONFIG_DATA');
  return { ...limits, publicOrigin: origin.origin, publicHost: origin.host, development,
    listenHost: match[1].replace(/[\[\]]/g, ''), listenPort: +match[2],
    allowedClientOrigins: input.allowedClientOrigins, dataDir: resolve(input.dataDir),
    assetsDir: input.assetsDir ? resolve(input.assetsDir) : undefined };
}
