// @ts-check
"use strict";
const { record } = require("./provider.cjs");
/** @typedef {{operation:'status'|'retry'}|{operation:'setEnabled',enabled:boolean,expectedRevision:string}} TrajectoryRequest */
/** @typedef {{id:string,status:'pending'|'uploading'|'failed'|'uploaded'|'evicted',created_at:number,uploaded_at:number|null,attempts:number,next_attempt_at:number|null,bytes:number,error:string|null,turn_id?:string|null,event_name?:string|null,model_name?:string|null,harness_version?:string|null,execution_duration_ms?:number|null,model_call_duration_ms?:number|null,occurred_at?:number|null}} TrajectoryRecord */
/** @typedef {{scope:'recent_records',record_limit:100,records_considered:number,model_calls:number,total_duration_ms:number|null,mean_duration_ms:number|null,max_duration_ms:number|null}} TrajectoryModelCallSummary */
/** @typedef {{enabled:boolean,config_revision?:string,capture_apply_pending?:boolean,capture_apply_error?:string|null,state:'disabled'|'ready'|'degraded'|'invalid',endpoint:string,configPath:string|null,spool_dir:string,worker_running:boolean,queue:{pending:number,uploading:number,failed:number,uploaded:number,evicted:number,bytes:number,max_bytes:number,dropped_memory:number,dropped_oversize:number},last_error:string|null,last_success_at:number|null,records:TrajectoryRecord[],model_call_summary?:TrajectoryModelCallSummary,limits:{max_retries:number,upload_interval_ms:number,max_memory_bytes:number}}} TrajectoryStatus */
/** @returns {never} */
function invalid() {
  throw new Error("Core 返回了无效的数据飞轮状态，请检查 Core 版本");
}
/** @param {unknown} value */
function text(value) {
  if (typeof value !== "string") invalid();
  return value;
}
/** @param {unknown} value */
function optionalText(value) {
  return value == null ? null : text(value);
}
/** @param {unknown} value */
function count(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
/** @param {unknown} value */
function timestamp(value) {
  return value == null ? null : count(value);
}
/** @param {unknown} value */
function duration(value) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid();
  return value;
}
/** @param {Record<string,unknown>} record */
function modelDuration(record) {
  if (!Object.hasOwn(record, "model_call_duration_ms")) return {};
  const value = duration(record.model_call_duration_ms);
  if (value != null && record.event_name !== "gen_ai.client.inference.operation.details") invalid();
  return { model_call_duration_ms: value };
}
/** @param {unknown} value @param {number} recordCount @returns {TrajectoryModelCallSummary} */
function modelSummary(value, recordCount) {
  if (!record(value) || value.scope !== "recent_records" || value.record_limit !== 100) invalid();
  const considered = count(value.records_considered),
    calls = count(value.model_calls);
  if (considered !== recordCount || considered > 100 || calls > considered) invalid();
  const total = duration(value.total_duration_ms),
    mean = duration(value.mean_duration_ms),
    maximum = duration(value.max_duration_ms);
  // 旧记录没有计时不补零；总和溢出时 Core 可保留有效最大值并将总和/平均标为未知。
  if (
    (total == null) !== (mean == null) ||
    (calls === 0 ? total != null || maximum != null : maximum == null)
  )
    invalid();
  return {
    scope: "recent_records",
    record_limit: 100,
    records_considered: considered,
    model_calls: calls,
    total_duration_ms: total,
    mean_duration_ms: mean,
    max_duration_ms: maximum,
  };
}
/** @param {unknown} value */
function boolean(value) {
  if (typeof value !== "boolean") invalid();
  return value;
}
/** @template {string} T @param {unknown} value @param {T[]} allowed @returns {T} */
function choice(value, allowed) {
  const found = allowed.find((item) => item === value);
  if (found === undefined) invalid();
  return found;
}

// 只向界面投影已约定的状态字段，Core 新增字段不会自动穿过 IPC。
/** @param {unknown} value @returns {TrajectoryStatus} */
function publicStatus(value) {
  if (
    !record(value) ||
    !Array.isArray(value.records) ||
    !record(value.queue) ||
    !record(value.limits)
  )
    invalid();
  const queue = value.queue,
    limits = value.limits;
  return {
    enabled: boolean(value.enabled),
    ...(Object.hasOwn(value, "config_revision")
      ? {
          config_revision:
            value.config_revision === "missing" ||
            /^[a-f0-9]{64}$/.test(text(value.config_revision))
              ? text(value.config_revision)
              : invalid(),
        }
      : {}),
    state: choice(value.state, ["disabled", "ready", "degraded", "invalid"]),
    endpoint: text(value.endpoint),
    configPath: optionalText(value.configPath),
    spool_dir: text(value.spool_dir),
    worker_running: boolean(value.worker_running),
    queue: {
      pending: count(queue.pending),
      uploading: count(queue.uploading),
      failed: count(queue.failed),
      uploaded: count(queue.uploaded),
      evicted: count(queue.evicted),
      bytes: count(queue.bytes),
      max_bytes: count(queue.max_bytes),
      dropped_memory: count(queue.dropped_memory),
      dropped_oversize: count(queue.dropped_oversize),
    },
    last_error: optionalText(value.last_error),
    last_success_at: timestamp(value.last_success_at),
    records: value.records.slice(0, 100).map((entry) => {
      if (!record(entry)) invalid();
      return {
        id: text(entry.id),
        status: choice(entry.status, ["pending", "uploading", "failed", "uploaded", "evicted"]),
        created_at: count(entry.created_at),
        uploaded_at: timestamp(entry.uploaded_at),
        attempts: count(entry.attempts),
        next_attempt_at: timestamp(entry.next_attempt_at),
        bytes: count(entry.bytes),
        error: optionalText(entry.error),
        ...Object.fromEntries(
          ["turn_id", "event_name", "model_name", "harness_version"]
            .filter((key) => Object.hasOwn(entry, key))
            .map((key) => [key, optionalText(entry[key])]),
        ),
        ...Object.fromEntries(
          ["execution_duration_ms", "occurred_at"]
            .filter((key) => Object.hasOwn(entry, key))
            .map((key) => [key, timestamp(entry[key])]),
        ),
        ...modelDuration(entry),
      };
    }),
    ...(Object.hasOwn(value, "model_call_summary")
      ? {
          model_call_summary: modelSummary(
            value.model_call_summary,
            Math.min(value.records.length, 100),
          ),
        }
      : {}),
    limits: {
      max_retries: count(limits.max_retries),
      upload_interval_ms: count(limits.upload_interval_ms),
      max_memory_bytes: count(limits.max_memory_bytes),
    },
  };
}

/** @template {string} N @typedef {N extends 'trajectory' ? TrajectoryRequest : never} Request */
/** @template {string} N @template P @typedef {N extends 'trajectory' ? P extends {operation:'status'|'retry'|'setEnabled'} ? TrajectoryStatus : never : never} Response */
/** @template {string} N @param {N} name @param {unknown} value @returns {value is Request<N>} */
function isRequest(name, value) {
  if (name !== "trajectory" || !record(value)) return false;
  if (
    Object.keys(value).some(
      (key) =>
        !(
          value.operation === "setEnabled"
            ? ["operation", "enabled", "expectedRevision"]
            : ["operation"]
        ).includes(key),
    )
  )
    return false;
  if (value.operation === "status" || value.operation === "retry") return true;
  return (
    value.operation === "setEnabled" &&
    typeof value.enabled === "boolean" &&
    typeof value.expectedRevision === "string" &&
    /^[a-f0-9]{64}$/.test(value.expectedRevision)
  );
}
/** @template {string} N @template P @param {N} name @param {P} request @param {unknown} value @returns {value is Response<N,P>} */
function isResponse(name, request, value) {
  if (
    name !== "trajectory" ||
    !record(request) ||
    !["status", "retry", "setEnabled"].includes(String(request.operation)) ||
    !record(value) ||
    !["configPath", "last_error", "last_success_at"].every((key) => value[key] !== undefined) ||
    !Array.isArray(value.records) ||
    value.records.length > 100 ||
    !value.records.every(
      (entry) =>
        record(entry) &&
        ["uploaded_at", "next_attempt_at", "error"].every((key) => entry[key] !== undefined),
    ) ||
    (value.model_call_summary !== undefined &&
      (!record(value.model_call_summary) ||
        !["total_duration_ms", "mean_duration_ms", "max_duration_ms"].every(
          (key) => record(value.model_call_summary) && value.model_call_summary[key] !== undefined,
        ))) ||
    (value.capture_apply_pending !== undefined &&
      typeof value.capture_apply_pending !== "boolean") ||
    (value.capture_apply_error != null && typeof value.capture_apply_error !== "string")
  )
    return false;
  try {
    publicStatus(value);
    return true;
  } catch {
    return false;
  }
}
module.exports = { publicStatus, isRequest, isResponse };
