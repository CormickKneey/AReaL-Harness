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
    this.frameGrants = new Map();
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
  bindFrameGrant(grant) {
    if (!this.canAuthorize(grant.origin)) throw new Error('嵌入站点被网络策略拒绝');
    this.frameGrants.set(grant.contents.id, grant);
  }
  revokeFrameGrant(contentsId) { this.frameGrants.delete(contentsId); }
  frameGrant(details) {
    const grant = this.frameGrants.get(details.webContentsId);
    return grant && grant.valid() ? grant : null;
  }
  permitsFrame(grant, details, url) {
    // Origin 许可不能被父页面的图片、fetch 或其他页面借用。
    const c = grant.contents, frame = details.frame;
    if (details.resourceType === 'mainFrame')
      return grant.status === 'reloading' && url.href === grant.parentURL;
    if (!frame || frame.isDestroyed()) return false;
    if (url.origin === new URL(grant.parentURL).origin)
      return frame.origin === url.origin;
    if (url.origin !== grant.origin || frame.parent !== c.mainFrame
      || frame.parent.url !== grant.parentURL) return false;
    if (details.resourceType === 'subFrame') return true;
    return frame.origin === grant.origin
      && ['script', 'stylesheet', 'image', 'font', 'xhr', 'media'].includes(details.resourceType);
  }
  permits(details) {
    if (this.permitsDevTools(details)) return true;
    const url = httpUrl(details.url);
    if (!this.active || details.resourceType === 'webSocket' || !url || this.isControl(url)) return false;
    if (!this.frameGrants.has(details.webContentsId)) return this.origins.has(url.origin);
    // Chromium 可在回调期间销毁 Frame；无法读取身份时拒绝，不能从权限检查抛出。
    try {
      const grant = this.frameGrant(details);
      return !!grant && this.permitsFrame(grant, details, url);
    } catch { return false; }
  }
  async permitsResolved(details, session) {
    if (this.permitsDevTools(details)) return true;
    if (!this.permits(details)) return false;
    const url = new URL(details.url);
    if (loopback(url.hostname)) return this.permits(details);
    try {
      const result = await session.resolveHost(url.hostname, { cacheUsage: 'disallowed' });
      return this.permits(details) && Array.isArray(result.endpoints) && result.endpoints.length > 0
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
      const frameGrant = this.frameGrant(details);
      const frameParent = frameGrant && details.resourceType === 'mainFrame'
        && details.url === frameGrant.parentURL && frameGrant.status === 'reloading';
      const disposition = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-disposition')?.[1];
      const attachment = Array.isArray(disposition) && disposition.length === 1
        && typeof disposition[0] === 'string' && /^\s*attachment\s*(;|$)/i.test(disposition[0]);
      // 首次导航也不能覆盖站点策略；多条 Connection-Allowlist 不保证取交集。
      const siteConnectionPolicy = Object.keys(headers).find(name => name.toLowerCase() === 'connection-allowlist');
      if (siteConnectionPolicy && !attachment) { respond({ cancel: true }); return; }
      if (siteConnectionPolicy) delete headers[siteConnectionPolicy];
      // Connection-Allowlist protects a loaded document's future connections.
      // An attachment creates no document; applying it to that response crashes
      // Chromium's download path. The Session URL checks and parent policy remain.
      if (!attachment) headers['Connection-Allowlist'] = [frameParent
        ? `(response-origin ${JSON.stringify(frameGrant.origin + '/*')}); redirects=allow` : CONNECTION_ALLOWLIST];
      if (['mainFrame', 'subFrame'].includes(details.resourceType)) {
        const key = Object.keys(headers).find(name => name.toLowerCase() === 'content-security-policy')
          ?? 'Content-Security-Policy';
        headers[key] = [...(headers[key] ?? []), frameParent
          ? REQUEST_CSP.replace("frame-src 'self'", `frame-src 'self' ${frameGrant.origin}`) : REQUEST_CSP];
      }
      respond({ responseHeaders: headers });
    });
  }
  close() { this.active = false; this.origins.clear(); this.frameGrants.clear(); }
}

module.exports = { WorkspaceNetworkPolicy, loopback };
