// Only provider transport: no conversation store, tool execution or Agent loop.
export function subscriptionRequest(body) {
  if (!body || typeof body.model !== "string" || !Array.isArray(body.input) || body.stream !== true)
    throw new Error("需要流式 Responses 请求");
  const instructions = [],
    input = [];
  for (const item of body.input) {
    if (item.role === "system") {
      const parts = typeof item.content === "string" ? [{ text: item.content }] : item.content;
      if (!Array.isArray(parts) || parts.some((p) => typeof p.text !== "string"))
        throw new Error("系统指令必须为文本");
      instructions.push(parts.map((p) => p.text).join("\n"));
    } else input.push(item);
  }
  // Codex subscription does not accept the Platform token limit controls.
  // Core still owns turn deadlines, cancellation and token accounting.
  return {
    model: body.model,
    input,
    instructions:
      [body.instructions, ...instructions].filter(Boolean).join("\n\n") ||
      "You are a helpful assistant.",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
    ...(body.reasoning ? { reasoning: body.reasoning } : {}),
  };
}

// SIWC permits user tools in namespaces; Core keeps plain tool names and call IDs.
export function openaiRequest(body) {
  const unsupported = [
    "background",
    "conversation",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "min_p",
    "top_k",
    "presence_penalty",
    "repetition_penalty",
    "truncation",
    "user",
    "previous_response_id",
    "max_tool_calls",
  ];
  if (unsupported.some((field) => body[field] != null))
    throw new Error("ChatGPT 不支持此请求参数；请修改配置后重试");
  const value = subscriptionRequest(body);
  if (body.parallel_tool_calls !== undefined) value.parallel_tool_calls = body.parallel_tool_calls;
  if (body.service_tier !== undefined) value.service_tier = body.service_tier;
  if (value.tools?.length) {
    if (value.tools.some((t) => t.type !== "function")) throw new Error("Unsupported OpenAI tool");
    value.tools = [
      { type: "namespace", name: "areal", description: "AReaL Runtime tools", tools: value.tools },
    ];
  }
  value.input = value.input.map((item) =>
    item.type === "function_call" ? { ...item, namespace: "areal" } : item,
  );
  if (value.tool_choice?.type === "function")
    value.tool_choice = { ...value.tool_choice, namespace: "areal" };
  return value;
}

export const protocolAdapters = {
  codex: { encode: subscriptionRequest, protocol: "responses", stream: true },
  // Core 的请求预算仍由 Core 结算；SIWC 不能在服务端强制 max_output_tokens，明确投影此调整。
  openai: {
    encode: openaiRequest,
    protocol: "responses",
    stream: true,
    store: false,
    adjustments: (body) =>
      body.max_output_tokens != null ? ["max_output_tokens:core_budget_only"] : [],
  },
};
