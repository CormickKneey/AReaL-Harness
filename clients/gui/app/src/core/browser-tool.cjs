'use strict';

const definition = Object.freeze({
  name: 'browser_v1',
  description: 'Inspect and navigate authorized pages in this desktop thread. Call describe first; page changes require Core approval.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string' },
      parameters: { type: 'object' },
    },
    required: ['operation', 'parameters'],
    additionalProperties: false,
  },
});

function validToolInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['operation', 'parameters'].includes(key))
    || !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) return false;
  const keys = Object.keys(value.parameters);
  if (['navigate', 'newPage'].includes(value.operation)) {
    if (!keys.every(key => ['pageId', 'url'].includes(key)) ||
      typeof value.parameters.pageId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.parameters.pageId) ||
      typeof value.parameters.url !== 'string' || value.parameters.url.length > 2048) return false;
    try {
      const url = new URL(value.parameters.url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }
  if (value.operation === 'describe') return keys.length === 0;
  if (value.operation === 'runBatch') {
    if (!keys.every(key => ['pageId', 'snapshotId', 'steps'].includes(key))
      || typeof value.parameters.pageId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.parameters.pageId)
      || typeof value.parameters.snapshotId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.parameters.snapshotId)
      || !Array.isArray(value.parameters.steps) || value.parameters.steps.length < 1 || value.parameters.steps.length > 8) return false;
    if (value.parameters.steps.reduce((total, step) => total + (step?.operation === 'wait' ? step.timeoutMs : 0), 0) > 29000) return false;
    return value.parameters.steps.every((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
      if (step.operation === 'wait') return Object.keys(step).every(key => ['operation', 'timeoutMs'].includes(key))
        && Number.isSafeInteger(step.timeoutMs) && step.timeoutMs >= 1 && step.timeoutMs <= 30000;
      if (step.operation !== 'act' || Object.keys(step).some(key => !['operation', 'snapshotId', 'action'].includes(key))
        || step.snapshotId !== value.parameters.snapshotId
        || (index > 0 && ['clickAt', 'drag', 'pressAt'].includes(step.action?.kind))) return false;
      return validToolInput({ operation: 'act', parameters: { pageId: value.parameters.pageId,
        snapshotId: step.snapshotId, action: step.action } });
    });
  }
  if (value.operation === 'diagnostics') return typeof value.parameters.pageId === 'string'
    && /^[0-9a-f-]{36}$/.test(value.parameters.pageId)
    && keys.every(key => ['pageId', 'kind', 'cursor', 'limit'].includes(key))
    && ['console', 'network'].includes(value.parameters.kind)
    && (value.parameters.cursor === undefined || (Number.isSafeInteger(value.parameters.cursor) && value.parameters.cursor >= 0))
    && (value.parameters.limit === undefined || (Number.isSafeInteger(value.parameters.limit)
      && value.parameters.limit >= 1 && value.parameters.limit <= 200));
  if (!['observe', 'capture', 'act', 'wait'].includes(value.operation)
    || typeof value.parameters.pageId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.parameters.pageId)) return false;
  if (value.operation === 'wait') return keys.every(key => ['pageId', 'timeoutMs'].includes(key))
    && Number.isSafeInteger(value.parameters.timeoutMs) && value.parameters.timeoutMs >= 1 && value.parameters.timeoutMs <= 30000;
  if (value.operation === 'act') {
    if (!keys.every(key => ['pageId', 'snapshotId', 'action'].includes(key))
      || typeof value.parameters.snapshotId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.parameters.snapshotId)) return false;
    const action = value.parameters.action;
    if (!action || typeof action !== 'object' || Array.isArray(action)
      || typeof action.kind !== 'string') return false;
    const coordinate = key => Number.isSafeInteger(action[key]) && action[key] >= 0 && action[key] <= 4096;
    const key = () => typeof action.key === 'string' && /^(Enter|Tab|Escape|Backspace|Arrow(Up|Down|Left|Right))$/.test(action.key);
    if (action.kind === 'clickAt') return Object.keys(action).every(key => ['kind', 'x', 'y'].includes(key))
      && coordinate('x') && coordinate('y');
    if (action.kind === 'drag') return Object.keys(action).every(key => ['kind', 'fromX', 'fromY', 'toX', 'toY', 'steps'].includes(key))
      && ['fromX', 'fromY', 'toX', 'toY'].every(coordinate)
      && Number.isSafeInteger(action.steps) && action.steps >= 1 && action.steps <= 20;
    if (action.kind === 'pressAt') return Object.keys(action).every(key => ['kind', 'x', 'y', 'key'].includes(key))
      && coordinate('x') && coordinate('y') && key();
    if (typeof action.ref !== 'string' || !/^r[1-9]\d*$/.test(action.ref)) return false;
    if (action.kind === 'click') return Object.keys(action).every(key => ['kind', 'ref'].includes(key));
    if (action.kind === 'fill') return Object.keys(action).every(key => ['kind', 'ref', 'value'].includes(key))
      && typeof action.value === 'string' && action.value.length <= 4096;
    if (action.kind === 'press') return Object.keys(action).every(key => ['kind', 'ref', 'key'].includes(key))
      && key();
    return false;
  }
  if (value.operation === 'capture') return keys.every(key => ['pageId', 'scope'].includes(key))
    && value.parameters.scope === 'viewport';
  if (!keys.every(key => ['pageId', 'scope', 'budget', 'rootRef'].includes(key))) return false;
  if (value.parameters.scope !== undefined && value.parameters.scope !== 'document') return false;
  if (value.parameters.rootRef !== undefined && (typeof value.parameters.rootRef !== 'string' || !/^r[1-9]\d*$/.test(value.parameters.rootRef))) return false;
  const budget = value.parameters.budget;
  return budget === undefined || (budget && typeof budget === 'object' && !Array.isArray(budget)
    && Object.keys(budget).every(key => ['nodes', 'textBytes'].includes(key))
    && (budget.nodes === undefined || (Number.isSafeInteger(budget.nodes) && budget.nodes >= 1 && budget.nodes <= 1000))
    && (budget.textBytes === undefined || (Number.isSafeInteger(budget.textBytes) && budget.textBytes >= 256 && budget.textBytes <= 128 * 1024)));
}

function failure(code, message) {
  return { success: false, contentItems: [{ type: 'inputText', text: `${code}: ${message}` }],
    structuredContent: { code, dispatch: 'not_sent' } };
}

function success(value) {
  return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
}

module.exports = { definition, validToolInput, failure, success };
