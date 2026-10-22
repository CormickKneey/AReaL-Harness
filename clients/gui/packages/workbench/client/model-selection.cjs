'use strict';

function resolveNewConversationModel(models, lastAcceptedModel) {
  const remembered = lastAcceptedModel && models.find(item =>
    (item.providerId ?? null) === (lastAcceptedModel.model?.providerId ?? null)
    && item.modelId === lastAcceptedModel.modelId);
  const useRemembered = !!remembered && remembered.available !== false;
  const candidate = useRemembered ? remembered : models.find(item => item.isDefault);
  const effort = useRemembered ? lastAcceptedModel.reasoningEffort : undefined;
  const unsupportedEffort = effort != null && !candidate?.reasoningEffortOptions?.includes(effort);
  return {
    candidate,
    rememberedEffort: unsupportedEffort ? undefined : effort,
    notice: lastAcceptedModel && !useRemembered ? 'model-unavailable'
      : unsupportedEffort ? 'effort-unsupported' : undefined,
  };
}

function resolveModelEffort(model, preferredEffort) {
  if (!model || model.capabilities?.reasoning === false) return undefined;
  const options = model.reasoningEffortOptions ?? [];
  return [preferredEffort, model.parameters?.reasoningEffort, 'medium', options[0]]
    .find(effort => effort != null && options.includes(effort));
}

module.exports = { resolveNewConversationModel, resolveModelEffort };
