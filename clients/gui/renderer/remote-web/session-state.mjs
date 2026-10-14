// 旧身份消息丢弃；当前身份的序号缺口要求重新读取原子基线。
export function acceptSessionMessage(current, message) {
  if (
    !current ||
    ["connectionId", "gatewayGeneration", "serviceGeneration", "subscriptionId", "projectId"].some(
      (key) => current[key] !== message[key],
    )
  )
    return { kind: "ignore" };
  if (message.sequence !== current.sequence + 1) return { kind: "resync" };
  if (message.event === "session.invalidated") return { kind: "unavailable", error: message.error };
  if (message.snapshot?.threadId !== current.snapshot?.threadId) return { kind: "resync" };
  return { kind: "update", value: message };
}
