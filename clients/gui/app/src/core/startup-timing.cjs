'use strict';
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { writeSync } = require('node:fs');

const runId = randomUUID();
let nextAttempt = 0;
const outcomes = new Set(['ok', 'error', 'degraded', 'skipped']);
const errorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'DISCONNECTED', 'SERVICE_STOPPING', 'SERVICE_INCOMPATIBLE', 'STARTUP_CANCELLED', -32700, -32600, -32601, -32602, -32603]);

function startupTrace(scope, context = {}) {
  const started = performance.now();
  const correlation = {};
  if (typeof context.projectId === 'string' && /^[a-f0-9]{24}$/.test(context.projectId)) correlation.projectId = context.projectId;
  for (const key of ['connectionGeneration', 'servicePid']) {
    if (Number.isSafeInteger(context[key]) && context[key] >= 0) correlation[key] = context[key];
  }
  if (typeof context.coreGeneration === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(context.coreGeneration)) correlation.coreGeneration = context.coreGeneration;
  const identity = { event: 'startup', pid: process.pid, runId, attempt: ++nextAttempt, scope, ...correlation };
  let stage, changed = started, finished = false;
  const milliseconds = value => Math.round(value * 1000) / 1000;
  function record(kind, outcome, nextStage, error) {
    if (finished) return;
    const now = performance.now();
    const previous = stage === undefined ? undefined : { stage, durationMs: milliseconds(now - changed), outcome };
    if (kind === 'finish') finished = true;
    else { stage = nextStage; changed = now; }
    try {
      const entry = { ...identity, at: new Date().toISOString(), kind, elapsedMs: milliseconds(now - started),
        ...(nextStage === undefined ? {} : { stage: nextStage }), ...(previous ? { previous } : {}),
        ...(kind === 'finish' ? { outcome } : {}) };
      if (errorCodes.has(error?.code)) entry.errorCode = error.code;
      writeSync(2, `[startup] ${JSON.stringify(entry)}\n`);
    } catch {}
  }
  return {
    advance(nextStage, previousOutcome = 'ok') { record('advance', outcomes.has(previousOutcome) ? previousOutcome : 'error', nextStage); },
    finish(outcome, error) { record('finish', outcomes.has(outcome) ? outcome : 'error', undefined, error); },
  };
}

module.exports = { startupTrace };
