import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, readFile, readdir, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { request } from 'node:http';

const cli = resolve('src/cli.mjs');
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'areal-relay-'));
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ publicOrigin: origin, listen: `127.0.0.1:${port}`, development: true, allowedClientOrigins: [origin], dataDir: join(dir, 'data'), ...overrides }));
  let child;
  let logs = '';
  const f = { dir, config, origin, logs: () => logs,
    admin: (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--config', config], { encoding: 'utf8' })),
    async start() {
      child = spawn(process.execPath, [cli, 'serve', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`server exited ${logs}`);
        try { if ((await fetch(`${origin}/healthz`)).ok) return; } catch {}
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error('server startup timeout');
    },
    async stop() { if (!child || child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); },
    async crash() { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); child = undefined; },
    enroll: code => fetch(`${origin}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }),
  };
  t.after(async () => { await f.stop(); await rm(dir, { recursive: true, force: true }); });
  return f;
}

test('local enrollment code is single-use and registration survives restart', async t => {
  const f = await fixture(t);
  const issued = f.admin('enrollment');
  assert.match(issued.code, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(issued.expiresAt > Date.now() && issued.expiresAt <= Date.now() + 600000);
  await f.start();
  const response = await f.enroll(issued.code); assert.equal(response.status, 201);
  const registration = await response.json();
  assert.match(registration.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.match(registration.room, /^[a-f0-9]{64}$/);
  assert.equal((await f.enroll(issued.code)).status, 403);
  await f.stop(); await f.start();
  assert.equal((await f.enroll(issued.code)).status, 403);
});

async function socket(f, registration, role = 'host') {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/remote/socket', role === 'client' ? { origin: f.origin } : {});
  const events = []; const waiters = [];
  ws.on('message', data => { const event = JSON.parse(data.toString()); const waiter = waiters.shift(); if (waiter) waiter(event); else events.push(event); });
  ws.on('error', () => {});
  const next = () => events.length ? Promise.resolve(events.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 1500);
    waiters.push(event => { clearTimeout(timer); resolve(event); });
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ protocol: 'areal.relay.v1', role, room: registration.room, ...(role === 'host' ? { capability: registration.capability } : {}) }));
  return { ws, next, send: value => ws.send(JSON.stringify(value)) };
}
async function enrolled(f) { const { code } = f.admin('enrollment'); return (await f.enroll(code)).json(); }

test('opaque channels enforce room ownership and valid Host replacement invalidates old channels', async t => {
  const f = await fixture(t); await f.start();
  const a = await enrolled(f); const b = await enrolled(f);
  const host = await socket(f, a); assert.deepEqual(await host.next(), { type: 'ready', limits: { framesPerSecond: 80, bytesPerSecond: 2097152, maxFrameBytes: 524288, heartbeatIntervalMs: 15000 } });
  const other = await socket(f, b); assert.equal((await other.next()).type, 'ready');
  const client = await socket(f, a, 'client'); const ready = await client.next(); const opened = await host.next();
  assert.equal(ready.type, 'ready'); assert.equal(opened.channel, ready.channel);
  client.send({ type: 'data', channel: ready.channel, data: Buffer.from('opaque-marker').toString('base64') });
  assert.deepEqual(await host.next(), { type: 'data', channel: ready.channel, data: 'b3BhcXVlLW1hcmtlcg==' });
  other.send({ type: 'data', channel: ready.channel, data: 'Zm9yZ2Vk' }); assert.equal((await other.next()).type, 'error');
  const forged = await socket(f, { room: a.room, capability: b.capability }); assert.equal((await forged.next()).type, 'error');
  const replacement = await socket(f, a); assert.equal((await replacement.next()).type, 'ready');
  assert.equal((await client.next()).type, 'close');
  const fresh = await socket(f, a, 'client'); const ready2 = await fresh.next(); assert.notEqual(ready2.channel, ready.channel); await replacement.next();
  replacement.send({ type: 'data', channel: ready.channel, data: 'c3RhbGU=' }); assert.equal((await replacement.next()).type, 'error');
});

test('unknown and offline rooms are indistinguishable; no traffic survives server restart', async t => {
  const f = await fixture(t); await f.start(); const a = await enrolled(f);
  const offline = await socket(f, a, 'client'); const unknown = await socket(f, { room: 'a'.repeat(64) }, 'client');
  assert.deepEqual(await offline.next(), await unknown.next());
  const host = await socket(f, a); await host.next(); const client = await socket(f, a, 'client'); const ready = await client.next(); await host.next();
  client.send({ type: 'data', channel: ready.channel, data: 'bm90LXF1ZXVlZA==' }); await host.next();
  await f.stop(); await f.start();
  const restored = await socket(f, a); assert.equal((await restored.next()).type, 'ready');
  const current = await socket(f, a, 'client'); await current.next(); assert.equal((await restored.next()).type, 'open');
});

async function rawSocket(f, options = {}) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/remote/socket', options);
  ws.on('error', () => {});
  return ws;
}
function closed(ws, timeout = 2000) {
  if (ws.readyState === 3) return Promise.resolve();
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('close timeout')), timeout); ws.once('close', () => { clearTimeout(timer); resolve(); }); });
}
function opened(ws) { return new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('pre-registration capacity and timeout bound anonymous sockets and recover capacity', async t => {
  const f = await fixture(t, { maxPending: 2, handshakeTimeoutMs: 150 }); await f.start();
  const first = await rawSocket(f); await opened(first); const second = await rawSocket(f); await opened(second);
  const excess = await rawSocket(f); await closed(excess);
  await Promise.all([closed(first), closed(second)]);
  const next = await rawSocket(f); await opened(next); next.terminate();
});

test('Origins and exact Host are checked before registration; forwarded headers cannot bypass', async t => {
  const f = await fixture(t); await f.start(); const a = await enrolled(f);
  const hostile = await rawSocket(f, { origin: 'https://evil.example' }); await closed(hostile);
  const wrongHost = await rawSocket(f, { headers: { host: 'evil.example', 'x-forwarded-host': new URL(f.origin).host, 'x-forwarded-proto': 'https' } }); await closed(wrongHost);
  const browserHost = await socket(f, a, 'client'); await browserHost.next();
  const ws = await rawSocket(f, { origin: f.origin }); await opened(ws);
  ws.send(JSON.stringify({ protocol: 'areal.relay.v1', role: 'host', ...a })); await closed(ws);
  const missingOrigin = await rawSocket(f); await opened(missingOrigin);
  missingOrigin.send(JSON.stringify({ protocol: 'areal.relay.v1', role: 'client', room: a.room })); await closed(missingOrigin);
  assert.equal(await new Promise((resolve, reject) => { const req = request(`${f.origin}/healthz`, { headers: { host: 'evil.example', 'x-forwarded-host': new URL(f.origin).host } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }), 421);
  assert.equal((await fetch(`${f.origin}/enroll`, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: '{}' })).status, 403);
});

test('client cannot address another client channel and oversized or malformed data is rejected', async t => {
  const f = await fixture(t); await f.start(); const a = await enrolled(f);
  const host = await socket(f, a); await host.next();
  const c1 = await socket(f, a, 'client'); const r1 = await c1.next(); await host.next();
  const c2 = await socket(f, a, 'client'); const r2 = await c2.next(); await host.next();
  c1.send({ type: 'data', channel: r2.channel, data: 'eA==' }); assert.equal((await c1.next()).type, 'error'); assert.equal((await host.next()).type, 'close');
  c2.send({ type: 'data', channel: r2.channel, data: 'bad base64' }); assert.equal((await c2.next()).type, 'error'); await host.next();
  const big = await socket(f, a, 'client'); const rb = await big.next(); await host.next();
  big.send({ type: 'data', channel: rb.channel, data: 'A'.repeat(524288) }); await closed(big.ws); await host.next();
  const valid = await socket(f, a, 'client'); const rv = await valid.next(); await host.next();
  const payload = 'A'.repeat(520000);
  valid.send({ type: 'data', channel: rv.channel, data: payload }); assert.equal((await host.next()).data.length, payload.length);
  assert.equal((await fetch(`${f.origin}/healthz`)).status, 200);
});

test('registration caps, frame rates and byte budgets apply before Noise authentication', async t => {
  const f = await fixture(t, { maxHosts: 1, maxChannelsPerHost: 2, framesPerSecond: 4, bytesPerSecond: 1024 }); await f.start();
  const a = await enrolled(f); const b = await enrolled(f);
  const host = await socket(f, a); await host.next(); const other = await socket(f, b); assert.equal((await other.next()).code, 'CAPACITY_EXCEEDED');
  const c1 = await socket(f, a, 'client'); const r1 = await c1.next(); await host.next();
  const c2 = await socket(f, a, 'client'); const r2 = await c2.next(); await host.next();
  const c3 = await socket(f, a, 'client'); assert.equal((await c3.next()).code, 'CAPACITY_EXCEEDED');
  for (let i = 0; i < 5; i++) c1.send({ type: 'data', channel: r1.channel, data: 'eA==' });
  assert.equal((await c1.next()).code, 'LIMIT_EXCEEDED');
  c2.send({ type: 'data', channel: r2.channel, data: 'A'.repeat(1000) }); assert.equal((await c2.next()).code, 'LIMIT_EXCEEDED');
});

test('metadata/logs exclude enrollment codes, capabilities, and opaque payloads; revoke and restore disable routing', async t => {
  const f = await fixture(t); await f.start(); const { code } = f.admin('enrollment'); const a = await (await f.enroll(code)).json();
  const host = await socket(f, a); await host.next(); const c = await socket(f, a, 'client'); const ready = await c.next(); await host.next();
  const marker = 'secret-payload-no-log-71eb572c'; const encoded = Buffer.from(marker).toString('base64');
  c.send({ type: 'data', channel: ready.channel, data: encoded }); await host.next();
  const backup = join(f.dir, 'backup.sqlite'); assert.deepEqual(f.admin('backup', backup), { backedUp: true });
  assert.throws(() => f.admin('restore', backup), 'running service must exclude restore');
  assert.deepEqual(f.admin('revoke', a.room), { revoked: true });
  await closed(host.ws); await closed(c.ws);
  const revoked = await socket(f, a); assert.equal((await revoked.next()).code, 'UNAVAILABLE');
  await f.stop();
  assert.deepEqual(f.admin('restore', backup), { restored: true, registrationsDisabled: true });
  await f.start(); const restored = await socket(f, a); assert.equal((await restored.next()).code, 'UNAVAILABLE'); await f.stop();
  const buffers = [Buffer.from(f.logs()), await readFile(backup)];
  for (const file of await readdir(join(f.dir, 'data'))) buffers.push(await readFile(join(f.dir, 'data', file)));
  for (const buffer of buffers) for (const forbidden of [code, a.capability, marker, encoded]) assert.equal(buffer.includes(forbidden), false);
});

test('expired enrollment and invalid codes have the same denial; HTTP body/rate budgets apply', async t => {
  const f = await fixture(t, { enrollPerSecond: 3 });
  const preload = join(f.dir, 'past.mjs'); await writeFile(preload, 'const now = Date.now; Date.now = () => now() - 600001;');
  const { code } = JSON.parse(execFileSync(process.execPath, ['--import', preload, cli, 'enrollment', '--config', f.config], { encoding: 'utf8' }));
  await f.start();
  const expired = await f.enroll(code); const invalid = await f.enroll('a'.repeat(43)); assert.equal(expired.status, 403); assert.deepEqual(await expired.json(), await invalid.json());
  const oversized = await fetch(`${f.origin}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'A'.repeat(2048) }); assert.equal(oversized.status, 413);
  assert.equal((await f.enroll('a'.repeat(43))).status, 429);
});

test('fragment floods are rejected before a complete registration message exists', async t => {
  const f = await fixture(t); await f.start(); const ws = await rawSocket(f); await opened(ws);
  for (let i = 0; i < 129; i++) ws.send('a', { fin: false });
  await closed(ws);
  assert.equal((await fetch(`${f.origin}/healthz`)).status, 200);
});

test('a socket that stops reading is disconnected without blocking a healthy channel', { timeout: 30000 }, async t => {
  const f = await fixture(t, { maxBufferedBytesPerChannel: 65536 }); await f.start(); const a = await enrolled(f);
  const host = await socket(f, a); await host.next();
  const slow = await socket(f, a, 'client'); const sr = await slow.next(); await host.next();
  const healthy = await socket(f, a, 'client'); const hr = await healthy.next(); await host.next();
  // 实际暂停 TCP 读取，迫使服务端面对真实内核发送窗口和 ws 发送积压。
  slow.ws._socket.pause(); t.after(() => { slow.ws._socket.resume(); slow.ws.terminate(); });
  let dropped = false;
  host.ws.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'close' && message.channel === sr.channel) dropped = true; });
  for (let round = 0; round < 18 && !dropped; round++) {
    for (let i = 0; i < 32 && !dropped; i++) { host.send({ type: 'data', channel: sr.channel, data: 'A'.repeat(32000) }); await delay(2); }
    host.send({ type: 'data', channel: hr.channel, data: 'aGVhbHRoeQ==' }); assert.equal((await healthy.next()).data, 'aGVhbHRoeQ==');
    await delay(1050);
  }
  assert.equal(dropped, true, 'slow consumer must exhaust its bounded outgoing queue');
  host.send({ type: 'data', channel: hr.channel, data: 'c3RpbGwtb25saW5l' }); assert.equal((await healthy.next()).data, 'c3RpbGwtb25saW5l');
});

test('static files stay within explicit assets and carry restrictive web headers', async t => {
  const assets = await mkdtemp(join(tmpdir(), 'relay-assets-')); t.after(() => rm(assets, { recursive: true, force: true }));
  await writeFile(join(assets, 'remote.html'), '<!doctype html><title>Relay shell fixture</title>');
  await writeFile(join(assets, '.private.json'), '{"secret":true}'); await symlink('/etc/hosts', join(assets, 'escape.js'));
  const f = await fixture(t, { assetsDir: assets }); await f.start();
  const res = await fetch(f.origin); assert.equal(res.status, 200); assert.match(await res.text(), /shell fixture/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self';/);
  assert.match(res.headers.get('content-security-policy'), /connect-src 'self';/);
  for (const path of ['/escape.js', '/.private.json', '/%2e%2e/etc/hosts', '/remote.html?invite=secret']) assert.equal((await fetch(f.origin + path)).status, 404);
});

test('production requires an explicit trusted local TLS proxy and rejects unsafe listeners', async t => {
  const f = await fixture(t);
  const base = JSON.parse(await readFile(f.config));
  for (const change of [{ development: false }, { listen: '0.0.0.0:8080' }, { publicOrigin: 'http://example.org' }, { publicOrigin: 'https://relay.example', development: false, trustedLocalTlsProxy: false }, { framesPerSecond: 81 }]) {
    await writeFile(f.config, JSON.stringify({ ...base, ...change }));
    assert.throws(() => f.admin('enrollment'));
  }
  await writeFile(f.config, JSON.stringify({ ...base, publicOrigin: 'https://relay.example', development: false, trustedLocalTlsProxy: true, allowedClientOrigins: ['https://relay.example'] }));
  assert.match(f.admin('enrollment').code, /^[A-Za-z0-9_-]{43}$/);
});

test('Host close acknowledgements and already in-flight data for a closed channel cannot disconnect other devices', async t => {
  const f = await fixture(t); await f.start(); const a = await enrolled(f); const host = await socket(f, a); await host.next();
  const first = await socket(f, a, 'client'); const r1 = await first.next(); await host.next();
  const second = await socket(f, a, 'client'); const r2 = await second.next(); await host.next();
  first.ws.close(); assert.deepEqual(await host.next(), { type: 'close', channel: r1.channel });
  host.send({ type: 'close', channel: r1.channel }); assert.equal((await host.next()).type, 'error');
  host.send({ type: 'data', channel: r1.channel, data: 'bGF0ZQ==' }); assert.equal((await host.next()).type, 'error');
  host.send({ type: 'data', channel: r2.channel, data: 'c3RpbGwtb25saW5l' }); assert.equal((await second.next()).data, 'c3RpbGwtb25saW5l');
});

for (const fault of ['rename failure', 'process kill']) {
  test(`interrupted restore (${fault}) never resurrects revocations or consumed enrollment codes committed in WAL`, async t => {
    const f = await fixture(t); await f.start(); const registration = await enrolled(f);
    const { code } = f.admin('enrollment');
    await f.stop();
    const backup = join(f.dir, 'backup.sqlite'); f.admin('backup', backup);
    await f.start();
    f.admin('revoke', registration.room);
    assert.equal((await f.enroll(code)).status, 201);
    const host = await socket(f, registration); assert.equal((await host.next()).code, 'UNAVAILABLE');
    assert.equal((await f.enroll(code)).status, 403);
    await f.crash();
    const dataDir = join(f.dir, 'data');
    assert.ok((await readFile(join(dataDir, 'relay.sqlite-wal'))).length > 32, 'crash leaves committed WAL');
    // 单独复制主库只用于确认故障前提：最新撤销和消费仍只存在 WAL 中。
    const mainCopy = join(f.dir, 'main-only.sqlite'); await writeFile(mainCopy, await readFile(join(dataDir, 'relay.sqlite')));
    const snapshot = new DatabaseSync(mainCopy);
    try {
      assert.equal(snapshot.prepare('SELECT active FROM rooms WHERE room=?').get(registration.room).active, 1);
      assert.equal(snapshot.prepare('SELECT consumed FROM enrollments WHERE hash=?').get(createHash('sha256').update(code).digest('hex')).consumed, 0);
    } finally { snapshot.close(); }
    await rm(join(dataDir, 'server.lock'));
    const preload = join(f.dir, 'interrupt-restore.mjs');
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';\nconst rename = fs.renameSync;\nfs.renameSync = (source, target) => { if (target === ${JSON.stringify(join(dataDir, 'relay.sqlite'))}) { ${fault === 'process kill' ? "process.kill(process.pid, 'SIGKILL');" : "throw new Error('INJECTED_RENAME_FAILURE');"} } return rename(source, target); };\nsyncBuiltinESMExports();\n`);
    const result = spawnSync(process.execPath, ['--import', preload, cli, 'restore', backup, '--config', f.config], { encoding: 'utf8', timeout: 5000 });
    if (fault === 'process kill') assert.equal(result.signal, 'SIGKILL');
    else { assert.equal(result.status, 1); assert.match(result.stderr, /INJECTED_RENAME_FAILURE/); }
    // 已等待进程退出；模拟文档中允许的残留锁清理，不能隐含修复数据库。
    for (const file of ['server.lock', 'admin.lock']) await rm(join(dataDir, file), { force: true });
    await f.start();
    const revoked = await socket(f, registration); assert.deepEqual(await revoked.next(), { type: 'error', code: 'UNAVAILABLE' });
    assert.equal((await f.enroll(code)).status, 403);
    await f.stop();
    for (const file of ['restore.sqlite', 'restore.sqlite-wal', 'restore.sqlite-shm']) await rm(join(dataDir, file), { force: true });
    assert.deepEqual(f.admin('restore', backup), { restored: true, registrationsDisabled: true });
    await f.start();
    const restored = await socket(f, registration); assert.equal((await restored.next()).code, 'UNAVAILABLE');
    assert.equal((await f.enroll(code)).status, 403);
    const fresh = await enrolled(f); const newHost = await socket(f, fresh); assert.equal((await newHost.next()).type, 'ready');
    await f.stop(); await f.start();
    const resumed = await socket(f, fresh); assert.equal((await resumed.next()).type, 'ready');
  });
}

test('busy restore checkpoint refuses replacement and preserves committed revocations', async t => {
  const f = await fixture(t); await f.start(); const registration = await enrolled(f); await f.stop();
  const backup = join(f.dir, 'backup.sqlite'); f.admin('backup', backup); await f.start();
  const reader = new DatabaseSync(join(f.dir, 'data', 'relay.sqlite'), { readOnly: true });
  let readerOpen = true; t.after(() => { if (readerOpen) reader.close(); });
  reader.exec('BEGIN'); reader.prepare('SELECT active FROM rooms WHERE room=?').get(registration.room);
  f.admin('revoke', registration.room); await f.crash(); await rm(join(f.dir, 'data', 'server.lock'));
  const result = spawnSync(process.execPath, [cli, 'restore', backup, '--config', f.config], { encoding: 'utf8', timeout: 6000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /CHECKPOINT_INCOMPLETE/);
  reader.exec('ROLLBACK'); reader.close(); readerOpen = false;
  await f.start(); const revoked = await socket(f, registration); assert.deepEqual(await revoked.next(), { type: 'error', code: 'UNAVAILABLE' });
});

test('restore into a fresh directory disables old Host registrations and unused enrollment codes', async t => {
  const source = await fixture(t); await source.start(); const registration = await enrolled(source); const { code } = source.admin('enrollment');
  const backup = join(source.dir, 'backup.sqlite'); source.admin('backup', backup); await source.stop();
  const target = await fixture(t); assert.deepEqual(target.admin('restore', backup), { restored: true, registrationsDisabled: true });
  await target.start(); const restored = await socket(target, registration); assert.deepEqual(await restored.next(), { type: 'error', code: 'UNAVAILABLE' });
  assert.equal((await target.enroll(code)).status, 403);
  const fresh = await enrolled(target); const host = await socket(target, fresh); assert.equal((await host.next()).type, 'ready');
});
