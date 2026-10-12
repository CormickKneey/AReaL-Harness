import { setTimeout as delay } from "node:timers/promises";

export async function waitForServiceState(status, expected, timeoutMs = 20000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await status();
      if (last.state === expected) return last;
    } catch (error) {
      let diagnostic;
      try {
        diagnostic = JSON.parse(error.stderr)?.error;
      } catch {
        throw error;
      }
      // 故障注入后，控制 socket 的 Ready 与 HTTP 探测之间 Core 可能已退出。
      // 仅重试已知的本地探测连接拒绝；认证、协议和其他错误必须立即失败。
      if (
        diagnostic?.code !== "localServiceError" ||
        !/^error sending request for url \(http:\/\/127\.0\.0\.1:\d+\/areal\/service\): .*tcp connect error: Connection refused \(os error (61|111)\)$/.test(
          diagnostic.message,
        )
      ) {
        throw error;
      }
      last = diagnostic;
      console.log(`Waiting for service ${expected}: ${diagnostic.message}`);
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw Error(`service did not reach ${expected} before deadline; last: ${JSON.stringify(last)}`);
}
