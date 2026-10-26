// @ts-check
"use strict";
/** @typedef {{id:string,[key:string]:unknown}} ProjectionNode */
/** @typedef {ProjectionNode & {items?:ProjectionNode[]|null}} ProjectionTurn */
/** @typedef {ProjectionNode & {turns?:ProjectionTurn[]|null}} ProjectionThread */
/** @typedef {ProjectionNode & {state?:({threads:Record<string,ProjectionThread>,[key:string]:unknown})|null}} ProjectionProject */
/** @typedef {{projects:ProjectionProject[],[key:string]:unknown}} ProjectionSnapshot */
const VERSION = 1;
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const identity = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
/** @param {unknown} value @returns {value is ProjectionNode} */
const node = (value) => record(value) && identity(value.id);
/** @param {unknown} value @returns {value is number} */
const sequence = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** @param {unknown} condition @returns {asserts condition} */
function requireValue(condition) {
  if (!condition) throw new Error("Invalid desktop projection or missing baseline");
}
/** @param {Record<string,unknown>} value @param {string} child */
function head(value, child) {
  const result = { ...value };
  delete result[child];
  return result;
}
/** @template {ProjectionNode} T @template U @param {T[]} values @param {T[]|undefined|null} previous @param {(value:T,previous:T|undefined)=>U} encode */
function ordered(values, previous, encode) {
  const old = new Map((previous ?? []).map((value) => [value.id, value]));
  return {
    order: values.map((value) => value.id),
    changes: values
      .filter((value) => old.get(value.id) !== value)
      .map((value) => encode(value, old.get(value.id))),
  };
}
/** @param {ProjectionTurn} value @param {ProjectionTurn|undefined} previous */
function turn(value, previous) {
  return {
    id: value.id,
    head: head(value, "items"),
    ...(Array.isArray(value.items)
      ? { items: ordered(value.items, previous?.items, (item) => item) }
      : { items: value.items }),
  };
}
/** @param {ProjectionThread} value @param {ProjectionThread|undefined} previous */
function thread(value, previous) {
  return {
    id: value.id,
    head: head(value, "turns"),
    ...(Array.isArray(value.turns)
      ? { turns: ordered(value.turns, previous?.turns, turn) }
      : { turns: value.turns }),
  };
}
/** @param {ProjectionProject} value @param {ProjectionProject|undefined} previous */
function project(value, previous) {
  return {
    id: value.id,
    head: head(value, "state"),
    state:
      value.state == null
        ? value.state
        : {
            head: head(value.state, "threads"),
            threads: ordered(
              Object.values(value.state.threads),
              Object.values(previous?.state?.threads ?? {}),
              thread,
            ),
          },
  };
}
class ProjectionEncoder {
  constructor(/** @type {string} */ stream) {
    this.stream = stream;
    this.sequence = 0;
    /** @type {ProjectionSnapshot|undefined} */
    this.value = undefined;
  }
  /** @param {ProjectionSnapshot} snapshot */
  encode(snapshot, full = false) {
    const base = this.sequence;
    const frame = {
      projection: VERSION,
      stream: this.stream,
      sequence: ++this.sequence,
      ...(full || !this.value
        ? { kind: "full", snapshot }
        : {
            kind: "delta",
            base,
            head: head(snapshot, "projects"),
            projects: ordered(snapshot.projects, this.value.projects, project),
          }),
    };
    this.value = snapshot;
    return frame;
  }
}
/** @param {unknown} values @returns {asserts values is string[]} */
function ids(values) {
  requireValue(
    Array.isArray(values) && values.every(identity) && new Set(values).size === values.length,
  );
}
/** @param {unknown} values @param {(value:Record<string,unknown>)=>void} visit @returns {asserts values is ProjectionNode[]} */
function validateNodes(values, visit) {
  requireValue(Array.isArray(values));
  ids(values.map((value) => (record(value) ? value.id : undefined)));
  for (const value of values) {
    requireValue(record(value));
    visit(value);
  }
}
/** @param {Record<string,unknown>} value */
function validateTurn(value) {
  if (value.items != null) validateNodes(value.items, () => {});
}
/** @param {Record<string,unknown>} value */
function validateThread(value) {
  if (value.turns != null) validateNodes(value.turns, validateTurn);
}
/** @param {unknown} value @returns {asserts value is ProjectionSnapshot} */
function validateSnapshot(value) {
  requireValue(record(value));
  validateNodes(value.projects, (project) => {
    if (project.state == null) return;
    requireValue(record(project.state) && record(project.state.threads));
    for (const [id, thread] of Object.entries(project.state.threads)) {
      requireValue(identity(id) && record(thread) && thread.id === id);
      validateThread(thread);
    }
  });
}
/** @overload @param {unknown} value @param {string} child @param {string} id @returns {ProjectionNode} */
/** @overload @param {unknown} value @param {string} child @returns {Record<string,unknown>} */
/** @param {unknown} value @param {string} child @param {string} [id] */
function readHead(value, child, id) {
  requireValue(
    record(value) && !Object.hasOwn(value, child) && (id === undefined || value.id === id),
  );
  return value;
}
/** @template {ProjectionNode} T @param {unknown} patch @param {T[]|undefined|null} previous @param {(value:ProjectionNode,previous:T|undefined)=>T} decode @returns {T[]} */
function readOrdered(patch, previous, decode) {
  requireValue(record(patch));
  ids(patch.order);
  requireValue(Array.isArray(patch.changes));
  const next = new Map((previous ?? []).map((value) => [value.id, value]));
  const changed = new Set(),
    wanted = new Set(patch.order);
  for (const value of patch.changes) {
    requireValue(node(value) && wanted.has(value.id) && !changed.has(value.id));
    changed.add(value.id);
    next.set(value.id, decode(value, next.get(value.id)));
  }
  return patch.order.map((id) => {
    const value = next.get(id);
    requireValue(value !== undefined);
    return value;
  });
}
/** @param {ProjectionNode} value @param {ProjectionTurn|undefined} previous @returns {ProjectionTurn} */
function readTurn(value, previous) {
  /** @type {ProjectionTurn} */
  const result = { ...readHead(value.head, "items", value.id) };
  if (Object.hasOwn(value, "items"))
    result.items =
      value.items == null ? value.items : readOrdered(value.items, previous?.items, (item) => item);
  return result;
}
/** @param {ProjectionNode} value @param {ProjectionThread|undefined} previous @returns {ProjectionThread} */
function readThread(value, previous) {
  /** @type {ProjectionThread} */
  const result = { ...readHead(value.head, "turns", value.id) };
  if (Object.hasOwn(value, "turns"))
    result.turns =
      value.turns == null ? value.turns : readOrdered(value.turns, previous?.turns, readTurn);
  return result;
}
/** @param {ProjectionNode} value @param {ProjectionProject|undefined} previous @returns {ProjectionProject} */
function readProject(value, previous) {
  /** @type {ProjectionProject} */
  const result = { ...readHead(value.head, "state", value.id) };
  if (Object.hasOwn(value, "state")) {
    requireValue(value.state == null || record(value.state));
    result.state =
      value.state == null
        ? value.state
        : {
            ...readHead(value.state.head, "threads"),
            threads: Object.fromEntries(
              readOrdered(
                value.state.threads,
                Object.values(previous?.state?.threads ?? {}),
                readThread,
              ).map((thread) => [thread.id, thread]),
            ),
          };
  }
  return result;
}
class ProjectionReader {
  constructor() {
    /** @type {string|undefined} */
    this.stream = undefined;
    this.sequence = 0;
    /** @type {ProjectionSnapshot|undefined} */
    this.value = undefined;
  }
  /** @param {unknown} frame */
  read(frame) {
    requireValue(
      record(frame) &&
        frame.projection === VERSION &&
        identity(frame.stream) &&
        sequence(frame.sequence) &&
        (frame.kind === "full" || frame.kind === "delta"),
    );
    requireValue(this.stream === undefined || frame.stream === this.stream);
    if (frame.sequence <= this.sequence) {
      requireValue(this.value !== undefined);
      return this.value;
    }
    let next;
    if (frame.kind === "full") {
      validateSnapshot(frame.snapshot);
      next = frame.snapshot;
    } else {
      requireValue(this.value !== undefined && frame.base === this.sequence);
      next = {
        ...readHead(frame.head, "projects"),
        projects: readOrdered(frame.projects, this.value.projects, readProject),
      };
    }
    this.stream = frame.stream;
    this.sequence = frame.sequence;
    this.value = next;
    return next;
  }
}
module.exports = { ProjectionEncoder, ProjectionReader };
