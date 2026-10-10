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
  return value.operation === 'observe' && keys.length === 1
    && typeof value.parameters.pageId === 'string' && /^[0-9a-f-]{36}$/.test(value.parameters.pageId);
}

function failure(code, message) {
  return { success: false, contentItems: [{ type: 'inputText', text: `${code}: ${message}` }] };
}

function success(value) {
  return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
}

module.exports = { definition, validToolInput, failure, success };
