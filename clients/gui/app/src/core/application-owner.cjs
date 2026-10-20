'use strict';
const { randomUUID } = require('node:crypto');
const { mkdirSync, realpathSync } = require('node:fs');
const { Socket } = require('node:net');
const { isAbsolute, resolve } = require('node:path');
const { isDeepStrictEqual } = require('node:util');

function parseOwner(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (value?.kind !== 'gui' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.appRunId)
    || typeof value.profile !== 'string' || !isAbsolute(value.profile) || resolve(value.profile) !== value.profile)
    throw Object.assign(new Error('GUI 应用归属无效'), { code: 'APPLICATION_OWNER_INVALID' });
  return { kind: 'gui', appRunId: value.appRunId, profile: value.profile };
}
function createOwner(profile) {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  return parseOwner({ kind: 'gui', appRunId: randomUUID(), profile: realpathSync(profile) });
}
const sameOwner = (left, right) => !!left && !!right && isDeepStrictEqual(left, right);
function scrubOwnerEnvironment(environment = process.env) {
  const env = { ...environment };
  delete env.AREAL_GUI_OWNER;
  delete env.AREAL_GUI_LIFETIME_FD;
  delete env.AREAL_GUI_DESKTOP_LIFETIME_FD;
  return env;
}
function watchApplicationLifetime(onEnd) {
  if (process.env.AREAL_GUI_DESKTOP_LIFETIME_FD !== '3') throw new Error('Desktop 必须由 GUI 应用生命期管道启动');
  const stream = new Socket({ fd: 3, readable: true, writable: false });
  let ended = false;
  const finish = () => { if (!ended) { ended = true; onEnd(); } };
  stream.once('data', finish);
  stream.once('end', finish); stream.once('error', finish);
  return stream;
}
module.exports = { parseOwner, createOwner, sameOwner, scrubOwnerEnvironment, watchApplicationLifetime };
