"use strict";
const definitions = require("./definitions.json");
const definition = (id) => definitions.find((item) => item.id === id);
// Core 保存的连接不增加私有 schema 字段；服务定义与连接元信息只作为客户端投影。
function connectionMetadata(provider, credentialSources = {}) {
    const protocol =
        provider.protocol === "chat-completions" ? "chatCompletions" : provider.protocol;
    const baseUrl =
        provider.endpoint?.replace(/\/(responses|chat\/completions)\/?$/, "") ?? provider.baseUrl;
    const preset =
        definitions.find(
            (item) =>
                item.kind === "api" &&
                item.baseUrl === baseUrl &&
                item.protocols.includes(protocol),
        ) ?? definition("custom-compatible");
    return {
        definitionId: preset.id,
        connectionId: provider.id,
        billing: preset.billing,
        authentication: provider.apiKeyEnv ? "apiKey" : "none",
        credentialSource: credentialSources[provider.id] ?? "none",
        region: preset.regions.find((region) => region.baseUrl === baseUrl)?.id ?? null,
        discovery: preset.discovery,
        capabilityDefaults: preset.capabilityDefaults,
    };
}
const recommendedReasoningEfforts = Object.freeze(["low", "medium", "high", "xhigh"]);
function withDefaultModelCapabilities(model, providerParameters = {}) {
    if (model.capabilities !== undefined) return model;
    const effort = model.parameters?.reasoningEffort ?? providerParameters.reasoningEffort;
    return { ...model, capabilities: { tools: true, vision: false, reasoning: true,
        reasoningEffortOptions: [...new Set([...recommendedReasoningEfforts, ...(effort ? [effort] : [])])] } };
}
module.exports = { definitions, connectionMetadata, recommendedReasoningEfforts, withDefaultModelCapabilities };
