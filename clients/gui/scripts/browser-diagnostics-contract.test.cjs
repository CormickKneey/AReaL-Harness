'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validToolInput } = require('../app/src/core/browser-tool.cjs');

test('browser_v1 exposes a bounded diagnostics read without script or unbounded options', () => {
  const pageId = '12345678-1234-1234-1234-123456789abc';
  assert.equal(validToolInput({ operation: 'diagnostics', parameters: { pageId, kind: 'console', limit: 50 } }), true);
  assert.equal(validToolInput({ operation: 'diagnostics', parameters: { pageId, kind: 'network', cursor: 2, limit: 200 } }), true);
  for (const parameters of [
    { pageId, kind: 'network', limit: 201 },
    { pageId, kind: 'network', cursor: -1 },
    { pageId, kind: 'network', script: 'fetch("/private")' },
    { pageId, kind: 'headers' },
  ]) assert.equal(validToolInput({ operation: 'diagnostics', parameters }), false);
});
