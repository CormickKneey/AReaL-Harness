import type { Data } from "./services.js";

export function isOrdinaryConversation(thread: Data, configuration?: Data): boolean {
  return !thread.parentThreadId && !thread.goalOwner && thread.source !== "nativeTaskAgent"
    && thread.conversation?.kind !== "side" && !thread.goals?.goal
    && !configuration?.options?.appendInstructions?.startsWith("AREAL_TASK_DRAFT_V1\n");
}

export function interruptedConversationTurn(thread: Data): Data | undefined {
  const latest = thread.turns?.at(-1);
  if (thread.turns?.some((turn: Data) => turn.status === "inProgress")) return undefined;
  if (latest?.status === "interrupted" || latest?.status === "failed" && (latest.interruption
    || latest.error?.outcome?.source === "core_recovery" && latest.error?.outcome?.code === "HARNESS_INTERNAL_ERROR"
      && latest.error?.outcome?.details?.reason === "unknown_tool_outcome")) return latest;
  return undefined;
}

export function interruptionLabel(turn: Data): string {
  return turn.interruption === "userPause" ? "执行已暂停"
    : turn.interruption === "coreRecovery" ? "执行意外中断" : "执行已中断";
}
