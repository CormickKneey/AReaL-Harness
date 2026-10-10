'use strict';

const definition = Object.freeze({
  name: 'browser_v1',
  description: 'Inspect the user-authorized live page in this desktop thread. Call describe first; only listed operations are available.',
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
  if (value.operation === 'describe') return keys.length === 0;
  if (!['observe', 'capture'].includes(value.operation)
    || typeof value.parameters.pageId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.parameters.pageId)) return false;
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
  return { success: false, contentItems: [{ type: 'inputText', text: `${code}: ${message}` }] };
}

function success(value) {
  return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
}

module.exports = { definition, validToolInput, failure, success };
