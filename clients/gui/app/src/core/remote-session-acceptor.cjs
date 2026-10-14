"use strict";
const { randomUUID } = require("node:crypto");
const { readOverview, METHODS: OVERVIEW_METHODS } = require("./remote-work-overview.cjs");
const {
    SessionObservers,
    METHODS: SESSION_METHODS,
    LIMITS: SESSION_LIMITS,
} = require("./remote-session-observer.cjs");
const {
    sessionCommand,
    METHODS: COMMAND_METHODS,
    LIMITS: COMMAND_LIMITS,
} = require("./remote-session-commands.cjs");
const { InteractionReviews, LIMITS: INTERACTION_LIMITS } = require("./remote-interactions.cjs");
const { TaskQuestions, LIMITS: TASK_QUESTION_LIMITS } = require("./remote-task-questions.cjs");
const { ResultReviews, LIMITS: REVIEW_LIMITS } = require("./remote-result-review.cjs");
const METHODS = [
    "review.read",
    "artifact.read",
    ...OVERVIEW_METHODS,
    ...SESSION_METHODS,
    ...COMMAND_METHODS,
    "attention.read",
    "task.question.read",
    "task.read",
];
const { basename } = require("node:path");

const LIMITS = Object.freeze({
    ...SESSION_LIMITS,
    ...REVIEW_LIMITS,
    ...INTERACTION_LIMITS,
    ...TASK_QUESTION_LIMITS,
    ...COMMAND_LIMITS,
    applicationMessageBytes: 256 * 1024,
    transportFrameBytes: 512 * 1024,
    receiveBufferedBytes: 2 * 1024 * 1024,
    sendBufferedBytes: 2 * 1024 * 1024,
    sendPlaintextBufferedBytes: 1024 * 1024,
    sendTransportBufferedBytes: 1024 * 1024,
    activeHostConnections: 16,
    hostReceiveBufferedBytes: 8 * 1024 * 1024,
    hostSendBufferedBytes: 8 * 1024 * 1024,
    activeDeviceConnections: 2,
    readRequestsPerSecond: 20,
    writeRequestsPerSecond: 5,
    writeBurst: 10,
    pendingHandshakes: 8,
    helloDeadlineMs: 15000,
    heartbeatIntervalMs: 15000,
    heartbeatTimeoutMs: 45000,
    projectPageDefault: 30,
    projectPageMaximum: 100,
    overviewPageDefault: 30,
    overviewPageMaximum: 100,
    overviewPageBytes: 128 * 1024,
});
const CAPABILITIES = ["observe", "review", "submit", "interrupt", "answer", "pauseTask"];
// 只输出固定协议文案；底层文件/网络错误即使带字符串 code 也不得携带 Host 路径。
const COMMAND_ERRORS = Object.freeze({
    INVALID_PARAMS: "无效的命令参数",
    REVIEW_INCOMPLETE: "审阅尚未完整，请继续加载或在桌面处理；仍可拒绝",
    FORBIDDEN: "此命令未获授权",
    GRANT_CHANGED: "授权已变化，请重新连接",
    RESYNC_REQUIRED: "连接或提交条件已变化，请重新读取状态",
    CORE_UNAVAILABLE: "命令暂不可用，请查询受理结果",
    CORE_INCOMPATIBLE: "Core 不支持安全提交，请在桌面升级",
    RESOURCE_UNAVAILABLE: "提交存储暂不可用，请查询受理结果",
    TURN_BUSY: "会话正在运行，草稿已保留",
    TASK_CONTROL_REQUIRED: "此会话由 Task 管理",
    TARGET_CHANGED: "会话条件已变化，草稿已保留",
    COMMAND_CONFLICT: "命令标识已用于不同内容，请核对原命令",
    SUBMISSION_UNKNOWN: "提交结果未知，请核对原命令",
    LIMIT_EXCEEDED: "命令超过允许的预算",
    CAPACITY_EXCEEDED: "提交日志容量已满",
    UNSUPPORTED_PROFILE: "默认 Profile 不支持普通会话，请在桌面调整",
});
const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
const fail = (id, code, message) => ({
    ...(id === undefined ? {} : { id }),
    error: { code, message },
});

function currentGrant(remote, peer) {
    return remote.config?.deviceGrants?.find(
        (value) =>
            value?.devicePeerId === peer &&
            value.status === "active" &&
            Array.isArray(value.projectIds) &&
            Array.isArray(value.capabilities) &&
            value.capabilities.includes("observe"),
    );
}
function projectViews(remote, grant) {
    const allowed = new Set(grant.projectIds);
    const names = remote.backend.library?.value?.projects ?? {};
    return remote.backend.saved
        .filter((value) => allowed.has(value.id))
        .map((value) => {
            const live = remote.backend.projects?.get(value.id);
            return {
                projectId: value.id,
                name: String(names[value.id]?.name ?? basename(value.root)).slice(0, 200),
                connectionState: live?.model?.state?.connected ? "online" : "offline",
                serviceGeneration: live?.service?.generation ?? null,
            };
        });
}

// 同一 Host 的两个入口共享身份、观察者和预算；传输只提供字节与关闭事件。
class SessionAcceptor {
    constructor(remote) {
        this.remote = remote;
        this.sockets = new Set();
        this.observers = new SessionObservers(remote);
        this.observers.reviews = new InteractionReviews(this.observers);
        this.observers.taskQuestions = new TaskQuestions(this.observers);
        this.observers.resultReviews = new ResultReviews(this.observers);
    }
    available() {
        return (
            !this.closed &&
            !this.remote.closed &&
            this.sockets.size < LIMITS.activeHostConnections &&
            [...this.sockets].filter((socket) => !socket.authenticated).length <
                LIMITS.pendingHandshakes
        );
    }
    receiveBufferedBytes() {
        return [...this.sockets].reduce(
            (sum, socket) => sum + (socket.wire?.bufferedBytes ?? 0),
            0,
        );
    }
    sendBufferedBytes() {
        return [...this.sockets].reduce(
            (sum, socket) => sum + (socket.secure?.bufferedBytes ?? 0) + socket.bufferedAmount,
            this.remote.relayTransport?.bufferedAmount ?? 0,
        );
    }
    accept(socket) {
        if (!this.available()) {
            socket.terminate();
            return;
        }
        this.sockets.add(socket);
        const deadline = setTimeout(() => {
            if (!socket.authenticated && !socket.awaitingApproval) socket.terminate();
        }, LIMITS.helloDeadlineMs);
        deadline.unref?.();
        socket.once("close", () => {
            this.sockets.delete(socket);
            clearTimeout(deadline);
        });
        void observe(this.remote, socket, this).catch(() => socket.terminate());
    }
    closePeer(peer) {
        for (const socket of this.sockets)
            if (socket.remotePeer === peer && socket.authenticated) socket.terminate();
    }
    close() {
        this.closed = true;
        for (const socket of [...this.sockets]) socket.terminate();
        this.observers.close();
    }
}

async function observe(remote, socket, owner) {
    const { sockets, observers } = owner;
    const wire = remote.crypto.byteChannel(
        (bytes) => {
            if (
                socket.readyState !== 1 ||
                socket.bufferedAmount + bytes.length > LIMITS.sendTransportBufferedBytes ||
                owner.sendBufferedBytes() + bytes.length > LIMITS.hostSendBufferedBytes
            ) {
                socket.terminate();
                throw new Error("发送缓冲已满");
            }
            return socket.send(bytes);
        },
        () => socket.close(),
    );
    socket.wire = wire;
    socket.on("message", (bytes, binary) => {
        if (
            !binary ||
            bytes.length > LIMITS.transportFrameBytes ||
            owner.receiveBufferedBytes() + bytes.length > LIMITS.hostReceiveBufferedBytes
        ) {
            socket.terminate();
            wire.close();
            return;
        }
        try {
            wire.receive(bytes);
        } catch {
            socket.terminate();
            wire.close();
        }
    });
    socket.on("close", () => wire.close());
    const secure = await remote.crypto.secureChannel(wire, remote.config.identity, undefined, {
        maxMessageBytes: LIMITS.applicationMessageBytes,
        maxBufferedBytes: LIMITS.sendPlaintextBufferedBytes,
    });
    socket.secure = secure;
    const send = secure.send.bind(secure);
    secure.send = (value) => {
        if (
            owner.sendBufferedBytes() + Buffer.byteLength(JSON.stringify(value)) >
            LIMITS.hostSendBufferedBytes
        ) {
            socket.terminate();
            secure.close();
            throw new Error("Host 发送缓冲已满");
        }
        try {
            send(value);
        } catch (error) {
            socket.terminate();
            throw error;
        }
    };
    socket.remotePeer = secure.peer;
    if (
        [...sockets].filter((value) => value.remotePeer === secure.peer).length >
        LIMITS.activeDeviceConnections
    ) {
        secure.close();
        return;
    }
    const messages = secure.messages();
    const first = await messages.next();
    if (first.done) return;
    const hello = first.value;
    if (
        !exact(hello, ["method", "apiVersion", "clientVersion", "displayName", "inviteSecret"]) ||
        hello.method !== "hello" ||
        typeof hello.clientVersion !== "string" ||
        hello.clientVersion.length > 80 ||
        typeof hello.displayName !== "string" ||
        !hello.displayName.trim() ||
        hello.displayName.length > 80
    ) {
        secure.send(fail(undefined, "INVALID_PARAMS", "无效的连接请求"));
        setTimeout(() => secure.close(), 25);
        return;
    }
    if (hello.apiVersion !== "areal.remote.v2") {
        secure.send(fail(undefined, "PROTOCOL_UNSUPPORTED", "请更新远程客户端"));
        setTimeout(() => secure.close(), 25);
        return;
    }
    const peer = secure.peer;
    if (hello.inviteSecret !== undefined) {
        try {
            const approval = remote.claim(peer, hello, socket);
            socket.awaitingApproval = true;
            secure.send({ event: "pairing", fingerprint: peer });
            await approval;
        } catch (error) {
            if (socket.readyState === 1)
                secure.send(fail(undefined, error.code ?? "FORBIDDEN", error.message));
            setTimeout(() => secure.close(), 25);
            return;
        } finally {
            socket.awaitingApproval = false;
        }
    }
    const grant = currentGrant(remote, peer);
    if (!grant) {
        secure.send(fail(undefined, "FORBIDDEN", "设备未获授权"));
        setTimeout(() => secure.close(), 25);
        return;
    }
    socket.authenticated = true;
    const connectionId = randomUUID();
    const connection = {
        connectionId,
        peer,
        grantRevision: grant.revision,
        gatewayGeneration: remote.gatewayGeneration,
        alive: () => socket.readyState === 1,
        send: (value) => secure.send(value),
        close: () => socket.terminate(),
    };
    socket.on("close", () => observers.release(connectionId));
    secure.send({
        event: "ready",
        apiVersion: "areal.remote.v2",
        hostId: remote.crypto.identityId(remote.config.identity),
        gatewayGeneration: remote.gatewayGeneration,
        connectionId,
        grantRevision: grant.revision,
        capabilities: CAPABILITIES.filter((value) => grant.capabilities.includes(value)),
        methods: METHODS,
        limits: LIMITS,
    });
    let windowStart = Date.now(),
        reads = 0,
        writeTokens = LIMITS.writeBurst,
        writeRefilledAt = windowStart;
    try {
        for await (const request of messages) {
            const active = currentGrant(remote, peer);
            if (!active || active.revision !== grant.revision) {
                secure.send(fail(request?.id, "GRANT_CHANGED", "授权已变化"));
                break;
            }
            if (Date.now() - windowStart >= 1000) {
                windowStart = Date.now();
                reads = 0;
            }
            if (++reads > LIMITS.readRequestsPerSecond) {
                secure.send(fail(request?.id, "LIMIT_EXCEEDED", "请求过于频繁"));
                continue;
            }
            if (COMMAND_METHODS.includes(request?.method)) {
                try {
                    if (typeof request.id !== "string" || !request.id || request.id.length > 64)
                        throw Object.assign(new Error("无效的请求标识"), {
                            code: "INVALID_PARAMS",
                        });
                    if (request.method !== "command.read") {
                        // 写预算属于当前连接；必须在 journal、观察准入和 Core 派发之前扣除。
                        const now = Date.now();
                        writeTokens = Math.min(
                            LIMITS.writeBurst,
                            writeTokens +
                                (Math.max(0, now - writeRefilledAt) *
                                    LIMITS.writeRequestsPerSecond) /
                                    1000,
                        );
                        writeRefilledAt = Math.max(writeRefilledAt, now);
                        if (writeTokens < 1)
                            throw Object.assign(new Error(COMMAND_ERRORS.LIMIT_EXCEEDED), {
                                code: "LIMIT_EXCEEDED",
                            });
                        writeTokens -= 1;
                    }
                    await sessionCommand(
                        remote,
                        connection,
                        request,
                        (result) => secure.send({ id: request.id, result }),
                        observers.admission.bind(observers),
                        observers.reviews,
                        observers.taskQuestions,
                    );
                } catch (error) {
                    const known = Object.hasOwn(COMMAND_ERRORS, error.code);
                    const code = known ? error.code : "CORE_UNAVAILABLE";
                    secure.send({
                        id: request.id,
                        error: {
                            code,
                            message: COMMAND_ERRORS[code],
                            ...(typeof error.code === "number" ? { coreCode: error.code } : {}),
                            commandId: request.commandId ?? request.params?.commandId,
                            submissionUnknown: !known || error.submissionUnknown === true,
                        },
                    });
                }
                continue;
            }
            if (
                !exact(request, ["id", "method", "context", "params"]) ||
                typeof request.id !== "string" ||
                request.id.length < 1 ||
                request.id.length > 64 ||
                typeof request.method !== "string" ||
                !exact(
                    request.params,
                    request.method === "review.read"
                        ? ["threadId", "turnId", "itemId", "cursor", "limit"]
                        : request.method === "artifact.read"
                          ? ["artifactRef", "offset", "length"]
                          : request.method === "task.read"
                            ? ["taskId", "runId"]
                            : request.method === "task.question.read"
                              ? ["taskId", "runId", "questionId"]
                              : request.method === "attention.read"
                                ? ["threadId", "turnId", "interactionId", "cursor"]
                                : request.method === "work.list"
                                  ? ["filter", "cursor", "limit"]
                                  : request.method === "session.open"
                                    ? ["threadId"]
                                    : request.method === "session.body"
                                      ? ["threadId", "turnId", "itemId", "cursor"]
                                    : request.method === "session.history"
                                      ? ["threadId", "cursor", "limit"]
                                      : request.method === "subscription.close"
                                        ? ["subscriptionId"]
                                        : ["cursor", "limit"],
                )
            ) {
                secure.send(fail(request?.id, "INVALID_PARAMS", "不支持的字段或方法"));
                continue;
            }
            if (
                [
                    "review.read",
                    "artifact.read",
                    "attention.read",
                    "task.question.read",
                    "task.read",
                ].includes(request.method)
            ) {
                try {
                    if (
                        !exact(request.context, ["projectId"]) ||
                        typeof request.context.projectId !== "string" ||
                        request.context.projectId.length > 128
                    )
                        throw Object.assign(new Error("无效的项目参数"), {
                            code: "INVALID_PARAMS",
                        });
                    await (
                        request.method === "artifact.read"
                            ? {
                                  read: observers.resultReviews.artifact.bind(
                                      observers.resultReviews,
                                  ),
                              }
                            : request.method === "review.read"
                              ? observers.resultReviews
                              : request.method === "task.read"
                                ? {
                                      read: observers.taskQuestions.pauseRead.bind(
                                          observers.taskQuestions,
                                      ),
                                  }
                                : request.method === "task.question.read"
                                  ? observers.taskQuestions
                                  : observers.reviews
                    ).read(connection, request.context.projectId, request.params, (result) =>
                        secure.send({ id: request.id, result }),
                    );
                } catch (error) {
                    const code = Object.hasOwn(COMMAND_ERRORS, error.code)
                        ? error.code
                        : "CORE_UNAVAILABLE";
                    secure.send(
                        fail(
                            request.id,
                            code,
                            ["review.read", "artifact.read"].includes(request.method)
                                ? "原结果或制品不可用，请重新读取或在桌面查看"
                                : COMMAND_ERRORS[code],
                        ),
                    );
                }
                continue;
            }
            if (SESSION_METHODS.includes(request.method)) {
                const params = request.params;
                const id =
                    request.method === "subscription.close"
                        ? params.subscriptionId
                        : params.threadId;
                if (
                    !exact(request.context, ["projectId"]) ||
                    typeof request.context.projectId !== "string" ||
                    typeof id !== "string" ||
                    id.length < 1 ||
                    id.length > 128 ||
                    (request.method === "session.body" && [params.turnId, params.itemId].some(value => typeof value !== "string" || !value.length || value.length > 128)) ||
                    (params.cursor !== undefined &&
                        (typeof params.cursor !== "string" || params.cursor.length > 1024)) ||
                    (params.limit !== undefined &&
                        (!Number.isInteger(params.limit) ||
                            params.limit < 1 ||
                            params.limit > LIMITS.sessionItems))
                ) {
                    secure.send(fail(request.id, "INVALID_PARAMS", "无效的会话参数"));
                    continue;
                }
                try {
                    const publish = (result) => secure.send({ id: request.id, result });
                    if (request.method === "session.open")
                        await observers.open(
                            connection,
                            request.context.projectId,
                            params.threadId,
                            publish,
                        );
                    else if (request.method === "session.body")
                        await observers.body(connection, request.context.projectId, params, publish);
                    else if (request.method === "session.history")
                        await observers.history(
                            connection,
                            request.context.projectId,
                            params,
                            publish,
                        );
                    else {
                        const viewer = observers.viewers.get(connectionId);
                        if (viewer && viewer.entry.projectId !== request.context.projectId)
                            throw Object.assign(new Error("详情不属于此项目"), {
                                code: "FORBIDDEN",
                            });
                        // 已离线的观察也可释放；关闭不启动 Core，也不更改执行状态。
                        if (!active.projectIds.includes(request.context.projectId))
                            throw Object.assign(new Error("此项目未获授权"), { code: "FORBIDDEN" });
                        publish({ closed: observers.release(connectionId, params.subscriptionId) });
                    }
                } catch (error) {
                    secure.send(fail(request.id, error.code ?? "CORE_UNAVAILABLE", request.method === "session.body" ? "正文读取失败，请重新读取或打开会话" : error.message));
                }
                continue;
            }
            if (request.method === "host.describe") {
                if (request.context !== undefined || Object.keys(request.params).length) {
                    secure.send(fail(request.id, "INVALID_PARAMS", "不支持的上下文"));
                    continue;
                }
                secure.send({
                    id: request.id,
                    result: {
                        hostId: remote.crypto.identityId(remote.config.identity),
                        apiVersion: "areal.remote.v2",
                        capabilities: CAPABILITIES.filter((value) =>
                            grant.capabilities.includes(value),
                        ),
                        methods: METHODS,
                        limits: LIMITS,
                    },
                });
                continue;
            }
            if (request.method === "work.list" || request.method === "attention.list") {
                const { cursor, limit = 30, filter } = request.params;
                if (
                    !exact(request.context, ["projectId"]) ||
                    typeof request.context.projectId !== "string" ||
                    !Number.isInteger(limit) ||
                    limit < 1 ||
                    limit > 100 ||
                    (cursor !== undefined &&
                        (typeof cursor !== "string" || cursor.length > 1024)) ||
                    (filter !== undefined && !["all", "active", "attention"].includes(filter))
                ) {
                    secure.send(fail(request.id, "INVALID_PARAMS", "无效的概览参数"));
                    continue;
                }
                try {
                    await readOverview(remote, peer, grant.revision, request, (result) => {
                        secure.send({ id: request.id, result });
                    });
                } catch (error) {
                    secure.send(fail(request.id, error.code ?? "CORE_UNAVAILABLE", error.message));
                }
                continue;
            }
            if (
                request.method !== "project.list" ||
                (request.context !== undefined &&
                    (!exact(request.context, ["projectId"]) ||
                        typeof request.context.projectId !== "string"))
            ) {
                secure.send(fail(request.id, "INVALID_PARAMS", "不支持的字段或方法"));
                continue;
            }
            if (
                request.context &&
                (!active.projectIds.includes(request.context.projectId) ||
                    !remote.backend.saved.some((value) => value.id === request.context.projectId))
            ) {
                secure.send(fail(request.id, "FORBIDDEN", "此项目未获授权"));
                continue;
            }
            const { cursor, limit = LIMITS.projectPageDefault } = request.params;
            if (
                !Number.isInteger(limit) ||
                limit < 1 ||
                limit > LIMITS.projectPageMaximum ||
                (cursor !== undefined &&
                    (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,5})$/.test(cursor)))
            ) {
                secure.send(fail(request.id, "INVALID_PARAMS", "无效的分页参数"));
                continue;
            }
            const offset = cursor === undefined ? 0 : Number(cursor);
            const all = projectViews(remote, active);
            if (offset > all.length) {
                secure.send(fail(request.id, "INVALID_PARAMS", "无效的分页位置"));
                continue;
            }
            const end = Math.min(all.length, offset + limit);
            secure.send({
                id: request.id,
                result: {
                    projects: all.slice(offset, end),
                    nextCursor: end < all.length ? String(end) : null,
                },
            });
        }
    } finally {
        observers.release(connectionId);
        secure.close();
    }
}

module.exports = { SessionAcceptor, LIMITS };
