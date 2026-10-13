"use strict";
const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const LIMITS = Object.freeze({
    interactionPageBytes: 16 * 1024,
    interactionQuestions: 8,
    interactionAnswerBytes: 4096,
});
const failure = (code, message) => Object.assign(new Error(message), { code });
const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
function target(params) {
    if (
        ["threadId", "turnId", "interactionId"].some(
            (key) =>
                typeof params?.[key] !== "string" ||
                !params[key] ||
                Buffer.byteLength(params[key]) > 128,
        )
    )
        throw failure("INVALID_PARAMS", "缺少原交互身份");
    return {
        threadId: params.threadId,
        turnId: params.turnId,
        interactionId: params.interactionId,
    };
}
function content(item) {
    return {
        tool: item.tool ?? null,
        generation: item.generation ?? null,
        effectiveArguments: item.effectiveArguments ?? null,
        effectivePermissions: item.effectivePermissions ?? null,
        questions: item.questions ?? [],
    };
}
class InteractionReviews {
    constructor(observers) {
        this.observers = observers;
        // 仅本 Gateway 生命周期内的审阅游标签名；不保存正文、审批权限或第二套提交账本。
        this.key = randomBytes(32);
    }
    seal(scope, offset) {
        const body = Buffer.from(JSON.stringify([scope, offset])).toString("base64url");
        return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
    }
    open(token, scope) {
        try {
            if (typeof token !== "string" || token.length > 2048) throw new Error();
            const [body, mac, extra] = token.split(".");
            const actual = Buffer.from(mac, "base64url"),
                expected = createHmac("sha256", this.key).update(body).digest();
            if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected))
                throw new Error();
            const [saved, offset] = JSON.parse(Buffer.from(body, "base64url"));
            if (saved !== scope || !Number.isSafeInteger(offset) || offset < 0) throw new Error();
            return offset;
        } catch {
            throw failure("TARGET_CHANGED", "审阅内容或连接已变化，请重新打开原交互");
        }
    }
    scope(connection, entry, item, body) {
        return createHash("sha256")
            .update(
                JSON.stringify([
                    connection.peer,
                    connection.connectionId,
                    connection.grantRevision,
                    entry.gatewayGeneration,
                    entry.projectId,
                    entry.serviceId,
                    entry.generation,
                    item.threadId,
                    item.turnId,
                    item.requestId,
                    item.kind,
                    item.argumentsDigest,
                    item.expiresAt,
                    body,
                ]),
            )
            .digest("hex");
    }
    lookup(result, params) {
        target(params);
        const item = result.data?.find(
            (item) =>
                item.threadId === params.threadId &&
                item.turnId === params.turnId &&
                item.requestId === params.interactionId,
        );
        if (!item || !["approval", "question"].includes(item.kind))
            throw failure("TARGET_CHANGED", "原交互已不存在");
        return item;
    }
    async prepare(connection, projectId, params) {
        // 拒绝不依赖正文完整可读；Core 对调用方给出的原标识和 digest 做最终原子校验。
        if (params.decision === "deny") return this.nativeParams(params);
        if (!params.reviewToken) throw failure("REVIEW_INCOMPLETE", "请完整审阅原交互后提交");
        return this.observers.interactions(
            connection,
            projectId,
            params.threadId,
            (result, entry) => {
                const item = this.lookup(result, params);
                if (item.status !== "pending" || Math.floor(Date.now() / 1000) >= item.expiresAt)
                    throw failure("TARGET_CHANGED", "原交互已结束或过期");
                const body = JSON.stringify(content(item));
                if (
                    this.open(params.reviewToken, this.scope(connection, entry, item, body)) !==
                    Buffer.byteLength(body)
                )
                    throw failure("REVIEW_INCOMPLETE", "请完整审阅原交互后提交");
                if (item.kind === "approval") {
                    if (
                        params.decision !== "allowOnce" ||
                        params.argumentsDigest !== item.argumentsDigest
                    )
                        throw failure("TARGET_CHANGED", "审批摘要已变化");
                } else {
                    const questions = item.questions;
                    if (
                        params.decision !== undefined ||
                        params.argumentsDigest !== undefined ||
                        !Array.isArray(questions) ||
                        !questions.length ||
                        questions.length > LIMITS.interactionQuestions ||
                        !exact(
                            params.answers,
                            questions.map((q) => q.id),
                        ) ||
                        Object.keys(params.answers).length !== questions.length ||
                        questions.some(
                            (q) =>
                                !Object.hasOwn(params.answers, q.id) ||
                                typeof params.answers[q.id] !== "string" ||
                                Buffer.byteLength(params.answers[q.id]) >
                                    LIMITS.interactionAnswerBytes ||
                                (!q.allowFreeText && !q.options.includes(params.answers[q.id])),
                        )
                    )
                        throw failure("INVALID_PARAMS", "答案必须匹配 Core 的题目和选项");
                }
                return this.nativeParams(params);
            },
        );
    }
    nativeParams(params) {
        return {
            threadId: params.threadId,
            turnId: params.turnId,
            requestId: params.interactionId,
            ...(params.decision !== undefined
                ? { decision: params.decision, argumentsDigest: params.argumentsDigest }
                : { answers: structuredClone(params.answers) }),
        };
    }
    async observe(connection, projectId, params) {
        return this.observers.interactions(connection, projectId, params.threadId, (result) => {
            const item = this.lookup(result, params);
            return {
                source: "interaction.read",
                status: item.status,
                expiresAt: item.expiresAt,
                ...target(params),
                provesCommandAdmission: false,
            };
        });
    }
    async read(connection, projectId, params, publish) {
        if (!exact(params, ["threadId", "turnId", "interactionId", "cursor"]))
            throw failure("INVALID_PARAMS", "无效的交互读取参数");
        target(params);
        return this.observers.interactions(
            connection,
            projectId,
            params.threadId,
            (result, entry) => {
                const item = this.lookup(result, params),
                    review = content(item);
                const body = Buffer.from(JSON.stringify(review)),
                    scope = this.scope(connection, entry, item, body.toString());
                const offset = params.cursor === undefined ? 0 : this.open(params.cursor, scope);
                if (offset >= body.length && offset !== 0)
                    throw failure("INVALID_PARAMS", "无效的审阅页");
                let end = Math.min(offset + LIMITS.interactionPageBytes, body.length);
                // 页边界不能拆开 UTF-8 字符；JSON 转义后最坏仍低于应用消息上限。
                while (end < body.length && (body[end] & 0xc0) === 0x80) end--;
                const complete = end === body.length;
                const value = {
                    projectId,
                    serviceGeneration: entry.generation,
                    ...target(params),
                    kind: item.kind === "question" ? "syncQuestion" : "approval",
                    status: item.status,
                    expiresAt: item.expiresAt,
                    argumentsDigest: item.argumentsDigest ?? null,
                    review: {
                        encoding: "json-utf8",
                        offset,
                        totalBytes: body.length,
                        chunk: body.subarray(offset, end).toString(),
                    },
                    ...(complete && offset === 0 ? review : {}),
                    complete,
                    nextCursor: complete ? null : this.seal(scope, end),
                    reviewToken: complete ? this.seal(scope, body.length) : null,
                };
                return publish(value);
            },
        );
    }
}
function validateResponse(params) {
    target(params);
    if (
        params.reviewToken !== undefined &&
        (typeof params.reviewToken !== "string" || params.reviewToken.length > 2048)
    )
        throw failure("INVALID_PARAMS", "无效的审阅凭据");
    if (params.decision !== undefined) {
        if (
            !["allowOnce", "deny"].includes(params.decision) ||
            params.answers !== undefined ||
            typeof params.argumentsDigest !== "string" ||
            !/^[a-f0-9]{64}$/i.test(params.argumentsDigest)
        )
            throw failure("INVALID_PARAMS", "远程审批仅支持本次允许或拒绝");
    } else if (
        params.argumentsDigest !== undefined ||
        !exact(params.answers, Object.keys(params.answers ?? {})) ||
        Object.keys(params.answers).length < 1 ||
        Object.keys(params.answers).length > LIMITS.interactionQuestions ||
        Object.values(params.answers).some(
            (answer) =>
                typeof answer !== "string" ||
                Buffer.byteLength(answer) > LIMITS.interactionAnswerBytes,
        )
    )
        throw failure("INVALID_PARAMS", "答案超过题目或 UTF-8 字节预算");
}
module.exports = { InteractionReviews, LIMITS, validateResponse };
