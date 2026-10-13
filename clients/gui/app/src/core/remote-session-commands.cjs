"use strict";
const { createHash } = require("node:crypto");
const { validateReply, validatePause } = require("./remote-task-questions.cjs");
const { validateResponse } = require("./remote-interactions.cjs");
const METHODS = [
    "session.create",
    "session.send",
    "turn.stop",
    "interaction.respond",
    "task.question.reply",
    "task.pause",
    "command.read",
];
const LIMITS = {
    commandTextBytes: 64 * 1024,
    commandJournalEntries: 4096,
    commandPendingBytes: 72 * 1024,
    commandOutcomeBytes: 4096,
};
const failure = (code, message) => Object.assign(new Error(message), { code });
const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
const uuid = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function validate(request) {
    const read = request.method === "command.read";
    if (
        !METHODS.includes(request.method) ||
        !exact(request, ["id", "method", "context", "params", ...(read ? [] : ["commandId"])]) ||
        !exact(
            request.context,
            read
                ? ["projectId"]
                : ["projectId", "gatewayGeneration", "grantRevision", "serviceGeneration"],
        ) ||
        typeof request.context.projectId !== "string" ||
        request.context.projectId.length > 128 ||
        !exact(
            request.params,
            read
                ? ["commandId"]
                : request.method === "task.pause"
                  ? ["taskId", "expectedRunId", "expectedRevision"]
                  : request.method === "task.question.reply"
                    ? ["taskId", "runId", "questionId", "answers"]
                    : request.method === "interaction.respond"
                      ? [
                            "threadId",
                            "turnId",
                            "interactionId",
                            "argumentsDigest",
                            "decision",
                            "answers",
                            "reviewToken",
                        ]
                      : request.method === "turn.stop"
                        ? ["threadId", "expectedTurnId"]
                        : request.method === "session.send"
                          ? ["threadId", "expectedConfigRevision", "text"]
                          : [],
        ) ||
        !uuid(read ? request.params.commandId : request.commandId)
    )
        throw failure("INVALID_PARAMS", "无效的命令参数");
    if (request.method === "task.pause") validatePause(request.params);
    if (request.method === "interaction.respond") validateResponse(request.params);
    if (request.method === "task.question.reply") validateReply(request.params);
    if (
        !read &&
        (typeof request.context.gatewayGeneration !== "string" ||
            !Number.isSafeInteger(request.context.grantRevision) ||
            typeof request.context.serviceGeneration !== "string")
    )
        throw failure("INVALID_PARAMS", "缺少当前连接身份");
    if (
        request.method === "turn.stop" &&
        ["threadId", "expectedTurnId"].some(
            (key) =>
                typeof request.params[key] !== "string" ||
                !request.params[key] ||
                Buffer.byteLength(request.params[key]) > 128,
        )
    )
        throw failure("INVALID_PARAMS", "缺少确切的会话和轮次");
    if (
        request.method === "session.send" &&
        (typeof request.params.threadId !== "string" ||
            !request.params.threadId ||
            request.params.threadId.length > 128 ||
            !Number.isSafeInteger(request.params.expectedConfigRevision) ||
            request.params.expectedConfigRevision < 0 ||
            typeof request.params.text !== "string" ||
            !request.params.text.trim() ||
            Buffer.byteLength(request.params.text) > LIMITS.commandTextBytes)
    )
        throw failure("INVALID_PARAMS", "文本或会话条件无效");
}
function authorize(remote, connection, projectId, capability = "submit") {
    if (
        remote.closed ||
        remote.backend.closing ||
        !connection.alive() ||
        connection.gatewayGeneration !== remote.gatewayGeneration
    )
        throw failure("RESYNC_REQUIRED", "连接已变化，请重新连接");
    const grant = remote.config?.deviceGrants?.find(
        (value) => value.devicePeerId === connection.peer && value.status === "active",
    );
    if (!grant || grant.revision !== connection.grantRevision)
        throw failure("GRANT_CHANGED", "授权已变化，请重新连接");
    if (
        !grant.projectIds.includes(projectId) ||
        !grant.capabilities.includes(capability) ||
        !remote.backend.saved.some((value) => value.id === projectId)
    )
        throw failure("FORBIDDEN", "此命令未获授权");
    return grant;
}
function nativeError(error, method) {
    if (method === "areal/thread/start" && error.code === -32004)
        return {
            code: "CONFIGURATION_UNAVAILABLE",
            coreCode: -32004,
            message: "会话配置不可用，请在桌面检查默认模型与技能配置，再新建会话。",
        };
    const code =
        typeof error.code === "string"
            ? error.code
            : error.code === -32009
              ? "TARGET_CHANGED"
              : error.code === -32001
                ? "CAPACITY_EXCEEDED"
                : error.code === -32602
                  ? "INVALID_PARAMS"
                  : "CORE_UNAVAILABLE";
    return {
        code,
        ...(typeof (error.coreCode ?? error.code) === "number"
            ? { coreCode: error.coreCode ?? error.code }
            : {}),
        message: "命令未受理，请刷新状态后检查草稿",
    };
}
function view(backend, record, commandId) {
    if (!record) return { commandId, admissionState: "notFound", submissionUnknown: true };
    return {
        commandId,
        method: record.remote.method,
        target: record.remote.target,
        operationId: record.operationId,
        ...(!["turn/interrupt", "areal/interaction/respond"].includes(record.method)
            ? { nativeRequestId: record.params?.requestId ?? record.operationId }
            : {}),
        admissionState:
            record.admissionState ??
            (backend.awaitingResponses.has(record) ? "pending" : "unknown"),
        submissionUnknown: !record.admissionState,
        ...(record.threadId ? { threadId: record.threadId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
        ...(record.receipt ? { receipt: record.receipt } : {}),
        ...(record.error ? { error: nativeError(record.error, record.method) } : {}),
    };
}
async function sessionCommand(
    remote,
    connection,
    request,
    publish,
    observeAdmission,
    reviews,
    taskQuestions,
) {
    request = structuredClone(request);
    validate(request);
    const backend = remote.backend,
        projectId = request.context.projectId;
    const stop = request.method === "turn.stop";
    const respond = request.method === "interaction.respond";
    const reply = request.method === "task.question.reply";
    const pause = request.method === "task.pause";
    const capability = pause
        ? "pauseTask"
        : respond || reply
          ? "answer"
          : stop
            ? "interrupt"
            : request.method === "command.read"
              ? "observe"
              : "submit";
    const auth = () => authorize(remote, connection, projectId, capability);
    auth();
    const association = {
        hostId: remote.crypto.identityId(remote.config.identity),
        devicePeerId: connection.peer,
        projectId,
        commandId: (request.commandId ?? request.params.commandId).toLowerCase(),
    };
    const project = await backend.loadProjectJournal(projectId);
    auth();
    let readIdentity;
    const readRecord = () =>
        backend.readRemoteRecord(project, association, (entry) => {
            authorize(remote, connection, projectId, entry.remote.capability);
            readIdentity = {
                client: project.client,
                generation: project.service?.generation,
                serviceId: project.service?.serviceId,
                endpoint: project.endpoint,
                token: project.token,
            };
        });
    let record = await readRecord();
    auth();
    const semantic = pause
        ? {
              method: request.method,
              taskId: request.params.taskId,
              expectedRunId: request.params.expectedRunId,
              expectedRevision: request.params.expectedRevision,
          }
        : reply
          ? {
                method: request.method,
                taskId: request.params.taskId,
                runId: request.params.runId,
                questionId: request.params.questionId,
                answers: Object.fromEntries(
                    Object.entries(request.params.answers).sort(([a], [b]) => a.localeCompare(b)),
                ),
            }
          : respond
            ? {
                  method: request.method,
                  threadId: request.params.threadId,
                  turnId: request.params.turnId,
                  interactionId: request.params.interactionId,
                  argumentsDigest: request.params.argumentsDigest,
                  decision: request.params.decision,
                  ...(request.params.answers
                      ? {
                            answers: Object.fromEntries(
                                Object.entries(request.params.answers).sort(([a], [b]) =>
                                    a.localeCompare(b),
                                ),
                            ),
                        }
                      : {}),
              }
            : stop
              ? {
                    method: request.method,
                    threadId: request.params.threadId,
                    expectedTurnId: request.params.expectedTurnId,
                }
              : request.method === "session.send"
                ? {
                      method: request.method,
                      threadId: request.params.threadId,
                      expectedConfigRevision: request.params.expectedConfigRevision,
                      text: request.params.text,
                  }
                : { method: request.method };
    const semanticDigest = createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
    if (
        request.method !== "command.read" &&
        record &&
        record.remote.semanticDigest !== semanticDigest
    )
        throw failure("COMMAND_CONFLICT", "命令标识已用于不同内容");
    let identity;
    const checkIdentity = () => {
        if (
            backend.projects.get(projectId) !== project ||
            (identity &&
                (project.client !== identity.client ||
                    project.endpoint !== identity.endpoint ||
                    project.token !== identity.token ||
                    project.service?.serviceId !== identity.serviceId ||
                    project.service?.generation !== identity.generation))
        )
            throw failure("RESYNC_REQUIRED", "项目连接已变化，请刷新状态");
    };
    const current = () => {
        auth();
        if (
            backend.projects.get(projectId) !== project ||
            !project.client?.ready ||
            project.client.closed ||
            !project.model?.state?.connected ||
            project.resourceInitializing
        )
            throw failure("CORE_UNAVAILABLE", "项目 Core 当前不可用");
        checkIdentity();
    };
    if (request.method !== "command.read" && !record) {
        try {
            current();
            identity = {
                client: project.client,
                endpoint: project.endpoint,
                token: project.token,
                serviceId: project.service?.serviceId,
                generation: project.service?.generation,
            };
            const nativeMethod = pause
                ? "areal/task/pause"
                : reply
                  ? "areal/channel/reply"
                  : respond
                    ? "areal/interaction/respond"
                    : stop
                      ? "turn/interrupt"
                      : request.method === "session.create"
                        ? "areal/thread/start"
                        : "areal/turn/start";
            const feature = pause
                ? "taskPauseRunGuard"
                : stop
                  ? "turnInterruptAdmissionGuard"
                  : request.method === "session.create"
                    ? "threadStartAdmissionGuard"
                    : "turnStartAdmissionGuard";
            const check = () => {
                current();
                const context = request.context;
                if (
                    context.gatewayGeneration !== remote.gatewayGeneration ||
                    context.grantRevision !== connection.grantRevision ||
                    context.serviceGeneration !== project.service?.generation
                )
                    throw failure("RESYNC_REQUIRED", "提交条件已变化，请刷新状态");
                if (
                    (!respond && !reply && !project.client.capabilities?.features?.[feature]) ||
                    !project.client.capabilities?.methods?.includes(nativeMethod)
                )
                    throw failure("CORE_INCOMPATIBLE", "Core 不支持安全提交，请在桌面升级");
                if (request.method === "session.send") {
                    if (project.configurationChanges?.has(request.params.threadId))
                        throw failure("TARGET_CHANGED", "会话配置正在变化");
                    const thread = project.model.state.threads?.[request.params.threadId];
                    if (thread?.parentThreadId || thread?.source === "nativeTaskAgent")
                        throw failure("TASK_CONTROL_REQUIRED", "此会话由 Task 管理");
                }
            };
            check();
            if (request.method === "session.send" || stop) {
                if (!observeAdmission) throw failure("CORE_INCOMPATIBLE", "缺少安全会话观察入口");
                const state = await observeAdmission(
                    connection,
                    projectId,
                    request.params.threadId,
                );
                check();
                if (state?.ownership?.kind !== "ordinary")
                    throw failure("TASK_CONTROL_REQUIRED", "此会话由 Task 管理");
                if (stop && state.activeTurnId !== request.params.expectedTurnId)
                    throw failure("TARGET_CHANGED", "原轮次已结束或改变");
                if (!stop && (state.activeTurnId || state.status !== "idle"))
                    throw failure("TURN_BUSY", "会话正在运行，草稿已保留");
                if (
                    !stop &&
                    (state.configRevision !== request.params.expectedConfigRevision ||
                        state.queue?.paused ||
                        state.queue?.pendingCount)
                )
                    throw failure("TARGET_CHANGED", "配置或队列条件已变化，草稿已保留");
            }
            const profile = project.resourceProfile ?? backend.defaultProfile;
            let preparedParams;
            if (respond) {
                if (!reviews) throw failure("CORE_INCOMPATIBLE", "缺少交互审阅入口");
                preparedParams = await reviews.prepare(connection, projectId, request.params);
                check();
            }
            if (pause) {
                if (!taskQuestions) throw failure("CORE_INCOMPATIBLE", "缺少 Task 读取入口");
                preparedParams = await taskQuestions.preparePause(
                    connection,
                    projectId,
                    request.params,
                );
                check();
            }
            if (reply) {
                if (!taskQuestions) throw failure("CORE_INCOMPATIBLE", "缺少 Task 问题读取入口");
                preparedParams = await taskQuestions.prepare(connection, projectId, request.params);
                check();
            }
            const params =
                respond || reply || pause
                    ? preparedParams
                    : stop
                      ? {
                            threadId: request.params.threadId,
                            turnId: request.params.expectedTurnId,
                            admissionGuard: { ordinarySession: true },
                        }
                      : request.method === "session.create"
                        ? {
                              cwd: project.root,
                              ...(profile ? { agentProfile: profile } : {}),
                              admissionGuard: { ordinarySession: true },
                          }
                        : {
                              threadId: request.params.threadId,
                              input: [{ type: "text", text: request.params.text }],
                              expectedConfigRevision: request.params.expectedConfigRevision,
                              admissionGuard: {
                                  ordinarySession: true,
                                  configRevision: request.params.expectedConfigRevision,
                              },
                          };
            record = await backend.submit(project, nativeMethod, params, {
                remote: {
                    ...association,
                    method: request.method,
                    capability,
                    admittedGrantRevision: connection.grantRevision,
                    semanticDigest,
                    target: pause
                        ? { ...request.params }
                        : reply
                          ? {
                                taskId: request.params.taskId,
                                runId: request.params.runId,
                                questionId: request.params.questionId,
                            }
                          : respond
                            ? {
                                  threadId: request.params.threadId,
                                  turnId: request.params.turnId,
                                  interactionId: request.params.interactionId,
                                  ...(request.params.argumentsDigest
                                      ? { argumentsDigest: request.params.argumentsDigest }
                                      : {}),
                              }
                            : stop
                              ? {
                                    threadId: request.params.threadId,
                                    expectedTurnId: request.params.expectedTurnId,
                                }
                              : request.method === "session.send"
                                ? {
                                      threadId: request.params.threadId,
                                      expectedConfigRevision: request.params.expectedConfigRevision,
                                  }
                                : {},
                },
                dispatch: async (entry) => {
                    let response;
                    // 与撤权共享队列；同步检查和 request 启动之间不得 await，RPC 回应在队列外等待。
                    const admission = (remote.writes ?? Promise.resolve())
                        .catch(() => {})
                        .then(() => {
                            check();
                            try {
                                response = identity.client.request(nativeMethod, entry.params).then(
                                    (result) => ({ result }),
                                    (error) => ({ error }),
                                );
                            } catch (error) {
                                response = Promise.resolve({
                                    error: Object.assign(error, { submissionUnknown: true }),
                                });
                            }
                        });
                    remote.writes = admission;
                    await admission;
                    const received = await response;
                    if (received.error) {
                        const error = received.error;
                        if (typeof error.code !== "number" || error.code === -32603)
                            error.submissionUnknown = true;
                        if (
                            error.code === -32602 &&
                            error.message?.includes("UNSUPPORTED_PROFILE:")
                        ) {
                            error.coreCode = error.code;
                            error.code = "UNSUPPORTED_PROFILE";
                        }
                        throw error;
                    }
                    return received.result;
                },
            });
        } catch (error) {
            // 异步预检查期间另一请求可能已持久受理；原关联优先于新命令的准入拒绝。
            auth();
            const original = await readRecord();
            auth();
            checkIdentity();
            if (!original) throw error;
            if (original.remote.semanticDigest !== semanticDigest)
                throw failure("COMMAND_CONFLICT", "命令标识已用于不同内容");
            record = original;
            // 已有关联允许离线核对；上面的身份校验与最终授权之间不再 await。
            identity = undefined;
        }
    }
    let observedState, observationIdentity;
    const observation =
        record?.remote.method === "task.pause"
            ? { observe: taskQuestions.observePause.bind(taskQuestions) }
            : record?.remote.method === "task.question.reply"
              ? taskQuestions
              : record?.remote.method === "interaction.respond"
                ? reviews
                : null;
    if (observation) {
        authorize(remote, connection, projectId, record.remote.capability);
        observationIdentity = {
            client: project.client,
            generation: project.service?.generation,
            serviceId: project.service?.serviceId,
            endpoint: project.endpoint,
            token: project.token,
        };
        try {
            observedState = await observation.observe(connection, projectId, record.remote.target);
        } catch {
            observedState = {
                source:
                    record.remote.method === "task.pause"
                        ? "task.read"
                        : record.remote.method === "task.question.reply"
                          ? "task.question.read"
                          : "interaction.read",
                status: "unavailable",
                provesCommandAdmission: false,
            };
        }
    }
    // 响应最终授权必须紧挨发布；已派发结果即使撤权仍由 journal 保存。
    authorize(remote, connection, projectId, record?.remote.capability ?? "observe");
    if (
        readIdentity &&
        (backend.projects.get(projectId) !== project ||
            project.client !== readIdentity.client ||
            project.service?.generation !== readIdentity.generation ||
            project.service?.serviceId !== readIdentity.serviceId ||
            project.endpoint !== readIdentity.endpoint ||
            project.token !== readIdentity.token)
    )
        throw failure("RESYNC_REQUIRED", "收据查询期间项目连接已变化");
    if (
        observationIdentity &&
        (project.client !== observationIdentity.client ||
            project.service?.generation !== observationIdentity.generation ||
            project.service?.serviceId !== observationIdentity.serviceId ||
            project.endpoint !== observationIdentity.endpoint ||
            project.token !== observationIdentity.token)
    )
        throw failure("RESYNC_REQUIRED", "交互观察期间项目连接已变化");
    checkIdentity();
    if (identity) current();
    return publish({
        ...view(backend, record, association.commandId),
        ...(observedState ? { observedState } : {}),
    });
}
module.exports = { sessionCommand, METHODS, LIMITS, validate, view };
