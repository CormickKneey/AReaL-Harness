'use strict';
const VERSION = 1;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const sequence = value => Number.isSafeInteger(value) && value > 0;
function requireValue(condition) {
  if (!condition) throw new Error('Invalid desktop projection or missing baseline');
}
function head(value, child) {
  const result = { ...value };
  delete result[child];
  return result;
}
function ordered(values, previous, encode) {
  const old = new Map((previous ?? []).map(value => [value.id, value]));
  return { order: values.map(value => value.id), changes: values.filter(value => old.get(value.id) !== value)
    .map(value => encode(value, old.get(value.id))) };
}
function turn(value, previous) {
  return { id: value.id, head: head(value, 'items'),
    ...(Array.isArray(value.items) ? { items: ordered(value.items, previous?.items, item => item) } : { items: value.items }) };
}
function thread(value, previous) {
  return { id: value.id, head: head(value, 'turns'),
    ...(Array.isArray(value.turns) ? { turns: ordered(value.turns, previous?.turns, turn) } : { turns: value.turns }) };
}
function project(value, previous) {
  return { id: value.id, head: head(value, 'state'), state: value.state == null ? value.state : {
    head: head(value.state, 'threads'), threads: ordered(Object.values(value.state.threads),
      Object.values(previous?.state?.threads ?? {}), thread),
  } };
}
class ProjectionEncoder {
  constructor(stream) { this.stream = stream; this.sequence = 0; this.value = undefined; }
  encode(snapshot, full = false) {
    const base = this.sequence;
    const frame = { projection: VERSION, stream: this.stream, sequence: ++this.sequence,
      ...(full || !this.value ? { kind: 'full', snapshot } : { kind: 'delta', base,
        head: head(snapshot, 'projects'), projects: ordered(snapshot.projects, this.value.projects, project) }) };
    this.value = snapshot;
    return frame;
  }
}
function ids(values) {
  requireValue(Array.isArray(values) && values.every(identity) && new Set(values).size === values.length);
}
function validateNodes(values, visit) {
  requireValue(Array.isArray(values));
  ids(values.map(value => value?.id));
  for (const value of values) { requireValue(record(value)); visit(value); }
}
function validateTurn(value) {
  if (value.items != null) validateNodes(value.items, () => {});
}
function validateThread(value) {
  if (value.turns != null) validateNodes(value.turns, validateTurn);
}
function validateSnapshot(value) {
  requireValue(record(value));
  validateNodes(value.projects, project => {
    if (project.state == null) return;
    requireValue(record(project.state) && record(project.state.threads));
    for (const [id, thread] of Object.entries(project.state.threads)) {
      requireValue(identity(id) && record(thread) && thread.id === id);
      validateThread(thread);
    }
  });
}
function readHead(value, child, id) {
  requireValue(record(value) && !Object.hasOwn(value, child) && (id === undefined || value.id === id));
  return value;
}
function readOrdered(patch, previous, decode) {
  requireValue(record(patch));
  ids(patch.order);
  requireValue(Array.isArray(patch.changes));
  const next = new Map((previous ?? []).map(value => [value.id, value]));
  const changed = new Set(), wanted = new Set(patch.order);
  for (const value of patch.changes) {
    requireValue(record(value) && identity(value.id) && wanted.has(value.id) && !changed.has(value.id));
    changed.add(value.id);
    next.set(value.id, decode(value, next.get(value.id)));
  }
  return patch.order.map(id => { requireValue(next.has(id)); return next.get(id); });
}
function readTurn(value, previous) {
  const result = { ...readHead(value.head, 'items', value.id) };
  if (Object.hasOwn(value, 'items')) result.items = value.items == null ? value.items
    : readOrdered(value.items, previous?.items, item => item);
  return result;
}
function readThread(value, previous) {
  const result = { ...readHead(value.head, 'turns', value.id) };
  if (Object.hasOwn(value, 'turns')) result.turns = value.turns == null ? value.turns
    : readOrdered(value.turns, previous?.turns, readTurn);
  return result;
}
function readProject(value, previous) {
  const result = { ...readHead(value.head, 'state', value.id) };
  if (Object.hasOwn(value, 'state')) result.state = value.state == null ? value.state : {
    ...readHead(value.state.head, 'threads'),
    threads: Object.fromEntries(readOrdered(value.state.threads, Object.values(previous?.state?.threads ?? {}), readThread)
      .map(thread => [thread.id, thread])),
  };
  return result;
}
class ProjectionReader {
  constructor() { this.stream = undefined; this.sequence = 0; this.value = undefined; }
  read(frame) {
    requireValue(record(frame) && frame.projection === VERSION && identity(frame.stream) && sequence(frame.sequence)
      && ['full', 'delta'].includes(frame.kind));
    requireValue(this.stream === undefined || frame.stream === this.stream);
    if (frame.sequence <= this.sequence) return this.value;
    let next;
    if (frame.kind === 'full') {
      validateSnapshot(frame.snapshot);
      next = frame.snapshot;
    } else {
      requireValue(this.value !== undefined && frame.base === this.sequence);
      next = { ...readHead(frame.head, 'projects'), projects: readOrdered(frame.projects, this.value.projects, readProject) };
    }
    this.stream = frame.stream; this.sequence = frame.sequence; this.value = next;
    return next;
  }
}
module.exports = { ProjectionEncoder, ProjectionReader };
