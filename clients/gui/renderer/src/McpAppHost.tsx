import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
    McpUiHostContext,
    McpUiHostCapabilities,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
    JSONRPCMessage,
    CallToolResult,
    ReadResourceResult,
    ListToolsResult,
    ListResourcesResult,
    ListResourceTemplatesResult,
    ContentBlock,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { McpAppIcon } from "./McpAppIcon.js";

export type McpAppDescriptor = {
    token: string;
    frameUrl: string;
    instanceId: string;
    serverId: string;
    generation: string | number;
    projectId: string;
    threadId: string;
    toolMetadata?: {
        name?: string;
        title?: string;
        annotations?: { title?: string };
        icons?: { src: string }[];
    };
    initialArguments: Record<string, unknown>;
    initialResult?: CallToolResult;
    hostContext: McpUiHostContext;
    resourceMeta?: Record<string, unknown>;
    fileResource?: boolean;
};
export type McpAppMessage = {
    instanceId: string;
    projectId: string;
    threadId: string;
    content: ContentBlock[];
    target: "active" | "new";
    send: boolean;
};
export type McpAppModelContext = {
    instanceId: string;
    projectId: string;
    threadId: string;
    content?: ContentBlock[];
    structuredContent?: Record<string, unknown>;
};
export type McpAppDesktop = {
    onMcpAppDeepLink(
        listener: (link: {
            id: number;
            pluginId: string;
            marketplace?: string;
            toolName: string;
            path: string;
        }) => Promise<void> | void,
    ): () => void;
    mcpApp(request: Record<string, unknown>): Promise<unknown>;
    onMcpAppEvent(
        listener: (event: { token: string; notification: JSONRPCMessage }) => void,
    ): () => void;
};
export function mcpAppDesktop(): McpAppDesktop {
    return (window as unknown as { arealDesktop: McpAppDesktop }).arealDesktop;
}
export async function openMcpApp(request: {
    projectId: string;
    threadId: string;
    serverId: string;
    expectedGeneration: string | number;
    toolName: string;
    arguments?: Record<string, unknown>;
    deepLink?: string;
    filePath?: string;
}): Promise<McpAppDescriptor> {
    return (await mcpAppDesktop().mcpApp({ operation: "open", ...request })) as McpAppDescriptor;
}
/** Source-bound SDK transport with a stricter initialization gate than MCP's generic transport. */
class AppTransport extends PostMessageTransport {
    ready = false;
    initialized = false;
    private initializing = false;
    private requests = new Map<string, { fingerprint: string; reply?: JSONRPCMessage }>();
    private receive?: (message: JSONRPCMessage) => void;
    override async start() {
        this.receive = this.onmessage;
        this.onmessage = (message) => {
            if ("method" in message && "id" in message) {
                const key = JSON.stringify(message.id),
                    fingerprint = JSON.stringify(message),
                    previous = this.requests.get(key);
                if (previous) {
                    if (previous.fingerprint !== fingerprint)
                        void super.send({
                            jsonrpc: "2.0",
                            id: message.id,
                            error: { code: -32600, message: "Request ID reused" },
                        });
                    else if (previous.reply) void super.send(previous.reply);
                    return;
                }
                if (this.requests.size >= 512) {
                    void super.send({
                        jsonrpc: "2.0",
                        id: message.id,
                        error: { code: -32000, message: "Request limit reached; reopen the app" },
                    });
                    return;
                }
                this.requests.set(key, { fingerprint });
            }
            if ("method" in message) {
                const method = message.method;
                if (method === "ui/notifications/initialized") {
                    if (!this.ready || this.initialized) return;
                    this.initialized = true;
                } else if (method === "ui/initialize") {
                    if (this.initializing || this.ready || this.initialized) return;
                    this.initializing = true;
                } else if (method !== "ui/notifications/sandbox-proxy-ready" && !this.initialized) {
                    if ("id" in message)
                        void this.send({
                            jsonrpc: "2.0",
                            id: message.id,
                            error: { code: -32000, message: "App is not initialized" },
                        });
                    return;
                }
            }
            this.receive?.(message);
        };
        await super.start();
    }
    override async send(message: JSONRPCMessage) {
        if (!("method" in message) && "id" in message) {
            const request = this.requests.get(JSON.stringify(message.id));
            if (request) request.reply = message;
        }
        if (
            "result" in message &&
            typeof message.result === "object" &&
            message.result !== null &&
            "protocolVersion" in message.result
        )
            this.ready = true;
        await super.send(message);
    }
}
const modalities = { text: {}, image: {}, resourceLink: {}, resource: {}, structuredContent: {} };
function messageOptions(params: unknown) {
    const raw = (params as { _meta?: Record<string, unknown> })._meta?.["openai/message"];
    if (raw === undefined) return { target: "active" as const, send: true };
    const parsed = z
        .object({ target: z.enum(["active", "new"]).optional(), send: z.boolean().optional() })
        .strict()
        .parse(raw);
    return { target: parsed.target ?? "active", send: parsed.send ?? true };
}
function supported(content: ContentBlock[] | undefined) {
    if (
        content?.some(
            (block) => !["text", "image", "resource_link", "resource"].includes(block.type),
        )
    )
        throw Error("Unsupported app content");
}
export function McpAppHost({
    app,
    onMessage,
    onModelContext,
    onClose,
    onError,
    context,
    closeOnUnmount = true,
}: {
    app: McpAppDescriptor;
    onMessage?: (message: McpAppMessage) => Promise<void>;
    onModelContext?: (context: McpAppModelContext) => Promise<void>;
    onClose: () => void;
    onError?: (message: string) => void;
    /** Complete current Core-owned context, including null openai/modelContext after removal. */
    context?: McpUiHostContext;
    closeOnUnmount?: boolean;
}) {
    const frame = useRef<HTMLIFrameElement>(null),
        bridgeRef = useRef<AppBridge | null>(null),
        contextRef = useRef<McpUiHostContext>(app.hostContext),
        initializedRef = useRef(false);
    const callbacks = useRef({ onMessage, onModelContext, onClose, onError });
    callbacks.current = { onMessage, onModelContext, onClose, onError };
    const [mode, setMode] = useState<"inline" | "fullscreen">(
            app.hostContext.displayMode === "fullscreen" ? "fullscreen" : "inline",
        ),
        [failure, setFailure] = useState("");
    useEffect(() => {
        const target = frame.current?.contentWindow;
        if (!target) return;
        let active = true,
            sequence = 0;
        const mountId = crypto.randomUUID();
        const desktop = mcpAppDesktop(),
            transport = new AppTransport(target, target);
        const error = (cause: unknown) => {
            if (active) {
                setFailure("应用请求失败，请关闭后重新打开。");
                callbacks.current.onError?.(
                    cause instanceof Error ? cause.message : "App request failed",
                );
            }
        };
        const capabilities: McpUiHostCapabilities = {
            serverTools: {},
            serverResources: {},
            sandbox: { permissions: {} },
            experimental: {
                "openai/files": {},
                ...(app.fileResource ? { "openai/resource": {} } : {}),
            },
        };
        if (callbacks.current.onMessage) {
            capabilities.message = modalities;
            capabilities.experimental!["openai/message"] = {};
        }
        if (callbacks.current.onModelContext) {
            capabilities.updateModelContext = modalities;
            capabilities.experimental!["openai/modelContext"] = {};
        }
        const bridge = new AppBridge(
            null,
            { name: "AReaL Harness", version: "0.1.8" },
            capabilities,
            { hostContext: app.hostContext },
        );
        bridgeRef.current = bridge;
        async function request(method: string, params: unknown): Promise<Record<string, unknown>> {
            if (!active) throw Error("App is closed");
            const reply = (await desktop.mcpApp({
                operation: "request",
                token: app.token,
                request: { jsonrpc: "2.0", id: `${mountId}:${++sequence}`, method, params },
            })) as {
                result?: Record<string, unknown>;
                error?: { message?: string };
                notifications?: JSONRPCMessage[];
            };
            if (!active) throw Error("App is closed");
            if (reply.error) throw Error("App request was rejected or could not be completed");
            for (const notification of reply.notifications ?? [])
                await transport.send(notification);
            return reply.result ?? {};
        }
        bridge.oncalltool = async (params, extra) =>
            (await request("tools/call", {
                ...params,
                _meta: extra.mcpReq._meta,
            })) as CallToolResult;
        bridge.setRequestHandler(
            "tools/list",
            { params: z.record(z.string(), z.unknown()).optional() },
            async (params) => (await request("tools/list", params ?? {})) as ListToolsResult,
        );
        bridge.onreadresource = async (params, extra) =>
            (await request("resources/read", {
                ...params,
                _meta: extra.mcpReq._meta,
            })) as ReadResourceResult;
        bridge.onlistresources = async (params) =>
            (await request("resources/list", params ?? {})) as ListResourcesResult;
        bridge.onlistresourcetemplates = async (params) =>
            (await request(
                "resources/templates/list",
                params ?? {},
            )) as ListResourceTemplatesResult;
        bridge.onmessage = async (params, extra) => {
            supported(params.content);
            if (!callbacks.current.onMessage) throw Error("Messaging unavailable");
            const options = messageOptions({ _meta: extra.mcpReq._meta });
            await request("ui/host-authorize", { method: "ui/message" });
            await callbacks.current.onMessage({
                instanceId: app.instanceId,
                projectId: app.projectId,
                threadId: app.threadId,
                content: params.content,
                ...options,
            });
            return {};
        };
        bridge.onupdatemodelcontext = async (params) => {
            supported(params.content);
            if (!callbacks.current.onModelContext) throw Error("Model context unavailable");
            await request("ui/update-model-context", params);
            await callbacks.current.onModelContext({
                instanceId: app.instanceId,
                projectId: app.projectId,
                threadId: app.threadId,
                content: params.content,
                structuredContent: params.structuredContent,
            });
            contextRef.current = { ...contextRef.current, "openai/modelContext": params };
            bridge.setHostContext(contextRef.current);
            return {};
        };
        bridge.onrequestdisplaymode = async ({ mode: requested }) => {
            if (
                (requested !== "inline" && requested !== "fullscreen") ||
                !app.hostContext.availableDisplayModes?.includes(requested)
            )
                return { mode: contextRef.current.displayMode ?? "inline" };
            const declared = bridge.getAppCapabilities()?.availableDisplayModes;
            if (declared && !declared.includes(requested))
                throw Error("Display mode not supported by app");
            setMode(requested);
            contextRef.current = { ...contextRef.current, displayMode: requested };
            bridge.setHostContext(contextRef.current);
            return { mode: requested };
        };
        bridge.onsandboxready = () => {
            void bridge.sendSandboxResourceReady({ html: "" }).catch(error);
        };
        bridge.oninitialized = () => {
            initializedRef.current = true;
            void (async () => {
                const declared = bridge.getAppCapabilities()?.availableDisplayModes;
                const available = (
                    app.hostContext.availableDisplayModes ?? ["inline", "fullscreen"]
                ).filter((mode) => !declared || declared.includes(mode));
                if (!available.length) {
                    callbacks.current.onClose();
                    return;
                }
                if (!available.includes(contextRef.current.displayMode ?? "inline")) {
                    const next = available[0] === "fullscreen" ? "fullscreen" : "inline";
                    setMode(next);
                    contextRef.current = { ...contextRef.current, displayMode: next };
                }
                bridge.setHostContext(contextRef.current);
                await bridge.sendToolInput({ arguments: app.initialArguments });
                if (app.initialResult) await bridge.sendToolResult(app.initialResult);
            })().catch(error);
        };
        bridge.onrequestteardown = () => callbacks.current.onClose();
        for (const method of [
            "resources/subscribe",
            "resources/unsubscribe",
            "openai/resources/write",
            "openai/files/open",
        ] as const) {
            bridge.setRequestHandler(
                method,
                { params: z.record(z.string(), z.unknown()) },
                async (params, extra) =>
                    await request(method, { ...params, _meta: extra.mcpReq._meta }),
            );
        }
        const unsubscribe = desktop.onMcpAppEvent((event) => {
            if (active && event.token === app.token && transport.initialized)
                void transport.send(event.notification).catch(error);
        });
        void bridge
            .connect(transport)
            .then(() => {
                if (active && frame.current) frame.current.src = app.frameUrl;
            })
            .catch(error);
        return () => {
            active = false;
            initializedRef.current = false;
            unsubscribe();
            bridgeRef.current = null;
            // Revoke immediately; teardown responses cannot authorize new effects.
            if (closeOnUnmount) void desktop.mcpApp({ operation: "close", token: app.token }).catch(() => {});
            void bridge
                .teardownResource({}, { timeout: 1000 })
                .catch(() => {})
                .finally(() => bridge.close());
        };
    }, [app.token]);
    useEffect(() => {
        contextRef.current = { ...(context ?? contextRef.current), displayMode: mode };
        if (initializedRef.current) bridgeRef.current?.setHostContext(contextRef.current);
    }, [context, mode]);
    return (
        <section
            aria-label="MCP 应用"
            style={
                mode === "fullscreen"
                    ? {
                          position: "fixed",
                          inset: 0,
                          zIndex: 60,
                          background: "var(--color-background, #202020)",
                          display: "flex",
                          flexDirection: "column",
                      }
                    : { height: "100%", minHeight: 360, display: "flex", flexDirection: "column" }
            }
        >
            <header style={{ display: "flex", alignItems: "center", gap: 12, padding: 10 }}>
                <McpAppIcon icon={app.toolMetadata?.icons?.[0]} />
                <strong style={{ flex: 1 }}>
                    {app.toolMetadata?.title ??
                        app.toolMetadata?.annotations?.title ??
                        app.toolMetadata?.name ??
                        "MCP 应用"}
                </strong>
                {mode === "fullscreen" &&
                    app.hostContext.availableDisplayModes?.includes("inline") && (
                        <button
                            onClick={() => {
                                setMode("inline");
                                const bridge = bridgeRef.current;
                                bridge?.setHostContext({
                                    ...contextRef.current,
                                    displayMode: "inline",
                                });
                            }}
                        >
                            退出全屏
                        </button>
                    )}
                <button onClick={onClose} aria-label="关闭应用">
                    关闭
                </button>
            </header>
            {failure && <p role="alert">{failure}</p>}
            <iframe
                ref={frame}
                title={app.toolMetadata?.title ?? "MCP 应用"}
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                style={{ border: 0, flex: 1, width: "100%", minHeight: 300 }}
            />
        </section>
    );
}
