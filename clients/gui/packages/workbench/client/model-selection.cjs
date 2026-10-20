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

module.exports = { resolveNewConversationModel };
