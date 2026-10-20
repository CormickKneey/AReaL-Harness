export class CoreRpcError extends Error {
  code?: string | number;
  method?: string;
  data?: { reason?: string; requestId?: string; retryable?: boolean; [key: string]: unknown };
  reason?: string;
  requestId?: string;
  submissionUnknown: boolean;
}
export interface CoreSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  send(data: string): void;
  close(): void;
}
export class CoreClient {
  constructor(options: { createSocket: () => CoreSocket; timeoutMs?: number; onServerRequest?: (method: string, params: unknown, context: { requestId: string; signal: AbortSignal }) => Promise<unknown> });
  ready: boolean;
  capabilities: { apiVersion?: string; methods: string[]; [key: string]: unknown };
  connect(): Promise<CoreClient['capabilities']>;
  request<T = unknown>(method: string, params?: object, options?: { onResult?: (result: T) => void; timeoutMs?: number }): Promise<T>;
  onNotification(listener: (method: string, params: any) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export type ModelUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export type GenerationStats = { outputTokens: number; durationMs: number; measuredRequests: number; unmeasuredRequests: number; usageRequests: number; missingUsageRequests: number };
export type ContextPartKind = 'systemPrompt' | 'rules' | 'skills' | 'toolDefinitions' | 'conversation' | 'summary' | 'attachments' | 'toolResults' | 'other';
export type ContextPart = { kind: ContextPartKind; name: string; estimatedTokens: number; children?: ContextPart[] };
export type InstructionAttribution = { sha256: string; parts: ContextPart[] };
export type TurnUsage = { usage?: ModelUsage | null; generation?: GenerationStats | null; instructionAttribution?: InstructionAttribution | null };
export type ContextBasis = { provider: string; model: string; configurationRevision: number; defaultModelRevision: string | null; turnId: string | null };
export type ContextBudget = { windowTokens: number; outputReserveTokens: number; inputLimitTokens: number; windowSource: 'account' | 'provider' | 'user' | 'modelDefault' | 'fallback' | 'model'; reportedWindowTokens?: number; reportedWindowSource?: 'account' | 'provider'; userBudgetTokens?: number };
export type ContextUsage =
  | { kind: 'ready'; basis: ContextBasis; budget: ContextBudget; scope: { kind: 'assembledRequest'; sequence: number } | { kind: 'recordedHistory' }; estimate: { tokens: number; parts: ContextPart[] } }
  | { kind: 'unavailable'; basis: ContextBasis; budget: ContextBudget | null; reason: 'awaitingRequest' | 'modelUnavailable' | 'instructionBasisChanged' };
export type SessionUsage = { usage: ModelUsage | null; generation: GenerationStats; knownTurns: number; unknownTurns: number; partialTurns: number; scope: 'ownTurns' };
export type ContextUsageResponse = { threadId: string; contextUsage: ContextUsage; sessionUsage: SessionUsage };
