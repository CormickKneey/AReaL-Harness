"use strict";
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const { snapshot, update, historyPage, constrain } = require("./remote-session-projection.cjs");
const { LIMITS: TASK_QUESTION_LIMITS } = require("./remote-task-questions.cjs");
const METHODS = ["session.open", "session.history", "subscription.close"];
const LIMITS = Object.freeze({
    observerConnections: 16,
    observerSubscriptions: 16,
    observerPendingRequests: 16,
    sessionItems: 100,
    sessionPreviewBytes: 1024,
    nativeHistoryBytes: 4 * 1024 * 1024,
});
const READ_METHODS = new Set([
    "areal/thread/observe",
    "thread/read",
    "areal/subscription/remove",
    "areal/interaction/list",
    "areal/task/read",
    "areal/channel/read",
]);
const failure = (code, message) => Object.assign(new Error(message), { code });

class SessionObservers {
    constructor(remote) {
        this.remote = remote;
        this.projects = new Map();
        this.viewers = new Map();
        this.closed = false;
        // 替换项目登记不一定产生 Thread 通知；周期检查只校验身份，不读取/启动 Core。
        this.timer = setInterval(() => this.sweep(), 1000);
        this.timer.unref?.();
    }
    authorize(connection, projectId) {
        const remote = this.remote;
        const grant = remote.config?.deviceGrants?.find(
            (v) => v.devicePeerId === connection.peer && v.status === "active",
        );
        if (
            this.closed ||
            remote.closed ||
            !connection.alive() ||
            connection.gatewayGeneration !== remote.gatewayGeneration
        )
            throw failure("RESYNC_REQUIRED", "连接已变化，请重新连接");
        if (!grant || grant.revision !== connection.grantRevision)
            throw failure("GRANT_CHANGED", "授权已变化，请重新连接");
        if (
            !grant.capabilities.includes("observe") ||
            !grant.projectIds.includes(projectId) ||
            !remote.backend.saved.some((v) => v.id === projectId)
        )
            throw failure("FORBIDDEN", "此项目未获授权");
        const project = remote.backend.projects?.get(projectId);
        if (
            remote.backend.closing ||
            !project?.client?.ready ||
            project.client.closed ||
            !project.model?.state?.connected ||
            project.resourceInitializing
        )
            throw failure("CORE_UNAVAILABLE", "项目 Core 当前不可用");
        if (
            !project.client.capabilities?.features?.atomicObserveOwnership ||
            !project.client.capabilities?.features?.atomicObserve ||
            !project.client.capabilities?.features?.subscriptionRemoval
        )
            throw failure("CORE_INCOMPATIBLE", "此 Core 不支持安全观察，请在桌面升级");
        return project;
    }
    current(entry) {
        const project = this.remote.backend.projects?.get(entry.projectId);
        return (
            !this.closed &&
            !entry.closed &&
            !this.remote.closed &&
            !this.remote.backend.closing &&
            this.remote.gatewayGeneration === entry.gatewayGeneration &&
            project === entry.project &&
            project.client === entry.desktop &&
            project.client?.ready &&
            !project.client.closed &&
            project.model?.state?.connected &&
            !project.resourceInitializing &&
            project.endpoint === entry.endpoint &&
            project.token === entry.token &&
            project.service?.serviceId === entry.serviceId &&
            project.service?.generation === entry.generation
        );
    }
    check(entry, viewer) {
        if (!this.current(entry))
            throw failure("RESYNC_REQUIRED", "项目连接已变化，请重新打开会话");
        if (viewer) {
            if (
                this.viewers.get(viewer.connection.connectionId) !== viewer ||
                !viewer.thread.viewers.has(viewer)
            )
                throw failure("RESYNC_REQUIRED", "详情已关闭");
            if (this.authorize(viewer.connection, entry.projectId) !== entry.project)
                throw failure("RESYNC_REQUIRED", "项目已变化");
        }
    }
    scope(entry, threadId) {
        return [entry.projectId, entry.serviceId, entry.generation, threadId];
    }
    keys(viewer) {
        return {
            connectionId: viewer.connection.connectionId,
            gatewayGeneration: viewer.entry.gatewayGeneration,
            projectId: viewer.entry.projectId,
            serviceGeneration: viewer.entry.generation,
            subscriptionId: viewer.id,
        };
    }
    publish(viewer, initial = false) {
        this.check(viewer.entry, viewer);
        if (!viewer.thread.state) return;
        const result = {
            ...this.keys(viewer),
            sequence: initial ? 0 : ++viewer.sequence,
            snapshot: viewer.thread.state,
        };
        // secure.send 同步序列化、入有界队列；不把可变投影交给稍后的异步写入。
        try {
            if (initial) {
                viewer.publish(result);
                viewer.published = true;
            } else viewer.connection.send({ event: "session.updated", ...result });
        } catch {
            this.release(viewer.connection.connectionId);
            viewer.connection.close();
            throw failure("RESYNC_REQUIRED", "设备发送缓冲已满，请重新连接");
        }
    }
    invalidate(entry, code = "RESYNC_REQUIRED") {
        if (entry.closed) return;
        entry.closed = true;
        if (this.projects.get(entry.projectId) === entry) this.projects.delete(entry.projectId);
        entry.offDesktop?.();
        entry.offModel?.();
        entry.offClose?.();
        entry.offEvents?.();
        const error = failure(
            code,
            code === "RESOURCE_UNAVAILABLE"
                ? "原生历史超过接收上限；请在桌面查看"
                : "观察连接已变化；请重新打开会话",
        );
        for (const thread of entry.threads.values())
            for (const viewer of thread.viewers) {
                if (this.viewers.get(viewer.connection.connectionId) === viewer)
                    this.viewers.delete(viewer.connection.connectionId);
                if (!viewer.published) continue;
                try {
                    viewer.connection.send({
                        event: "session.invalidated",
                        ...this.keys(viewer),
                        sequence: ++viewer.sequence,
                        error: { code: error.code, message: error.message },
                        history: { truncated: true, unavailable: true },
                    });
                } catch {
                    viewer.connection.close();
                }
            }
        entry.threads.clear();
        entry.client?.close();
        entry.client?.socket?.terminate?.();
    }
    sweep() {
        for (const entry of this.projects.values()) {
            if (!this.current(entry)) {
                this.invalidate(entry);
                continue;
            }
            for (const thread of entry.threads.values())
                for (const viewer of thread.viewers) {
                    try {
                        this.check(entry, viewer);
                    } catch {
                        this.release(viewer.connection.connectionId);
                    }
                }
        }
    }
    entry(connection, projectId) {
        const project = this.authorize(connection, projectId);
        let entry = this.projects.get(projectId);
        if (entry && !this.current(entry)) {
            this.invalidate(entry);
            entry = null;
        }
        if (entry) return entry;
        if (this.projects.size >= LIMITS.observerConnections)
            throw failure("LIMIT_EXCEEDED", "观察连接已达到上限");
        entry = {
            projectId,
            project,
            desktop: project.client,
            endpoint: project.endpoint,
            token: project.token,
            serviceId: project.service?.serviceId,
            generation: project.service?.generation,
            gatewayGeneration: this.remote.gatewayGeneration,
            threads: new Map(),
            pending: 0,
            readers: 0,
            tail: Promise.resolve(),
            closed: false,
        };
        if (
            typeof entry.serviceId !== "string" ||
            !entry.generation ||
            !entry.endpoint ||
            !entry.token
        )
            throw failure("CORE_UNAVAILABLE", "项目服务身份不可用");
        // 在异步加载/握手前占位；待建立的观察连接同样消耗容量。
        this.projects.set(projectId, entry);
        entry.offDesktop = entry.desktop.onClose(() => this.invalidate(entry));
        entry.offModel = project.model.subscribe(() => {
            if (!this.current(entry)) this.invalidate(entry);
        });
        entry.ready = this.connect(entry);
        entry.ready.catch(() => {});
        return entry;
    }
    async connect(entry) {
        try {
            const { CoreClient } = await import("@areal/runtime-client/core");
            this.check(entry);
            // 复用已验证的项目服务身份，但绝不覆盖 Desktop client 或注册工具回调。
            const client = (entry.client = new CoreClient({
                createSocket: () => {
                    const socket = new WebSocket(entry.endpoint, {
                        headers: { Authorization: `Bearer ${entry.token}` },
                        followRedirects: false,
                        maxPayload: LIMITS.nativeHistoryBytes,
                    });
                    socket.on("error", (error) => {
                        if (error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH")
                            entry.failureCode = "RESOURCE_UNAVAILABLE";
                    });
                    return socket;
                },
            }));
            entry.offEvents = client.onNotification((method, params) =>
                this.event(entry, method, params),
            );
            entry.offClose = client.onClose(() => this.invalidate(entry, entry.failureCode));
            await client.connect();
            this.check(entry);
            if (
                !client.capabilities?.features?.atomicObserveOwnership ||
                !client.capabilities?.features?.atomicObserve ||
                !client.capabilities?.features?.subscriptionRemoval
            )
                throw failure("CORE_INCOMPATIBLE", "此 Core 不支持安全观察");
        } catch (error) {
            this.invalidate(entry, entry.failureCode);
            throw error;
        }
    }
    enqueue(entry, work) {
        if (entry.pending >= LIMITS.observerPendingRequests)
            return Promise.reject(failure("LIMIT_EXCEEDED", "观察请求队列已满"));
        entry.pending++;
        const result = entry.tail.then(async () => {
            await entry.ready;
            this.check(entry);
            return work();
        });
        entry.tail = result
            .catch(() => {})
            .finally(() => {
                entry.pending--;
            });
        return result;
    }
    async rpc(entry, method, params, onResult) {
        if (!READ_METHODS.has(method)) throw new Error("Remote observer RPC is not read-only");
        this.check(entry);
        try {
            return await entry.client.request(method, params, {
                onResult: (result) => {
                    this.check(entry);
                    onResult?.(result);
                },
            });
        } catch (error) {
            // 超时未取消服务端观察；关闭专用连接，不能遗忘未知是否创建的订阅。
            if (
                entry.client.closed ||
                error.code === "RESPONSE_UNKNOWN" ||
                error.code === "DISCONNECTED"
            )
                this.invalidate(entry, entry.failureCode);
            throw failure(
                entry.failureCode ??
                    (["areal/task/read", "areal/channel/read"].includes(method) &&
                    [-32004, -32009].includes(error.code)
                        ? "TARGET_CHANGED"
                        : error.code === -32602
                          ? "INVALID_PARAMS"
                          : ["RESYNC_REQUIRED", "CORE_INCOMPATIBLE"].includes(error.code)
                            ? error.code
                            : "CORE_UNAVAILABLE"),
                "会话读取不可用；请重新打开或在桌面查看",
            );
        }
    }
    baseline(entry, thread, result) {
        this.check(entry);
        if (result.thread?.id !== thread.id) throw failure("RESYNC_REQUIRED", "会话身份不匹配");
        if (!["ordinary", "task"].includes(result.ownership?.kind))
            throw failure("CORE_INCOMPATIBLE", "Core 未返回原子会话归属");
        thread.state = snapshot(result.thread, this.scope(entry, thread.id), result.ownership);
        constrain(thread.state, this.scope(entry, thread.id));
    }
    refresh(entry, thread) {
        if (thread.refreshQueued) return;
        thread.refreshQueued = true;
        void this.enqueue(entry, async () => {
            thread.refreshQueued = false;
            if (!thread.viewers.size || entry.threads.get(thread.id) !== thread) return;
            await this.rpc(entry, "areal/thread/observe", { threadId: thread.id }, (result) => {
                this.baseline(entry, thread, result);
                for (const viewer of [...thread.viewers]) {
                    if (!viewer.published) continue;
                    try {
                        this.publish(viewer);
                    } catch {
                        this.release(viewer.connection.connectionId);
                    }
                }
            });
        }).catch(() => this.invalidate(entry));
    }
    event(entry, method, params) {
        if (!this.current(entry)) {
            this.invalidate(entry);
            return;
        }
        const threadId = params?.threadId ?? params?.interaction?.threadId;
        const thread = entry.threads.get(threadId);
        if (!thread?.state) return;
        try {
            // 归属由 Core 的原子观察返回；Task-only 变化由显式刷新重新取样。
            if (
                [
                    "turn/started",
                    "turn/completed",
                    "areal/thread/configured",
                    "areal/goal/updated",
                    "areal/goal/cleared",
                ].includes(method)
            )
                this.refresh(entry, thread);
            if (!update(thread.state, method, params, this.scope(entry, threadId))) return;
            for (const viewer of [...thread.viewers]) {
                if (!viewer.published) continue;
                try {
                    this.publish(viewer);
                } catch {
                    this.release(viewer.connection.connectionId);
                }
            }
        } catch {
            this.invalidate(entry);
        }
    }
    async open(connection, projectId, threadId, publish) {
        this.authorize(connection, projectId);
        this.release(connection.connectionId);
        const entry = this.entry(connection, projectId);
        let thread = entry.threads.get(threadId);
        if (!thread) {
            const count = [...this.projects.values()].reduce(
                (n, value) => n + value.threads.size,
                0,
            );
            if (count >= LIMITS.observerSubscriptions) {
                if (!entry.threads.size) this.invalidate(entry);
                throw failure("LIMIT_EXCEEDED", "观察订阅已达到上限");
            }
            thread = { id: threadId, viewers: new Set(), state: null };
            entry.threads.set(threadId, thread);
        }
        const viewer = {
            id: randomUUID(),
            connection,
            entry,
            thread,
            publish,
            sequence: 0,
            published: false,
        };
        thread.viewers.add(viewer);
        this.viewers.set(connection.connectionId, viewer);
        try {
            await this.enqueue(entry, async () => {
                this.check(entry, viewer);
                await this.rpc(entry, "areal/thread/observe", { threadId }, (result) => {
                    this.check(entry, viewer);
                    this.baseline(entry, thread, result);
                    // 同栈建立并发布快照；CoreClient 随后的通知只能发生在此基线之后。
                    this.publish(viewer, true);
                    for (const other of [...thread.viewers]) {
                        if (other === viewer || !other.published) continue;
                        try {
                            this.publish(other);
                        } catch {
                            this.release(other.connection.connectionId);
                        }
                    }
                });
            });
        } catch (error) {
            if (this.viewers.get(connection.connectionId) === viewer)
                this.release(connection.connectionId);
            throw error;
        }
    }
    async admission(connection, projectId, threadId) {
        // 临时引用复用同一个有界只读连接；不能改动 Desktop 的订阅或工具宿主。
        const temporary = { ...connection, connectionId: randomUUID(), send() {} };
        let state;
        try {
            await this.open(temporary, projectId, threadId, (value) => {
                state = value.snapshot;
            });
            this.authorize(connection, projectId);
            return state;
        } finally {
            this.release(temporary.connectionId);
        }
    }
    async interactions(connection, projectId, threadId, publish) {
        const project = this.authorize(connection, projectId);
        if (!project.client.capabilities?.methods?.includes("areal/interaction/list"))
            throw failure("CORE_INCOMPATIBLE", "Core 不支持交互读取");
        const entry = this.entry(connection, projectId);
        entry.readers++;
        try {
            return await this.enqueue(entry, async () => {
                this.authorize(connection, projectId);
                const result = await this.rpc(entry, "areal/interaction/list", { threadId });
                // await 后在同一栈验证身份并发布；临时读取不替换前台 Session viewer。
                this.check(entry);
                if (this.authorize(connection, projectId) !== entry.project)
                    throw failure("RESYNC_REQUIRED", "项目已变化");
                if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.nativeHistoryBytes)
                    throw failure("RESOURCE_UNAVAILABLE", "原生交互超过读取上限");
                return publish(result, entry);
            });
        } finally {
            entry.readers--;
            if (!entry.readers && ![...entry.threads.values()].some((value) => value.viewers.size))
                this.invalidate(entry);
        }
    }
    async taskQuestion(connection, projectId, params, publish) {
        const project = this.authorize(connection, projectId);
        if (
            !["areal/task/read", ...(params.questionId ? ["areal/channel/read"] : [])].every(
                (method) => project.client.capabilities?.methods?.includes(method),
            )
        )
            throw failure("CORE_INCOMPATIBLE", "Core 不支持 Task 问题读取");
        const entry = this.entry(connection, projectId);
        entry.readers++;
        try {
            return await this.enqueue(entry, async () => {
                const check = () => {
                    this.check(entry);
                    if (this.authorize(connection, projectId) !== entry.project)
                        throw failure("RESYNC_REQUIRED", "项目已变化");
                };
                check();
                const task = await this.rpc(entry, "areal/task/read", { taskId: params.taskId });
                check();
                if (Buffer.byteLength(JSON.stringify(task)) > LIMITS.nativeHistoryBytes)
                    throw failure("RESOURCE_UNAVAILABLE", "Task 超过读取上限");
                if (
                    task.id !== params.taskId ||
                    (params.runId && !task.runs?.some((run) => run.id === params.runId))
                )
                    throw failure("TARGET_CHANGED", "原 Task Run 已不存在");
                if (!params.questionId) return publish({ task, complete: true }, entry);
                let afterSequence = 0,
                    item,
                    complete = false,
                    bytes = 0;
                // 有界读取独立 Channel；不打开、订阅或恢复协调 Session。
                for (let page = 0; page < TASK_QUESTION_LIMITS.taskQuestionPages; page++) {
                    const result = await this.rpc(entry, "areal/channel/read", {
                        taskId: params.taskId,
                        afterSequence,
                        limit: 100,
                    });
                    check();
                    bytes += Buffer.byteLength(JSON.stringify(result));
                    if (bytes > LIMITS.nativeHistoryBytes) break;
                    if (
                        result.taskId !== params.taskId ||
                        !Array.isArray(result.data) ||
                        result.data.length > 100
                    )
                        throw failure("TARGET_CHANGED", "Channel 身份或分页无效");
                    item = result.data.find(
                        (value) =>
                            value.id === params.questionId &&
                            value.runId === params.runId &&
                            value.kind === "question",
                    );
                    if (item) {
                        complete = true;
                        break;
                    }
                    if (!result.hasMore) {
                        complete = true;
                        break;
                    }
                    if (
                        !Number.isSafeInteger(result.nextSequence) ||
                        result.nextSequence <= afterSequence
                    )
                        break;
                    afterSequence = result.nextSequence;
                }
                check();
                return publish({ task, item, complete }, entry);
            });
        } finally {
            entry.readers--;
            if (!entry.readers && ![...entry.threads.values()].some((value) => value.viewers.size))
                this.invalidate(entry);
        }
    }
    async reviewThread(connection, projectId, threadId, work) {
        const entry = this.entry(connection, projectId);
        entry.readers++;
        try {
            return await this.enqueue(entry, async () => {
                const check = () => {
                    this.check(entry);
                    if (this.authorize(connection, projectId) !== entry.project)
                        throw failure("RESYNC_REQUIRED", "项目已变化");
                };
                const read = async () => {
                    check();
                    const result = await this.rpc(entry, "thread/read", {
                        threadId,
                        includeTurns: true,
                    });
                    check();
                    if (
                        result.thread?.id !== threadId ||
                        Buffer.byteLength(JSON.stringify(result)) > LIMITS.nativeHistoryBytes
                    )
                        throw failure("RESOURCE_UNAVAILABLE", "原历史不可用或超过读取上限");
                    return result.thread;
                };
                const thread = await read();
                check();
                return await work(thread, entry, check, read);
            });
        } finally {
            entry.readers--;
            if (!entry.readers && ![...entry.threads.values()].some((value) => value.viewers.size))
                this.invalidate(entry);
        }
    }
    async history(connection, projectId, params, publish) {
        const viewer = this.viewers.get(connection.connectionId);
        if (
            !viewer ||
            viewer.entry.projectId !== projectId ||
            viewer.thread.id !== params.threadId ||
            !viewer.published
        )
            throw failure("INVALID_PARAMS", "请先打开此会话");
        const entry = viewer.entry;
        await this.enqueue(entry, async () => {
            this.check(entry, viewer);
            await this.rpc(
                entry,
                "thread/read",
                { threadId: params.threadId, includeTurns: true },
                (result) => {
                    this.check(entry, viewer);
                    if (result.thread?.id !== params.threadId)
                        throw failure("RESYNC_REQUIRED", "会话身份不匹配");
                    const page = historyPage(
                        result.thread,
                        this.scope(entry, params.threadId),
                        params.cursor,
                        params.limit ?? 100,
                    );
                    publish({ ...this.keys(viewer), threadId: params.threadId, ...page });
                },
            );
        });
    }
    release(connectionId, subscriptionId) {
        const viewer = this.viewers.get(connectionId);
        if (!viewer || (subscriptionId !== undefined && viewer.id !== subscriptionId)) return false;
        this.viewers.delete(connectionId);
        const { entry, thread } = viewer;
        thread.viewers.delete(viewer);
        if (entry.closed || thread.viewers.size) return true;
        if (!entry.readers && ![...entry.threads.values()].some((value) => value.viewers.size)) {
            this.invalidate(entry);
            return true;
        }
        void this.enqueue(entry, async () => {
            if (thread.viewers.size || entry.threads.get(thread.id) !== thread) return;
            thread.state = null;
            await this.rpc(entry, "areal/subscription/remove", { threadIds: [thread.id] });
            this.check(entry);
            if (!thread.viewers.size && entry.threads.get(thread.id) === thread)
                entry.threads.delete(thread.id);
        }).catch(() => this.invalidate(entry));
        return true;
    }
    close() {
        if (this.closed) return;
        clearInterval(this.timer);
        for (const entry of this.projects.values()) this.invalidate(entry);
        this.closed = true;
    }
}
module.exports = { SessionObservers, METHODS, LIMITS };
