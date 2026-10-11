'use strict';

const { isIP } = require('node:net');

// A separate instance is installed on each in-memory Workspace Session. Only
// trusted Main navigation commands or a Core-approved plan grant an exact
// Origin; page scripts and redirects never add grants.
const REQUEST_CSP = "connect-src 'self'; frame-src 'self'; worker-src 'self'; child-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'";
// Chromium 152 covers connection types outside CSP (including WebRTC and DNS
// prefetch). Redirects remain subject to the Session request hook below.
const CONNECTION_ALLOWLIST = '(response-origin); redirects=allow';

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function loopback(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || b === 0)) && !(a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const head = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    return /^[23][0-9a-f]{3}:/.test(head) && !head.startsWith('2001:db8:');
  }
  return false;
}

class WorkspaceNetworkPolicy {
  constructor(controlEndpoint = () => null, ownsDevTools = () => false) {
    this.controlEndpoint = controlEndpoint;
    this.ownsDevTools = ownsDevTools;
    this.origins = new Set();
    this.active = true;
  }
  isControl(url) {
    const endpoints = this.controlEndpoint();
    for (const value of Array.isArray(endpoints) ? endpoints : [endpoints]) {
      let endpoint;
      try { endpoint = new URL(value); } catch { continue; }
      if (loopback(url.hostname) && loopback(endpoint.hostname) && url.port === endpoint.port) return true;
    }
    return false;
  }
  // Main sets explicitIntent only for the submitted address bar, not for a
  // preview URL supplied by another surface or for an automatic restoration.
  allowHumanNavigation(value, explicitIntent = false) {
    const url = httpUrl(value);
    return !!url && (!loopback(url.hostname) || explicitIntent === true) && this.authorize(value);
  }
  allowApprovedNavigation(value) { return this.authorize(value); }
  canAuthorize(value) {
    const url = httpUrl(value);
    if (!this.active || !url || this.isControl(url)) return false;
    const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    return loopback(url.hostname) || (!isIP(host) && !/(^|\.)(local|internal)$/.test(host));
  }
  authorize(value) {
    const url = httpUrl(value);
    if (!this.canAuthorize(value)) return false;
    this.origins.add(url.origin);
    return true;
  }
  permitsDevTools(details) {
    let url;
    try { url = new URL(details.url); } catch { return false; }
    return this.active && url.protocol === 'devtools:' && url.hostname === 'devtools'
      && url.pathname.startsWith('/bundled/') && this.ownsDevTools(details.webContentsId);
  }
  permits(details) {
    if (this.permitsDevTools(details)) return true;
    const url = httpUrl(details.url);
    return this.active && details.resourceType !== 'webSocket' && !!url
      && !this.isControl(url) && this.origins.has(url.origin);
  }
  async permitsResolved(details, session) {
    if (this.permitsDevTools(details)) return true;
    if (!this.permits(details)) return false;
    const url = new URL(details.url);
    if (loopback(url.hostname)) return true;
    try {
      const result = await session.resolveHost(url.hostname, { cacheUsage: 'disallowed' });
      return this.active && Array.isArray(result.endpoints) && result.endpoints.length > 0
        && result.endpoints.every(endpoint => publicAddress(endpoint.address));
    } catch { return false; }
  }
  install(session) {
    // One webRequest listener per Session. A closed context keeps a deny-only
    // listener until Chromium releases the partition and its workers.
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, respond) => {
      void this.permitsResolved(details, session).then(allowed => respond({ cancel: !allowed }),
        () => respond({ cancel: true }));
    });
    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, respond) => {
      if (this.permitsDevTools(details)) { respond({}); return; }
      if (!this.permits(details)) { respond({ cancel: true }); return; }
      const headers = { ...details.responseHeaders };
      for (const name of Object.keys(headers))
        if (name.toLowerCase() === 'connection-allowlist') delete headers[name];
      headers['Connection-Allowlist'] = [CONNECTION_ALLOWLIST];
      if (['mainFrame', 'subFrame'].includes(details.resourceType)) {
        const key = Object.keys(headers).find(name => name.toLowerCase() === 'content-security-policy')
          ?? 'Content-Security-Policy';
        headers[key] = [...(headers[key] ?? []), REQUEST_CSP];
      }
      respond({ responseHeaders: headers });
    });
  }
  close() { this.active = false; this.origins.clear(); }
}

module.exports = { WorkspaceNetworkPolicy, loopback };
