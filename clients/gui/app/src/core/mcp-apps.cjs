"use strict";
const { randomUUID, randomBytes } = require("node:crypto");
const { authorizeFile, fileRequest } = require("./mcp-apps-files.cjs");
const METHODS = new Set([
    "tools/call",
    "tools/list",
    "resources/read",
    "resources/list",
    "resources/templates/list",
    "resources/subscribe",
    "resources/unsubscribe",
    "ui/update-model-context",
    "ui/host-authorize",
    "openai/resources/write",
    "openai/files/open",
]);
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function domains(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) throw Error("Invalid app CSP");
    return value.map((domain) => {
        if (
            typeof domain !== "string" ||
            !/^https?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?$|^wss:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(
                domain,
            )
        )
            throw Error("Invalid app CSP domain");
        return domain;
    });
}
function appCsp(csp = {}) {
    if (!object(csp)) throw Error("Invalid app CSP");
    const network = domains(csp.connectDomains),
        assets = domains(csp.resourceDomains),
        frames = domains(csp.frameDomains),
        base = domains(csp.baseUriDomains);
    return `default-src 'none'; script-src 'unsafe-inline' ${assets.join(" ")}; style-src 'unsafe-inline' ${assets.join(" ")}; img-src data: blob: ${assets.join(" ")}; font-src data: ${assets.join(" ")}; media-src blob: data: ${assets.join(" ")}; connect-src ${network.join(" ") || "'none'"}; frame-src ${frames.join(" ") || "'none'"}; base-uri ${base.join(" ") || "'none'"}; object-src 'none'; form-action 'none'; worker-src 'none'`;
}
function parseDeepLink(raw) {
    const url = new URL(raw);
    if (
        !["codex:", "areal:"].includes(url.protocol) ||
        url.host !== "plugins" ||
        url.hash ||
        url.username ||
        url.password
    )
        throw Error("Invalid app deep link");
    const parts = url.pathname.split("/");
    if (parts.length !== 4 || parts[2] !== "app" || !parts[1] || !parts[3])
        throw Error("Invalid app deep link");
    const path = url.searchParams.get("path") ?? "/";
    if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("#") ||
        path.includes("\\") ||
        /[\x00-\x1f]/.test(path)
    )
        throw Error("Invalid app-relative URL");
    const split = parts[1].lastIndexOf("@");
    const pluginId = decodeURIComponent(split < 0 ? parts[1] : parts[1].slice(0, split));
    const marketplace = split < 0 ? undefined : decodeURIComponent(parts[1].slice(split + 1));
    if (!pluginId || marketplace === "") throw Error("Invalid app deep link");
    return {
        pluginId,
        ...(marketplace ? { marketplace } : {}),
        toolName: decodeURIComponent(parts[3]),
        path,
    };
}
function proxyHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style></head><body><iframe id="view" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe><script>
const view=document.getElementById('view'); let loaded=false;
addEventListener('message',event=>{
 const message=event.data;
 if(!message||message.jsonrpc!=='2.0')return;
 if(event.source===parent){
  if(message.method==='ui/notifications/sandbox-resource-ready'){
   if(loaded)return; loaded=true;view.src='view';return;
  }
  if(!String(message.method||'').startsWith('ui/notifications/sandbox-'))view.contentWindow.postMessage(message,'*');
 }else if(event.source===view.contentWindow&&!String(message.method||'').startsWith('ui/notifications/sandbox-'))parent.postMessage(message,'areal-ui://app');
});
parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'},'areal-ui://app');
</script></body></html>`;
}
class McpAppsHost {
    constructor({ backend, ownerId, notify = () => {}, openFile }) {
        this.backend = backend;
        this.ownerId = ownerId;
        this.notify = notify;
        this.openFile = openFile;
        this.instances = new Map();
        this.epoch = 0;
    }
    get(token, ownerId) {
        const app = this.instances.get(token);
        if (
            ownerId !== (typeof this.ownerId === "function" ? this.ownerId() : this.ownerId) ||
            !app ||
            app.closed ||
            !this.backend.ownsThread(app.projectId, app.threadId)
        )
            throw Error("App is closed or stale");
        return app;
    }
    async open(params, ownerId) {
        if (
            ownerId !== (typeof this.ownerId === "function" ? this.ownerId() : this.ownerId) ||
            !object(params) ||
            !["projectId", "threadId", "serverId", "toolName"].every((k) => text(params[k])) ||
            !["string", "number"].includes(typeof params.expectedGeneration) ||
            !this.backend.ownsThread(params.projectId, params.threadId)
        )
            throw Error("Invalid app owner");
        const epoch = this.epoch;
        const file =
            params.filePath === undefined
                ? null
                : await authorizeFile(this.backend, params.projectId, params.filePath);
        const initialArguments = file
            ? { file: { name: file.name, resourceUri: file.uri } }
            : (params.arguments ?? {});
        if (!object(initialArguments)) throw Error("Invalid app arguments");
        const result = await this.backend.command("manage", {
            operation: "mcpAppOpen",
            projectId: params.projectId,
            threadId: params.threadId,
            serverId: params.serverId,
            expectedGeneration: params.expectedGeneration,
            toolName: params.toolName,
            arguments: initialArguments,
            requestId: randomUUID(),
            ...(file ? { fileResource: { uri: file.uri, path: file.path } } : {}),
        });
        const closeInvalid = async () => {
            if (result?.instanceId)
                await this.backend
                    .command("manage", {
                        operation: "mcpAppClose",
                        projectId: params.projectId,
                        threadId: params.threadId,
                        instanceId: result.instanceId,
                        generation: result.generation,
                    })
                    .catch(() => {});
        };
        if (
            epoch !== this.epoch ||
            !this.backend.ownsThread(params.projectId, params.threadId) ||
            !text(result?.instanceId) ||
            result.serverId !== params.serverId ||
            result.generation !== params.expectedGeneration ||
            typeof result.resource?.html !== "string" ||
            result.resource.html.length > 8 * 1024 * 1024 ||
            result.resource.mimeType !== "text/html;profile=mcp-app"
        ) {
            await closeInvalid();
            throw Error("App resource is invalid or stale");
        }
        let csp;
        try {
            csp = appCsp(result.resource._meta?.ui?.csp ?? {});
        } catch (error) {
            await closeInvalid();
            throw error;
        }
        const token = randomBytes(24).toString("hex");
        const app = {
            ...result,
            projectId: params.projectId,
            threadId: params.threadId,
            token,
            csp,
            file,
            closed: false,
            requests: new Map(),
            abort: new AbortController(),
        };
        this.instances.set(token, app);
        const declared = result.resource._meta?.["openai/ui"]?.availableDisplayModes;
        if (
            declared !== undefined &&
            (!Array.isArray(declared) ||
                declared.some((mode) => !["inline", "fullscreen", "pip"].includes(mode)))
        ) {
            await this.close(token, ownerId);
            throw Error("Invalid app display modes");
        }
        const availableDisplayModes = ["inline", "fullscreen"].filter(
            (mode) => declared === undefined || declared.includes(mode),
        );
        if (!availableDisplayModes.length) {
            await this.close(token, ownerId);
            throw Error("No supported app display mode");
        }
        const hostContext = {
            ...result.hostContext,
            displayMode: availableDisplayModes[0],
            availableDisplayModes,
        };
        if (params.deepLink !== undefined) {
            if (
                !text(params.deepLink) ||
                !params.deepLink.startsWith("/") ||
                params.deepLink.startsWith("//") ||
                /[#\\\x00-\x1f]/.test(params.deepLink)
            ) {
                await this.close(token, ownerId);
                throw Error("Invalid deep link");
            }
            hostContext["openai/deepLink"] = { url: params.deepLink };
        }
        return {
            token,
            frameUrl: `areal-mcp://${token}/`,
            instanceId: app.instanceId,
            serverId: app.serverId,
            generation: app.generation,
            projectId: app.projectId,
            threadId: app.threadId,
            toolMetadata: app.toolMetadata,
            initialArguments: app.initialArguments ?? initialArguments,
            initialResult: app.initialResult,
            hostContext,
            resourceMeta: result.resource._meta ?? {},
            fileResource: !!file,
        };
    }
    async request(token, request, ownerId) {
        const app = this.get(token, ownerId);
        if (
            !object(request) ||
            request.jsonrpc !== "2.0" ||
            !METHODS.has(request.method) ||
            !["string", "number"].includes(typeof request.id) ||
            (request.params !== undefined && !object(request.params)) ||
            JSON.stringify(request).length > 12 * 1024 * 1024
        )
            throw Error("Invalid or unsupported app request");
        const key = JSON.stringify(request.id),
            fingerprint = JSON.stringify(request),
            previous = app.requests.get(key);
        if (previous) {
            if (previous.fingerprint !== fingerprint)
                throw Error("App request ID was reused with different content");
            return previous.promise;
        }
        if (app.requests.size >= 512) throw Error("App request budget exhausted; reopen this app");
        let rejectClosed;
        const closed = new Promise((_resolve, reject) => {
            rejectClosed = () => reject(Error("App is closed or stale"));
            app.abort.signal.addEventListener("abort", rejectClosed, { once: true });
        });
        const promise = Promise.race([
            this.performRequest(token, request, ownerId),
            closed,
        ]).finally(() => app.abort.signal.removeEventListener("abort", rejectClosed));
        app.requests.set(key, { fingerprint, promise });
        return promise;
    }
    async performRequest(token, request, ownerId) {
        const app = this.get(token, ownerId);
        if (
            !object(request) ||
            request.jsonrpc !== "2.0" ||
            !METHODS.has(request.method) ||
            !["string", "number"].includes(typeof request.id) ||
            (request.params !== undefined && !object(request.params)) ||
            JSON.stringify(request).length > 12 * 1024 * 1024
        )
            throw Error("Invalid or unsupported app request");
        const current = () => {
            if (this.get(token, ownerId) !== app) throw Error("App is stale");
        };
        const local =
            request.method === "openai/files/open" ||
            request.method === "openai/resources/write" ||
            (typeof request.params?.uri === "string" &&
                request.params.uri.startsWith("areal-file:"));
        if (local) {
            const authorization = await this.backend.command("manage", {
                operation: "mcpAppRequest",
                projectId: app.projectId,
                threadId: app.threadId,
                instanceId: app.instanceId,
                generation: app.generation,
                request: {
                    jsonrpc: "2.0",
                    id: request.id,
                    method: "ui/host-authorize",
                    params: { method: request.method },
                },
                requestId: randomUUID(),
            });
            current();
            if (!authorization || authorization.error || !Object.hasOwn(authorization, "result"))
                throw Error("App authorization is stale or unavailable");
        }
        let result;
        if (request.method === "openai/files/open") {
            if (!this.openFile || !text(request.params?.path))
                throw Error("File opening unavailable");
            await this.openFile(
                { projectId: app.projectId, path: request.params.path, operation: "open" },
                current,
            );
            result = {};
        } else if (
            request.params?.uri?.startsWith("areal-file:") ||
            request.method === "openai/resources/write"
        ) {
            // This ID is created once inside the request receipt cache, so repeated
            // app JSON-RPC IDs observe the original Core effect rather than replaying it.
            const fileRequestId = randomUUID();
            result = await fileRequest(
                app.file, request, current,
                (notification) => this.notify({ token, notification }),
                (originalRequest) => this.backend.command("manage", {
                    operation: "mcpAppRequest",
                    projectId: app.projectId,
                    threadId: app.threadId,
                    instanceId: app.instanceId,
                    generation: app.generation,
                    request: {
                        jsonrpc: "2.0",
                        id: originalRequest.id,
                        method: "ui/host-file",
                        params: { request: originalRequest },
                    },
                    requestId: fileRequestId,
                }),
            );
        } else {
            const value = await this.backend.command("manage", {
                operation: "mcpAppRequest",
                projectId: app.projectId,
                threadId: app.threadId,
                instanceId: app.instanceId,
                generation: app.generation,
                request,
                requestId: randomUUID(),
            });
            current();
            return value;
        }
        current();
        return { jsonrpc: "2.0", id: request.id, result };
    }
    async close(token, ownerId) {
        const app = this.instances.get(token);
        if (!app) return {};
        if (ownerId !== (typeof this.ownerId === "function" ? this.ownerId() : this.ownerId))
            throw Error("Invalid app owner");
        app.closed = true;
        app.abort.abort();
        this.instances.delete(token);
        app.file?.watcher?.close();
        app.requests.clear();
        return this.backend.command("manage", {
            operation: "mcpAppClose",
            projectId: app.projectId,
            threadId: app.threadId,
            instanceId: app.instanceId,
            generation: app.generation,
        });
    }
    notification(event) {
        if (
            !object(event) ||
            !object(event.notification) ||
            event.notification.jsonrpc !== "2.0" ||
            event.notification.id !== undefined ||
            ![
                "notifications/resources/updated",
                "notifications/tools/list_changed",
                "notifications/resources/list_changed",
                "ui/notifications/host-context-changed",
            ].includes(event.notification.method)
        )
            return false;
        for (const [token, app] of this.instances) {
            if (
                app.projectId === event.projectId &&
                app.threadId === event.threadId &&
                app.instanceId === event.instanceId &&
                app.generation === event.generation &&
                !app.closed &&
                this.backend.ownsThread(app.projectId, app.threadId)
            ) {
                this.notify({ token, notification: event.notification });
                return true;
            }
        }
        return false;
    }
    revokeInvalid() {
        for (const [token, app] of this.instances)
            if (!this.backend.ownsThread(app.projectId, app.threadId))
                void this.close(
                    token,
                    typeof this.ownerId === "function" ? this.ownerId() : this.ownerId,
                ).catch(() => {});
    }
    dispose() {
        this.epoch++;
        for (const token of this.instances.keys())
            void this.close(
                token,
                typeof this.ownerId === "function" ? this.ownerId() : this.ownerId,
            ).catch(() => {});
    }
    async resource(request) {
        const url = new URL(request.url),
            app = this.instances.get(url.host);
        if (
            request.method !== "GET" ||
            !app ||
            app.closed ||
            !["/", "/view"].includes(url.pathname) ||
            url.search ||
            url.hash ||
            !this.backend.ownsThread(app.projectId, app.threadId)
        )
            return new Response("Not found", { status: 404 });
        const proxy = url.pathname === "/";
        return new Response(proxy ? proxyHtml() : app.resource.html, {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Permissions-Policy":
                    "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
                "Content-Security-Policy": proxy
                    ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'"
                    : app.csp,
            },
        });
    }
}
module.exports = { McpAppsHost, appCsp, parseDeepLink };
