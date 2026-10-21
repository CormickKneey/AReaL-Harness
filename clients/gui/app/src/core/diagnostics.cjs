'use strict';
const fs = require('node:fs');
const { join, dirname, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * @typedef {{boundary:'main-desktop'|'desktop-core',projectId?:string,coreGeneration?:string,connectionGeneration?:number,hostPid?:number,corePid?:number,serviceId?:string}} SocketTarget
 * @typedef {({type:'socket-open'} & SocketTarget) | ({type:'socket-error',code:unknown} & SocketTarget) | ({type:'socket-close',closeCode:unknown} & SocketTarget)
 * | {type:'desktop-spawn',pid:number} | {type:'desktop-exit',pid:number,exitCode:number|null,signal:string|null}
 * | {type:'desktop-spawn-error',code:unknown} | {type:'application-owner-lost'}
 * | {type:'renderer-gone',reason:unknown,exitCode:unknown} | {type:'renderer-unresponsive'|'renderer-responsive'}
 * | {type:'child-process-gone',processType:unknown,reason:unknown,exitCode:unknown}
 * | {type:'resource-sample',rssBytes:number,heapUsedBytes:number,uptimeSeconds:number,eventLoopDelayMs:number}
 * | {type:'uncaught-exception',errorName:unknown,code:unknown}
 * | {type:'desktop-exit-timeout',cause:'completed-lifecycle'|'external-quit'|'signal',stage:'disconnect'|'metadata'}
 * | {type:'exit-requested'|'process-exit',exitCode:number} | {type:'crash-reporter',state:'ready'|'unavailable'}} Incident
 */
const RUNS = 8, SHARDS = 4, SHARD_BYTES = 256 * 1024, LINE_BYTES = 1024, READ_BYTES = 16 * 1024 * 1024, SCAN_ENTRIES = 128;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z]+(?:\.\d{1,8})?)?$/;
const CODES = new Set(['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH', 'WS_ERR_INVALID_UTF8', 'WS_ERR_INVALID_CLOSE_CODE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENFILE']);
const REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);
const PROCESS_TYPES = new Set(['Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker', 'Browser', 'Tab', 'Network Service']);
const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGTRAP', 'SIGHUP']);
const ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);
const OWN_FILES = new Set(['run.json', 'exit.json', 'health.json', ...Array.from({ length: SHARDS }, (_, i) => `events-${i}.ndjson`)]);
const HEALTH_STATES = new Set(['recording', 'write-failed', 'initialization-failed', 'exited']);
let recorder, initialized = false;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
const numeric = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
const choose = (set, value, fallback = 'other') => set.has(value) ? value : fallback;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : undefined;
function alias(map, value, prefix) {
  if (typeof value !== 'string' || !value || value.length > 4096) return undefined;
  if (!map.has(value)) { if (map.size >= 256) return 'other'; map.set(value, `${prefix}${map.size + 1}`); }
  return map.get(value);
}
function projectIncident(event, maps) {
  if (!object(event)) return null;
  const value = { type: event.type };
  switch (event.type) {
    case 'socket-open': case 'socket-close': case 'socket-error':
      if (!['main-desktop', 'desktop-core'].includes(event.boundary)) return null;
      value.boundary = event.boundary;
      value.project = maps ? alias(maps.projects, event.projectId, 'p') : /^(?:p\d{1,3}|other)$/.test(event.project) ? event.project : undefined;
      value.coreGeneration = maps ? alias(maps.generations, event.coreGeneration, 'g') : /^(?:g\d{1,3}|other)$/.test(event.coreGeneration) ? event.coreGeneration : undefined;
      value.connectionGeneration = integer(event.connectionGeneration);
      value.hostPid = integer(event.hostPid, 2, 0x7fffffff); value.corePid = integer(event.corePid, 2, 0x7fffffff);
      value.serviceId = typeof event.serviceId === 'string' && /^[a-f0-9]{24}$/.test(event.serviceId) ? event.serviceId : undefined;
      if (event.type === 'socket-error') value.code = choose(CODES, event.code, 'OTHER');
      if (event.type === 'socket-close') value.closeCode = integer(event.closeCode, 0, 65535);
      break;
    case 'desktop-spawn': case 'desktop-exit':
      value.pid = integer(event.pid, 2, 0x7fffffff);
      if (event.type === 'desktop-exit') { value.exitCode = event.exitCode === null ? null : integer(event.exitCode, -0x80000000, 0x7fffffff); value.signal = event.signal === null ? null : choose(SIGNALS, event.signal); }
      break;
    case 'desktop-spawn-error': value.code = choose(CODES, event.code, 'OTHER'); break;
    case 'renderer-gone': case 'child-process-gone':
      value.reason = choose(REASONS, event.reason); value.exitCode = integer(event.exitCode, -0x80000000, 0x7fffffff);
      if (event.type === 'child-process-gone') value.processType = choose(PROCESS_TYPES, event.processType);
      break;
    case 'resource-sample':
      for (const key of ['rssBytes', 'heapUsedBytes']) value[key] = integer(event[key], 0, 2 ** 50);
      value.uptimeSeconds = numeric(event.uptimeSeconds); value.eventLoopDelayMs = numeric(event.eventLoopDelayMs);
      break;
    case 'uncaught-exception': value.errorName = choose(ERRORS, event.errorName); value.code = choose(CODES, event.code, 'OTHER'); break;
    case 'process-exit': case 'exit-requested': value.exitCode = integer(event.exitCode, -0x80000000, 0x7fffffff); break;
    case 'desktop-exit-timeout':
      value.cause = choose(new Set(['completed-lifecycle', 'external-quit', 'signal']), event.cause);
      value.stage = choose(new Set(['disconnect', 'metadata']), event.stage);
      break;
    case 'crash-reporter': value.state = event.state === 'ready' ? 'ready' : 'unavailable'; break;
    case 'application-owner-lost': case 'renderer-unresponsive': case 'renderer-responsive': break;
    default: return null;
  }
  return value;
}
function projectHeader(value, runId, role) {
  if (!object(value) || value.schemaVersion !== 1 || value.runId !== runId || value.role !== role || !integer(value.pid, 2, 0x7fffffff) || !timestamp(value.startedAt)) return null;
  return { schemaVersion: 1, runId, role, pid: value.pid, startedAt: value.startedAt,
    appRunId: typeof value.appRunId === 'string' && UUID.test(value.appRunId) ? value.appRunId : undefined,
    appVersion: typeof value.appVersion === 'string' && VERSION.test(value.appVersion) ? value.appVersion : 'unknown',
    platform: choose(new Set(['darwin', 'win32', 'linux']), value.platform), arch: choose(new Set(['arm64', 'x64', 'ia32']), value.arch),
    electron: typeof value.electron === 'string' && VERSION.test(value.electron) ? value.electron : undefined,
    node: typeof value.node === 'string' && VERSION.test(value.node) ? value.node : undefined };
}
function projectHealth(value) {
  if (!object(value) || !HEALTH_STATES.has(value.state)) return { state: 'unavailable' };
  return { state: value.state, code: value.code === undefined ? undefined : choose(CODES, value.code, 'OTHER'),
    suppressedEvents: integer(value.suppressedEvents), invalidEvents: integer(value.invalidEvents), rotations: integer(value.rotations), writeFailures: integer(value.writeFailures) };
}
function directory(path, create = false) {
  if (create) {
    for (const candidate of [dirname(path), path]) {
      try { if (fs.lstatSync(candidate).isSymbolicLink()) throw Object.assign(new Error('Unsafe diagnostics directory'), { code: 'EACCES' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const candidate of [dirname(path), path]) { const status = fs.lstatSync(candidate); if (status.isSymbolicLink() || !status.isDirectory()) throw Object.assign(new Error('Unsafe diagnostics directory'), { code: 'EACCES' }); }
}
function entries(path) {
  directory(path);
  const handle = fs.opendirSync(path), result = [];
  try {
    for (let i = 0; i <= SCAN_ENTRIES; i++) {
      const entry = handle.readSync(); if (!entry) return result;
      if (i === SCAN_ENTRIES) throw Object.assign(new Error('Diagnostics scan limit'), { code: 'SCAN_LIMIT' });
      result.push(entry);
    }
  } finally { handle.closeSync(); }
}
function writeSmall(path, value) {
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { if (!fs.fstatSync(fd).isFile()) throw new Error('Not a file'); fs.writeFileSync(fd, JSON.stringify(value)); }
  finally { fs.closeSync(fd); }
}
function saveHealth() {
  if (!recorder?.path) return;
  try { writeSmall(join(recorder.path, 'health.json'), projectHealth(recorder.health)); }
  catch (error) {
    recorder.health.state = 'write-failed'; recorder.health.code = choose(CODES, error?.code, 'OTHER'); recorder.health.writeFailures++;
    if (recorder.fd !== undefined) { try { fs.closeSync(recorder.fd); } catch {} recorder.fd = undefined; }
  }
}
function failed(error) {
  recorder.health.state = 'write-failed'; recorder.health.code = choose(CODES, error?.code, 'OTHER'); recorder.health.writeFailures++;
  if (recorder.fd !== undefined) { try { fs.closeSync(recorder.fd); } catch {} recorder.fd = undefined; }
  saveHealth();
}
/** @param {Incident} event */
function record(event) {
  if (!recorder || recorder.health.state !== 'recording') return;
  try {
    const value = projectIncident(event, recorder.maps);
    if (!value) { recorder.health.invalidEvents++; return; }
    const now = Date.now(), key = JSON.stringify(value);
    if (recorder.recent.has(key) && now - recorder.recent.get(key) < 1000) { recorder.health.suppressedEvents++; return; }
    if (recorder.recent.size >= 128) recorder.recent.clear();
    recorder.recent.set(key, now);
    const line = JSON.stringify({ schemaVersion: 1, runId: recorder.header.runId, seq: ++recorder.seq,
      at: new Date(now).toISOString(), uptimeMilliseconds: Math.floor(process.uptime() * 1000), ...value }) + '\n';
    const length = Buffer.byteLength(line);
    if (length > LINE_BYTES) { recorder.health.invalidEvents++; return; }
    if (recorder.bytes + length > SHARD_BYTES) {
      fs.closeSync(recorder.fd); recorder.fd = undefined; recorder.shard = (recorder.shard + 1) % SHARDS;
      recorder.fd = fs.openSync(join(recorder.path, `events-${recorder.shard}.ndjson`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      if (!fs.fstatSync(recorder.fd).isFile()) throw new Error('Not a file');
      recorder.bytes = 0; recorder.health.rotations++; saveHealth();
      if (recorder.health.state !== 'recording') return;
    }
    const buffer = Buffer.from(line);
    let offset = 0;
    while (offset < buffer.length) { const written = fs.writeSync(recorder.fd, buffer, offset, buffer.length - offset); if (!written) throw new Error('Short write'); offset += written; }
    recorder.bytes += length;
  } catch (error) { failed(error); }
}
function start({ role, root, appRunId, version }) {
  if (initialized) return; initialized = true;
  recorder = { health: { state: 'recording', suppressedEvents: 0, invalidEvents: 0, rotations: 0, writeFailures: 0 }, maps: { projects: new Map(), generations: new Map() }, recent: new Map(), seq: 0, shard: 0, bytes: 0, root: resolve(root) };
  try {
    if (!['main', 'desktop'].includes(role)) throw new Error('Invalid role');
    directory(root, true);
    const runs = entries(root).filter(entry => UUID.test(entry.name));
    const owned = runs.map(entry => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe run');
      const path = join(root, entry.name); return { path, modified: fs.lstatSync(path).mtimeMs };
    }).sort((a, b) => a.modified - b.modified);
    for (const run of owned.slice(0, Math.max(0, owned.length - RUNS + 1))) {
      const files = entries(run.path);
      if (files.some(file => !OWN_FILES.has(file.name) || !file.isFile() || file.isSymbolicLink())) throw new Error('Unsafe run contents');
      for (const file of files) fs.unlinkSync(join(run.path, file.name));
      fs.rmdirSync(run.path);
    }
    const runId = randomUUID(); recorder.path = join(root, runId); fs.mkdirSync(recorder.path, { mode: 0o700 });
    recorder.header = projectHeader({ schemaVersion: 1, runId, role, pid: process.pid, appRunId, appVersion: version,
      platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, startedAt: new Date().toISOString() }, runId, role);
    writeSmall(join(recorder.path, 'run.json'), recorder.header);
    recorder.fd = fs.openSync(join(recorder.path, 'events-0.ndjson'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    saveHealth();
  } catch (error) { failed(error); recorder.health.state = 'initialization-failed'; saveHealth(); }
  process.on('uncaughtExceptionMonitor', error => record({ type: 'uncaught-exception', errorName: error?.name, code: error?.code }));
  process.once('exit', exitCode => {
    record({ type: 'process-exit', exitCode });
    if (recorder.health.state !== 'recording') return;
    try { writeSmall(join(recorder.path, 'exit.json'), { exitCode, at: new Date().toISOString() }); recorder.health.state = 'exited'; saveHealth(); fs.closeSync(recorder.fd); recorder.fd = undefined; }
    catch (error) { failed(error); }
  });
  let previous = performance.now();
  const sample = () => {
    const now = performance.now(), memory = process.memoryUsage();
    record({ type: 'resource-sample', rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, uptimeSeconds: process.uptime(), eventLoopDelayMs: Math.max(0, now - previous - 60000) });
    previous = now; saveHealth();
  };
  sample();
  const timer = setInterval(sample, 60000); timer.unref();
}
function startCrashReporter({ app, crashReporter }) {
  try {
    if (!recorder) return;
    const path = `${recorder.root}-crashes`; directory(path, true); app.setPath('crashDumps', path);
    crashReporter.start({ uploadToServer: false, compress: true });
    record({ type: 'crash-reporter', state: 'ready' });
  } catch { record({ type: 'crash-reporter', state: 'unavailable' }); }
}
async function exportTo(destination, { mainRoot, desktopRoot }) {
  const omissions = { rejectedEntries: 0, invalidLines: 0, missingFiles: 0, truncatedFiles: 0, scanLimit: 0, readFailures: 0 };
  let remaining = READ_BYTES;
  async function read(path, limit, optional = false) {
    let file;
    try {
      directory(dirname(path));
      file = await fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const status = await file.stat(); if (!status.isFile()) { omissions.rejectedEntries++; return null; }
      const size = Math.min(status.size, limit, remaining);
      if (size < status.size) omissions.truncatedFiles++;
      const buffer = Buffer.alloc(size); let offset = 0;
      while (offset < size) { const result = await file.read(buffer, offset, size - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; remaining -= result.bytesRead; }
      return buffer.subarray(0, offset).toString('utf8');
    } catch (error) {
      if (error.code === 'ENOENT') { if (!optional) omissions.missingFiles++; }
      else if (['ELOOP', 'EACCES'].includes(error.code)) omissions.rejectedEntries++;
      else omissions.readFailures++;
      return null;
    } finally { await file?.close().catch(() => {}); }
  }
  async function json(path, optional) {
    const raw = await read(path, 2048, optional); if (raw === null) return null;
    try { return JSON.parse(raw); } catch { omissions.invalidLines++; return null; }
  }
  function list(root) {
    try { return entries(root); }
    catch (error) { if (error.code === 'SCAN_LIMIT') omissions.scanLimit++; else if (error.code !== 'ENOENT') omissions.readFailures++; else omissions.missingFiles++; return []; }
  }
  function dumps(root) {
    let count = 0, scanned = 0, truncated = false, available = false;
    for (const suffix of ['', 'pending', 'completed', 'reports']) {
      const path = join(`${root}-crashes`, suffix); let handle;
      try {
        directory(path); available = true; handle = fs.opendirSync(path);
        for (;;) { const entry = handle.readSync(); if (!entry) break; if (++scanned > 64) { truncated = true; break; } if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.dmp')) count++; }
      } catch (error) { if (error.code !== 'ENOENT') omissions.readFailures++; }
      finally { handle?.closeSync(); }
      if (truncated) break;
    }
    return { available, count, truncated, dumpContentsIncluded: false };
  }
  const runs = [], crashDumps = [];
  for (const [role, root] of [['main', mainRoot], ['desktop', desktopRoot]]) {
    crashDumps.push({ role, ...dumps(root) });
    const candidates = list(root).filter(entry => {
      if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) { omissions.rejectedEntries++; return false; } return true;
    });
    if (candidates.length > RUNS) omissions.truncatedFiles++;
    for (const entry of candidates.slice(0, RUNS)) {
      const path = join(root, entry.name), header = projectHeader(await json(join(path, 'run.json')), entry.name, role);
      if (!header) { omissions.rejectedEntries++; continue; }
      const events = [];
      for (let shard = 0; shard < SHARDS; shard++) {
        const raw = await read(join(path, `events-${shard}.ndjson`), SHARD_BYTES, true); if (raw === null) continue;
        const lines = raw.split('\n'); const partial = lines.pop(); if (partial) omissions.invalidLines++;
        for (const line of lines) {
          if (!line || Buffer.byteLength(line) > LINE_BYTES) { omissions.invalidLines++; continue; }
          try {
            const source = JSON.parse(line), value = projectIncident(source);
            if (!value || source.schemaVersion !== 1 || source.runId !== header.runId || integer(source.seq, 1) === undefined || !timestamp(source.at) || numeric(source.uptimeMilliseconds) === undefined) { omissions.invalidLines++; continue; }
            events.push({ schemaVersion: 1, runId: header.runId, seq: source.seq, at: source.at, uptimeMilliseconds: source.uptimeMilliseconds, ...value });
          } catch { omissions.invalidLines++; }
        }
      }
      events.sort((a, b) => a.seq - b.seq);
      const exit = await json(join(path, 'exit.json'), true);
      const observedExit = object(exit) && integer(exit.exitCode, -0x80000000, 0x7fffffff) !== undefined && timestamp(exit.at) ? { exitCode: exit.exitCode, at: exit.at } : null;
      const current = recorder?.header?.runId === header.runId;
      const health = current ? projectHealth(recorder.health) : projectHealth(await json(join(path, 'health.json')));
      runs.push({ header, status: current ? 'current-run' : observedExit ? 'exit-observed' : 'termination-unconfirmed', exit: observedExit, health, events });
    }
  }
  const currentRecorder = recorder ? { role: recorder.header?.role, ...projectHealth(recorder.health) } : { state: 'unavailable' };
  const incomplete = Object.values(omissions).some(value => value > 0) || runs.some(run => !['recording', 'exited'].includes(run.health.state)) || !['recording', 'exited'].includes(currentRecorder.state);
  const report = { format: 'areal-harness-diagnostics-v1', exportedAt: new Date().toISOString(), incomplete, omissions, currentRecorder,
    bytesRead: READ_BYTES - remaining, limits: { runsPerRole: RUNS, shardsPerRun: SHARDS, shardBytes: SHARD_BYTES, readBytes: READ_BYTES },
    dumpContentsIncluded: false, crashDumps, runs };
  const temporary = join(dirname(destination), `.areal-diagnostics-${randomUUID()}.tmp`);
  let output;
  try { output = await fs.promises.open(temporary, 'wx', 0o600); await output.writeFile(JSON.stringify(report)); await output.close(); output = undefined; await fs.promises.rename(temporary, destination); }
  finally { await output?.close().catch(() => {}); await fs.promises.unlink(temporary).catch(() => {}); }
}
module.exports = { start, record, startCrashReporter, exportTo };
