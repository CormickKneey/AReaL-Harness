import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { WorkspaceNetworkPolicy } = require('../app/src/core/browser-network.cjs');

test('a Workspace permits only its exact authorized site and never actual adapter/Core endpoints', () => {
  const policy = new WorkspaceNetworkPolicy(() => ['ws://127.0.0.1:41001', 'ws://127.0.0.1:41002']);
  assert.equal(policy.allowHumanNavigation('http://127.0.0.1:41001/', true), false);
  assert.equal(policy.allowHumanNavigation('http://localhost:41002/', true), false);
  assert.equal(policy.allowHumanNavigation('http://169.254.169.254/latest/meta-data/', true), false);
  assert.equal(policy.allowHumanNavigation('http://192.168.1.1/', true), false);
  assert.equal(policy.allowHumanNavigation('http://127.0.0.1:31000/login'), false);
  assert.equal(policy.allowHumanNavigation('http://127.0.0.1:31000/login', true), true);
  assert.equal(policy.permits({ url: 'http://127.0.0.1:31000/callback', resourceType: 'mainFrame' }), true);
  assert.equal(policy.permits({ url: 'http://127.0.0.1:31000/sw.js', resourceType: 'other' }), true);
  for (const url of ['http://127.0.0.1:41001/api', 'http://localhost:41002/api', 'http://localhost:31000/',
    'http://127.0.0.1:31001/', 'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd']) assert.equal(policy.permits({ url, resourceType: 'xhr' }), false, url);
  assert.equal(policy.permits({ url: 'ws://127.0.0.1:31000/chat', resourceType: 'webSocket' }), false);
});

test('the Session request hook denies redirects, frames and fetch outside a granted Origin', async () => {
  const listeners = {};
  const session = { resolveHost: async () => ({ endpoints: [{ address: '93.184.215.14' }] }), webRequest: {
    onBeforeRequest: (_, listener) => { listeners.beforeRequest = listener; },
    onHeadersReceived: (_, listener) => { listeners.headersReceived = listener; },
  } };
  const policy = new WorkspaceNetworkPolicy(() => 'ws://127.0.0.1:41001');
  policy.install(session);
  policy.allowHumanNavigation('http://127.0.0.1:31000/', true);
  const result = details => new Promise(resolve => listeners.beforeRequest(details, resolve));
  assert.deepEqual(await result({ url: 'http://127.0.0.1:31000/next', resourceType: 'mainFrame' }), { cancel: false });
  for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'other', 'webSocket']) {
    assert.deepEqual(await result({ url: 'http://127.0.0.1:41001/private', resourceType }), { cancel: true });
  }
  let headers;
  listeners.headersReceived({ url: 'http://127.0.0.1:31000/', resourceType: 'mainFrame',
    responseHeaders: { 'Content-Type': ['text/html'] } }, value => { headers = value.responseHeaders; });
  assert.match(headers['Content-Security-Policy'][0], /connect-src 'self'; frame-src 'self'; worker-src 'self'/);
  assert.deepEqual(headers['Connection-Allowlist'], ['(response-origin); redirects=allow']);
  assert.deepEqual(await result({ url: 'ws://127.0.0.1:31000/socket', resourceType: 'webSocket' }), { cancel: true });
  policy.close();
  assert.deepEqual(await result({ url: 'http://127.0.0.1:31000/next', resourceType: 'mainFrame' }), { cancel: true });
});

test('public-looking names resolving to private addresses are blocked', async () => {
  const policy = new WorkspaceNetworkPolicy();
  assert.equal(policy.allowHumanNavigation('https://rebound.example/login'), true);
  const privateSession = { resolveHost: async () => ({ endpoints: [{ address: '169.254.169.254' }] }) };
  assert.equal(await policy.permitsResolved({ url: 'https://rebound.example/data', resourceType: 'xhr' }, privateSession), false);
});
