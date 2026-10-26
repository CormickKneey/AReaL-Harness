// @ts-check
"use strict";
const { createServer, connect } = require("node:net");
const { createHash } = require("node:crypto");

/** @param {NodeJS.ProcessEnv} environment
 * @param {{ports?:Record<string,number>,save?:(ports:Record<string,number>)=>Promise<void>,platform?:NodeJS.Platform}} [options] */
async function proxyRelay(
  environment,
  { ports = {}, save = async () => {}, platform = process.platform } = {},
) {
  const env = { ...environment },
    servers = /** @type {import("node:net").Server[]} */ ([]),
    sockets = new Set(/** @type {import("node:net").Socket[]} */ ([])),
    replacements = new Map(/** @type {[string,string][]} */ ([]));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  };
  if (platform !== "darwin") return { environment: env, close };
  try {
    if (!ports || typeof ports !== "object" || Array.isArray(ports))
      throw new Error("本地代理转接配置无效");
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      const value = env[name];
      if (!value || !/^socks(?:4a?|5h?):\/\//i.test(value)) continue;
      if (!replacements.has(value)) {
        const target = new URL(value),
          key = createHash("sha256").update(value).digest("hex");
        const upstreamAddress = {
          host: target.hostname.replace(/^\[|\]$/g, ""),
          port: Number(target.port) || 1080,
        };
        const port = ports[key] ?? 0;
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new Error("本地代理转接端口无效");
        // 只转接到固定的已配置代理；SOCKS 握手、认证、远端 DNS 和 TLS 原样透传。
        // Node 负责上游连接，规避部分 macOS 系统代理对原生 Core 连接的兼容性问题。
        const server = createServer((client) => {
          const upstream = connect(upstreamAddress);
          for (const socket of [client, upstream]) {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => {
              client.destroy();
              upstream.destroy();
            });
          }
          upstream.setTimeout(10000, () => {
            client.destroy();
            upstream.destroy();
          });
          upstream.once("connect", () => {
            upstream.setTimeout(0);
            client.pipe(upstream).pipe(client);
          });
          client.once("close", () => upstream.destroy());
          upstream.once("close", () => {
            // 正常 EOF 由 pipe 刷完写缓冲后结束客户端，避免截断大响应。
            if (!upstream.readableEnded) client.destroy();
          });
        });
        servers.push(server);
        await new Promise(
          /** @param {(value?:void)=>void} resolve */ (resolve, reject) => {
            server.once("error", reject);
            server.listen(port, "127.0.0.1", () => {
              server.removeListener("error", reject);
              resolve();
            });
          },
        );
        // This server listens on a numeric TCP port, never an IPC path.
        ports[key] = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
        target.hostname = "127.0.0.1";
        target.port = String(ports[key]);
        replacements.set(value, target.toString());
      }
      env[name] = replacements.get(value);
    }
    // 仅保存地址摘要与监听端口，后台重启复用端口；不落盘上游代理凭据。
    if (servers.length) await save(ports);
    return { environment: env, close };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { proxyRelay };
