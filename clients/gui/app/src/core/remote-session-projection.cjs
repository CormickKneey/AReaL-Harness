"use strict";
const { createHash } = require("node:crypto");
// Remote 仅保留可丢弃、有界的显示投影；完整历史与工具执行始终归 Core。
const ITEM_LIMIT = 100,
    TEXT_BYTES = 1024,
    PAGE_BYTES = 192 * 1024;
const pick = (value, keys) =>
    Object.fromEntries(
        keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
    );
function preview(parts, maximum = TEXT_BYTES) {
    let text = "",
        bytes = 0,
        used = 0;
    for (const part of parts) {
        if (typeof part !== "string") continue;
        const size = Buffer.byteLength(part);
        bytes += size;
        if (used < maximum) {
            const fragment = new TextDecoder().decode(
                Buffer.from(part).subarray(0, maximum - used),
                { stream: true },
            );
            text += fragment;
            used += Buffer.byteLength(fragment);
            // UTF-8 边界不足时也不从后续片段补入字符，以保持原文前缀。
            if (size > Buffer.byteLength(fragment)) used = maximum;
        }
    }
    return {
        preview: text,
        textBytes: bytes,
        truncated: bytes > maximum,
        bodyDetail:
            bytes > maximum
                ? { state: "unavailable", reason: "desktopRequired" }
                : { state: "inline" },
    };
}
function itemView(item) {
    if (!item || item.type === "modelContext") return null;
    const value = pick(item, ["id", "type", "phase", "status", "success"]);
    let parts = [];
    if (item.type === "agentMessage") parts = [item.text];
    else if (item.type === "userMessage")
        parts = (item.content ?? []).filter((v) => v.type === "text").map((v) => v.text);
    else if (item.type === "reasoning") parts = [...(item.summary ?? []), ...(item.content ?? [])];
    else if (item.type === "dynamicToolCall") {
        value.tool = preview([item.tool], 200).preview;
        value.executionOutcome = item.execution?.outcome ?? null;
        parts = (item.contentItems ?? [])
            .filter((v) => v.type === "inputText" || v.type === "text")
            .map((v) => v.text);
    }
    Object.assign(value, preview(parts));
    const body = publicBody(item);
    if (body) {
        const encoded = JSON.stringify(body);
        if (Buffer.byteLength(encoded) <= 512) value.body = body;
        value.bodyDetail = value.body
            ? { state: "inline" }
            : { state: "available", revision: createHash("sha256").update(encoded).digest("hex") };
    }
    if (
        item.type === "agentMedia" ||
        (item.type === "userMessage" && (item.content ?? []).some((v) => v.type !== "text")) ||
        (item.type === "dynamicToolCall" &&
            (item.contentItems ?? []).some((v) => v.type !== "inputText" && v.type !== "text"))
    ) {
        value.mediaUnavailable = true;
        if (!body) value.bodyDetail = { state: "unavailable", reason: "mediaRequiresDesktop" };
        value.truncated = true;
    }
    return value;
}
// Only public conversation fields; no modelContext, credentials, configuration,
// instruction snapshots, hook payloads or arbitrary native object passthrough.
function publicBody(item) {
    const body = pick(item, ["id", "type"]);
    if (item.type === "agentMessage") body.text = item.text ?? "";
    else if (item.type === "userMessage")
        body.content = (item.content ?? []).filter(v => v.type === "text").map(v => pick(v, ["type", "text"]));
    else if (item.type === "reasoning") {
        body.summary = item.summary ?? [];
        body.content = item.content ?? [];
    } else if (item.type === "dynamicToolCall") {
        Object.assign(body, pick(item, ["tool", "arguments", "status", "success"]));
        body.contentItems = (item.contentItems ?? []).filter(v => ["inputText", "text"].includes(v.type)).map(v => pick(v, ["type", "text"]));
        body.execution = pick(item.execution, ["outcome", "exitCode", "startedAt", "completedAt", "durationMs"]);
    } else return null;
    return body;
}
function turnView(turn, items) {
    return {
        ...pick(turn, ["id", "status", "startedAt", "completedAt", "durationMs"]),
        // Shared GUI Messages uses Core's origin, never the input wording, to
        // distinguish scheduler continuations from user-authored messages.
        ...(turn.goal ? { goal: pick(turn.goal, ["origin", "sequence"]) } : {}),
        items,
    };
}
function queueView(queue) {
    return {
        pendingCount: (queue?.items ?? []).filter((v) => v.status === "pending").length,
        paused: queue?.paused === true,
        revision: queue?.revision ?? 0,
        complete: (queue?.items ?? []).length <= 128,
        items: (queue?.items ?? []).filter(v => v.status === "pending").slice(0,128).map(item => {
            const body = preview((item.input ?? []).filter(part => part.type === "text").map(part => part.text));
            return { ...pick(item, ["id", "status"]), input: [{type:"text", text:body.preview}], truncated:body.truncated,
                hasAttachments:(item.input ?? []).some(part => part.type !== "text") };
        }),
    };
}
function interactionView(item) {
    if (item.status !== "pending") return null;
    return {
        attentionRef: `${item.kind === "approval" ? "approval" : "syncQuestion"}:${item.threadId}:${item.requestId}`,
        kind: item.kind === "approval" ? "approval" : "syncQuestion",
        threadId: item.threadId,
        turnId: item.turnId,
        interactionId: item.requestId,
        status: item.status,
        expiresAt: item.expiresAt,
        summary:
            item.kind === "approval"
                ? "Tool approval required"
                : preview([item.questions?.[0]?.title ?? "Question requires an answer"], 256)
                      .preview,
    };
}
function unknownAttention(thread) {
    const refs = [];
    for (const turn of thread.turns ?? [])
        for (const item of turn.items ?? []) {
            if (
                item.type === "dynamicToolCall" &&
                !item.execution?.inspection &&
                (item.execution?.outcome === "unknown" ||
                    item.execution?.hooks?.some((hook) => hook.outcome === "unknown"))
            )
                refs.push({
                    attentionRef: `executionUnknown:${thread.id}:${item.id}`,
                    kind: "executionUnknown",
                    threadId: thread.id,
                    turnId: turn.id,
                    itemId: item.id,
                    status: "pending",
                    summary: "Tool outcome is unknown; inspect on desktop",
                });
        }
    for (const receipt of thread.desktop?.receipts ?? [])
        if (receipt.status === "unknown")
            refs.push({
                attentionRef: `submissionUnknown:${thread.id}:${receipt.requestId}`,
                kind: "submissionUnknown",
                threadId: thread.id,
                status: "pending",
                summary: "Submission outcome is unknown",
            });
    return refs;
}
function historyCursor(scope, itemId) {
    return Buffer.from(JSON.stringify([...scope, itemId])).toString("base64url");
}
function historyPage(thread, scope, cursor, limit = ITEM_LIMIT) {
    const rows = [];
    for (const turn of thread.turns ?? [])
        for (const item of turn.items ?? [])
            if (item.type !== "modelContext") rows.push({ turn, item });
    let end = rows.length;
    if (cursor !== undefined) {
        let decoded;
        try {
            decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        } catch {
            /* 统一返回过期游标。 */
        }
        if (
            !Array.isArray(decoded) ||
            decoded.length !== scope.length + 1 ||
            scope.some((value, at) => decoded[at] !== value)
        )
            throw Object.assign(new Error("历史游标已失效，请重新打开会话"), {
                code: "RESYNC_REQUIRED",
            });
        end = rows.findIndex((value) => value.item.id === decoded.at(-1));
        if (end < 0)
            throw Object.assign(new Error("历史范围已变化，请重新打开会话"), {
                code: "RESYNC_REQUIRED",
            });
    }
    const start = Math.max(0, end - limit),
        turns = [];
    for (const { turn, item } of rows.slice(start, end)) {
        let target = turns.at(-1);
        if (target?.id !== turn.id) {
            target = turnView(turn, []);
            turns.push(target);
        }
        const value = itemView(item);
        if (value.bodyDetail.state === "unavailable")
            Object.assign(value.bodyDetail, {
                threadId: thread.id,
                turnId: turn.id,
                itemId: item.id,
            });
        target.items.push(value);
    }
    return {
        turns,
        nextCursor: start ? historyCursor(scope, rows[start].item.id) : null,
        hasMore: start > 0,
        truncated: Boolean(thread.historyArchive),
        unavailable: Boolean(thread.historyArchive),
        range: "coreAccessible",
    };
}
function configurationView(config) {
    if (!config) return null;
    return { ...pick(config,["revision","readOnly"]), model:config.model == null ? null : pick(config.model,["providerId","modelId"]), parameters:pick(config.parameters,["reasoningEffort"]),
      profile:config.profile == null ? null : pick(config.profile,["id","revision","readOnly"]), options:pick(config.options,["readOnly","appendInstructions","approvalTools","preapprovedTools"]) };
}
function goalView(state) {
    if (!state) return {revision:0,eventSequence:0,goal:null};
    const goal=state.goal;
    return {revision:state.revision,eventSequence:state.eventSequence,goal:goal?{...pick(goal,["id","status","reason","settling","waitingForInput","waitingForAgents","waitingForCapacity","limits","usage"]),objective:preview([goal.objective],4096).preview}:null};
}
function snapshot(thread, scope, ownership) {
    const page = historyPage(thread, scope);
    // 无正文的活动 Turn 也必须可见，不能把它当作空闲。
    for (const turn of (thread.turns ?? []).slice(-ITEM_LIMIT))
        if (!turn.items?.length && !page.turns.some((v) => v.id === turn.id))
            page.turns.push(turnView(turn, []));
    const refs = [
        ...(thread.desktop?.interactions ?? []).map(interactionView).filter(Boolean),
        ...unknownAttention(thread),
    ];
    return {
        threadId: thread.id,
        title: preview([thread.preview], 512).preview,
        configRevision: thread.desktop?.configuration?.revision ?? null,
        configuration: configurationView(thread.desktop?.configuration),
        goals: goalView(thread.goals),
        goalControlAllowed: !thread.parentThreadId && !thread.goalOwner && thread.source !== "nativeTaskAgent",
        ownership: pick(ownership, ["kind", "taskId", "runId"]),
        activeTurnId:
            [...(thread.turns ?? [])].reverse().find((v) => v.status === "inProgress")?.id ?? null,
        status: thread.status?.type ?? "unavailable",
        turns: page.turns.slice(-ITEM_LIMIT),
        attentionRefs: refs.slice(0, 32),
        attentionComplete: refs.length <= 32,
        queue: queueView(thread.desktop?.queue),
        history: { ...page, turns: undefined },
    };
}
function constrain(state, scope) {
    let remaining = ITEM_LIMIT,
        removed = false;
    for (let at = state.turns.length - 1; at >= 0; at--) {
        const turn = state.turns[at];
        for (const item of turn.items)
            if (item.bodyDetail?.state === "unavailable")
                Object.assign(item.bodyDetail, {
                    threadId: state.threadId,
                    turnId: turn.id,
                    itemId: item.id,
                });
        if (turn.items.length > remaining) {
            turn.items = remaining ? turn.items.slice(-remaining) : [];
            removed = true;
        }
        if (!remaining && turn.items.length) {
            state.turns.splice(at, 1);
            removed = true;
            continue;
        }
        remaining -= turn.items.length;
    }
    if (state.turns.length > ITEM_LIMIT) {
        state.turns = state.turns.slice(-ITEM_LIMIT);
        removed = true;
    }
    if (removed) {
        const first = state.turns.find((turn) => turn.items.length)?.items[0];
        state.history = {
            ...state.history,
            hasMore: Boolean(first),
            nextCursor: first ? historyCursor(scope, first.id) : null,
        };
    }
    if (Buffer.byteLength(JSON.stringify(state)) > PAGE_BYTES)
        throw new Error("Session projection exceeds display budget");
}
function update(state, method, params, scope) {
    if (method === "areal/thread/configured") {
        state.configRevision = params.configuration?.revision ?? state.configRevision;
        state.configuration = configurationView(params.configuration);
        return true;
    }
    if (method === "areal/queue/updated") {
        state.queue = queueView(params.queue);
        return true;
    }
    if (method.startsWith("areal/interaction/")) {
        const item = params.interaction;
        if (!item) return false;
        state.attentionRefs = state.attentionRefs.filter((v) => v.interactionId !== item.requestId);
        const ref = interactionView(item);
        if (ref) state.attentionRefs.push(ref);
        if (state.attentionRefs.length > 32) {
            state.attentionRefs = state.attentionRefs.slice(-32);
            state.attentionComplete = false;
        }
        return true;
    }
    if (method === "areal/model/completionDiscarded") {
        const ids = new Set(params.itemIds ?? []);
        for (const turn of state.turns) turn.items = turn.items.filter((item) => !ids.has(item.id));
        return true;
    }
    if (method === "turn/started" || method === "turn/completed") {
        const turn = params.turn,
            value = turnView(turn, (turn.items ?? []).map(itemView).filter(Boolean));
        const at = state.turns.findIndex((v) => v.id === turn.id);
        if (at < 0) state.turns.push(value);
        else state.turns[at] = value;
        state.activeTurnId =
            [...state.turns].reverse().find((v) => v.status === "inProgress")?.id ?? null;
        state.status = state.activeTurnId ? "active" : "idle";
        const refs = unknownAttention({ id: state.threadId, turns: [turn] });
        state.attentionRefs = [
            ...state.attentionRefs.filter(
                (v) => v.kind !== "executionUnknown" || v.turnId !== turn.id,
            ),
            ...refs,
        ].slice(-32);
    } else {
        if (
            ![
                "item/started",
                "item/completed",
                "areal/item/agentMedia/available",
                "item/agentMessage/delta",
                "item/reasoning/textDelta",
                "item/reasoning/summaryTextDelta",
            ].includes(method)
        )
            return false;
        let turn = state.turns.find((v) => v.id === params.turnId);
        if (!turn) {
            turn = { id: params.turnId, status: "inProgress", items: [] };
            state.turns.push(turn);
        }
        if (params.item) {
            const value = itemView(params.item);
            if (!value) return false;
            const at = turn.items.findIndex((v) => v.id === value.id);
            if (at < 0) turn.items.push(value);
            else turn.items[at] = value;
        } else {
            let item = turn.items.find((v) => v.id === params.itemId);
            if (!item) {
                item = itemView({
                    id: params.itemId,
                    type: method.startsWith("item/reasoning/") ? "reasoning" : "agentMessage",
                    text: "",
                });
                turn.items.push(item);
            }
            const total = item.textBytes + Buffer.byteLength(params.delta ?? "");
            // 截断后不追加后续片段，避免 UTF-8 边界空隙被更晚的字符填入。
            if (!item.truncated) Object.assign(item, preview([item.preview, params.delta]));
            item.textBytes = total;
            item.truncated = total > TEXT_BYTES;
            if (item.truncated)
                item.bodyDetail = { state: "available", revision: `stream:${total}` };
            item.body = !item.truncated ? publicBody(item.type === "reasoning"
                ? { ...item, summary: [item.preview], content: [] }
                : { ...item, text: item.preview }) : undefined;
        }
    }
    constrain(state, scope);
    return true;
}
module.exports = { snapshot, update, historyPage, constrain, publicBody, PAGE_BYTES, ITEM_LIMIT, TEXT_BYTES };
