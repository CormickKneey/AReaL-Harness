// @ts-check
"use strict";
const { record } = require("./remote-core-decoder.cjs");
/** @typedef {import('./remote-session-observer.cjs').RemoteConnection} Connection */
/** @typedef {import('./remote-session-observer.cjs').TaskQuestionRead} QuestionRead */
/** @typedef {{taskId:string,runId:string,questionId:string,[key:string]:unknown}} Target */
/** @typedef {Target & {answers:Record<string,string>}} ReplyParams */
/** @typedef {{taskId:string,expectedRunId:string,expectedRevision:number}} PauseParams */
/** @typedef {ReturnType<typeof pauseState> & {projectId:string,serviceGeneration:string,available:boolean}} PauseRead */
const LIMITS = Object.freeze({
  taskQuestionPages: 8,
  taskQuestionBytes: 32 * 1024,
  taskQuestions: 8,
  taskAnswerBytes: 4096,
});
/** @param {string} code @param {string} message */
const failure = (code, message) => Object.assign(new Error(message), { code });
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
const exact = (value, keys) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
/** @param {unknown} value @returns {value is string} */
function identity(value) {
  return typeof value === "string" && !!value && Buffer.byteLength(value) <= 128;
}
/** @param {unknown} params @returns {asserts params is Target} */
function assertTarget(params) {
  if (
    !record(params) ||
    !identity(params.taskId) ||
    !identity(params.runId) ||
    !identity(params.questionId)
  )
    throw failure("INVALID_PARAMS", "缺少原 Task、Run 和问题身份");
}
/** @param {unknown} params */
function target(params) {
  assertTarget(params);
  return { taskId: params.taskId, runId: params.runId, questionId: params.questionId };
}
/** @param {unknown} params @returns {asserts params is ReplyParams} */
function validateReply(params) {
  assertTarget(params);
  if (
    !record(params.answers) ||
    !Object.keys(params.answers).length ||
    Object.keys(params.answers).length > LIMITS.taskQuestions ||
    Object.entries(params.answers).some(
      ([key, value]) =>
        !key ||
        Buffer.byteLength(key) > 128 ||
        typeof value !== "string" ||
        !value.trim() ||
        Buffer.byteLength(value) > LIMITS.taskAnswerBytes,
    )
  )
    throw failure("INVALID_PARAMS", "答案必须非空且符合 UTF-8 字节预算");
}
/** @param {unknown} params @returns {asserts params is PauseParams} */
function validatePause(params) {
  if (
    !exact(params, ["taskId", "expectedRunId", "expectedRevision"]) ||
    !identity(params.taskId) ||
    !identity(params.expectedRunId) ||
    typeof params.expectedRevision !== "number" ||
    !Number.isSafeInteger(params.expectedRevision) ||
    params.expectedRevision < 0
  )
    throw failure("INVALID_PARAMS", "缺少原 Task、当前 Run 和版本");
}
/** @param {import("./remote-core-decoder.cjs").Task} task @param {string} [runId] */
function pauseState(task, runId) {
  const run = task.runs?.find((value) => value.id === runId);
  const workersComplete =
    Array.isArray(run?.workers) && run.workers.every((worker) => worker.settled === true);
  const settled =
    task.paused === true &&
    !!run &&
    ["paused", "completed", "failed", "cancelled"].includes(run.status) &&
    workersComplete;
  return {
    taskId: task.id,
    runId,
    revision: task.revision,
    taskPaused: task.paused === true,
    taskCancelled: task.cancelled === true,
    currentRunId: task.runs?.at(-1)?.id ?? null,
    runStatus: run?.status ?? "unavailable",
    reason: typeof run?.reason === "string" ? run.reason.slice(0, 128) : null,
    workersSettled: workersComplete,
    settled,
    provesCommandAdmission: false,
  };
}
class TaskQuestions {
  /** @param {InstanceType<typeof import("./remote-session-observer.cjs").SessionObservers>} observers */
  constructor(observers) {
    this.observers = observers;
  }
  /** @template T @param {Connection} connection @param {string} projectId @param {unknown} params @param {(value:PauseRead)=>T} publish */
  async pauseRead(connection, projectId, params, publish) {
    params = structuredClone(params);
    if (
      !exact(params, ["taskId", "runId"]) ||
      typeof params.taskId !== "string" ||
      !params.taskId ||
      Buffer.byteLength(params.taskId) > 128 ||
      (params.runId !== undefined &&
        (typeof params.runId !== "string" ||
          !params.runId ||
          Buffer.byteLength(params.runId) > 128))
    )
      throw failure("INVALID_PARAMS", "无效的 Task 读取参数");
    const request = { taskId: params.taskId, runId: params.runId };
    return this.observers.taskQuestion(connection, projectId, request, ({ task }, entry) => {
      const state = pauseState(task, request.runId);
      return publish({
        ...state,
        projectId,
        serviceGeneration: entry.generation,
        available:
          !!request.runId &&
          state.currentRunId === request.runId &&
          !task.paused &&
          !task.cancelled &&
          Number.isSafeInteger(task.revision) &&
          task.revision >= 0 &&
          entry.project.client.capabilities?.features?.taskPauseRunGuard === true &&
          entry.project.client.capabilities?.methods?.includes("areal/task/pause") === true,
      });
    });
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async preparePause(connection, projectId, params) {
    validatePause(params);
    return this.pauseRead(
      connection,
      projectId,
      { taskId: params.taskId, runId: params.expectedRunId },
      (state) => {
        if (
          state.currentRunId !== params.expectedRunId ||
          state.revision !== params.expectedRevision ||
          state.taskCancelled
        )
          throw failure("TARGET_CHANGED", "原 Task Run 或版本已变化");
        return { ...params };
      },
    );
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async observePause(connection, projectId, params) {
    validatePause(params);
    return this.pauseRead(
      connection,
      projectId,
      { taskId: params.taskId, runId: params.expectedRunId },
      (state) => ({
        ...state,
        source: "task.read",
        provesCommandAdmission: false,
      }),
    );
  }
  /** @param {QuestionRead} value @param {Target} params */
  lookup(value, params) {
    const run = value.task.runs.find((run) => run.id === params.runId);
    if (
      value.task?.id !== params.taskId ||
      !run ||
      (value.item &&
        (value.item.id !== params.questionId ||
          value.item.runId !== params.runId ||
          value.item.kind !== "question"))
    )
      throw failure("TARGET_CHANGED", "原 Task、Run 或问题已不存在");
    if (!value.item && value.complete) throw failure("TARGET_CHANGED", "原问题已不存在");
    return { item: value.item, run };
  }
  /** @template T @param {Connection} connection @param {string} projectId @param {unknown} params @param {(value:unknown)=>T} publish */
  async read(connection, projectId, params, publish) {
    params = structuredClone(params);
    if (!exact(params, ["taskId", "runId", "questionId"]))
      throw failure("INVALID_PARAMS", "无效的问题读取参数");
    assertTarget(params);
    return this.observers.taskQuestion(connection, projectId, params, (value, entry) => {
      const { item, run } = this.lookup(value, params);
      const complete =
        value.complete &&
        !!item &&
        Array.isArray(item.questions) &&
        item.questions.length > 0 &&
        item.questions.length <= LIMITS.taskQuestions &&
        Buffer.byteLength(JSON.stringify(item.questions)) <= LIMITS.taskQuestionBytes;
      const content = { questions: complete ? item.questions : [] };
      return publish({
        projectId,
        serviceGeneration: entry.generation,
        ...target(params),
        kind: "asyncQuestion",
        taskPaused: value.task.paused === true,
        taskCancelled: value.task.cancelled === true,
        runStatus: run.status,
        status: item?.status ?? "unavailable",
        expiresAt: item?.expiresAt ?? null,
        complete,
        ...content,
      });
    });
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async prepare(connection, projectId, params) {
    params = structuredClone(params);
    validateReply(params);
    return this.observers.taskQuestion(connection, projectId, params, (value) => {
      const { item, run } = this.lookup(value, params);
      if (
        !value.complete ||
        !item ||
        !Array.isArray(item.questions) ||
        !item.questions.length ||
        item.questions.length > LIMITS.taskQuestions ||
        Buffer.byteLength(JSON.stringify(item.questions)) > LIMITS.taskQuestionBytes
      )
        throw failure("REVIEW_INCOMPLETE", "请完整读取原问题后回复");
      if (
        value.task.cancelled ||
        item.status !== "pending" ||
        (item.expiresAt !== null &&
          item.expiresAt !== undefined &&
          item.expiresAt <= Date.now() / 1000) ||
        ["completed", "failed", "cancelled"].includes(run.status)
      )
        throw failure("TARGET_CHANGED", "原问题已结束或过期");
      if (
        Object.keys(params.answers).length !== item.questions.length ||
        item.questions.some(
          (q) =>
            !Object.hasOwn(params.answers, q.id) ||
            (!q.allowFreeText && !q.options.includes(params.answers[q.id])),
        )
      )
        throw failure("INVALID_PARAMS", "答案必须匹配 Core 的原题目和选项");
      return { ...target(params), answers: params.answers };
    });
  }
  /** @param {Connection} connection @param {string} projectId @param {unknown} params */
  async observe(connection, projectId, params) {
    params = structuredClone(params);
    assertTarget(params);
    return this.observers.taskQuestion(connection, projectId, params, (value) => {
      const { item } = this.lookup(value, params);
      return {
        source: "task.question.read",
        ...target(params),
        status: item?.status ?? "unavailable",
        expiresAt: item?.expiresAt ?? null,
        taskPaused: value.task.paused === true,
        complete: value.complete,
        provesCommandAdmission: false,
      };
    });
  }
}
module.exports = { TaskQuestions, LIMITS, validateReply, validatePause, target };
