// 仅用于强杀故障后的收敛检查；普通服务查询仍须直接暴露所有错误。
export async function waitForFaultStatus(
  query,
  expectedState,
  { timeoutMs = 20000, onRefused = () => {} } = {},
) {
  const end = Date.now() + timeoutMs;
  let lastRefused;
  while (Date.now() < end) {
    try {
      const service = await query(Math.max(1, end - Date.now()));
      if (service.state === expectedState && Date.now() < end) return service;
    } catch (error) {
      let response;
      try {
        response = JSON.parse(error.stderr);
      } catch {
        throw error;
      }
      // 宿主可能先关闭 listener，再等待持锁的 launcher 清理。只接受 CLI
      // 明确报告的这一过渡，不吞协议、权限、超时或其他服务故障。
      if (
        error.code !== 1 ||
        error.killed ||
        error.signal != null ||
        error.stdout?.trim() ||
        response?.error?.code !== "localServiceError" ||
        !/^Connection refused \(os error (61|111)\)$/.test(response?.error?.message)
      ) {
        throw error;
      }
      lastRefused = error;
      onRefused();
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(0, end - Date.now()))),
    );
  }
  throw new Error(`service did not reach ${expectedState} within ${timeoutMs} ms`, {
    cause: lastRefused,
  });
}
