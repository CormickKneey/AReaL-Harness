"use strict";

const { readFile, readdir } = require("node:fs/promises");
const { join } = require("node:path");
const WebSocket = require("ws");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function coreEndpoint(state, endpoints) {
    const launchHome = join(state, "launcher-state");
    const entries = await readdir(launchHome, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(".run-")) continue;
        try {
            const endpoint = (await readFile(join(launchHome, entry.name, "ready"), "utf8")).trim();
            // 仅连接旧后台仍持有的本机 Core，避免误用遗留的 launcher 文件。
            if (/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint) && endpoints.includes(endpoint))
                return endpoint;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    throw new Error("找不到旧 Core 的管理连接");
}

async function coreDrainCancel(home, projectId, endpoints) {
    if (!/^[a-f0-9]{24}$/.test(projectId)) throw new Error("旧后台项目标识无效");
    const state = join(home, projectId, "state");
    const endpoint = await coreEndpoint(state, endpoints);
    const auth = JSON.parse(await readFile(join(state, "security", "auth.json"), "utf8"));
    const token = auth.principals?.find((principal) =>
        principal.permissions?.includes("manage"),
    )?.token;
    if (typeof token !== "string" || !token) throw new Error("旧 Core 未提供管理凭据");
    const { CoreClient } = await import("@areal/runtime-client/core");
    const client = new CoreClient({
        createSocket: () =>
            new WebSocket(endpoint, {
                headers: { Authorization: `Bearer ${token}` },
                followRedirects: false,
                maxPayload: 4 * 1024 * 1024,
            }),
    });
    try {
        await client.connect();
        await client.request(
            "areal/server/drain",
            { strategy: "cancel", timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
        );
    } finally {
        client.close();
    }
}

// 仅用于缺少 cancelStop 能力的旧后台；凭据留在可信 Main，不传给 Renderer。
async function cancelLegacyService({ connection, home }) {
    const { service } = await connection.request("snapshot");
    if (service.clients > 1) throw new Error("请先退出其他连接此后台服务的 GUI");
    if (service.activeCommands || service.providerUpdating || service.starting)
        throw new Error("请等待后台操作完成后重试");
    const projects = await connection.request("resources", { operation: "inspect" });
    if (!projects.length) throw new Error("旧后台没有可取消的 Core 项目");
    for (const project of projects)
        await coreDrainCancel(home, project.projectId, service.browserControlEndpoints ?? []);
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
        const { service: current } = await connection.request("snapshot");
        if (current.clients > 1) throw new Error("请先退出其他连接此后台服务的 GUI");
        if (
            !current.busy &&
            current.activeCommands === 0 &&
            !current.providerUpdating &&
            current.starting === 0
        )
            return;
        await sleep(200);
    }
    throw new Error("取消已发送，但旧后台尚未完成收尾");
}

module.exports = { cancelLegacyService };
