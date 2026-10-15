import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
    McpAppHost,
    mcpAppDesktop,
    openMcpApp,
    type McpAppDescriptor,
    type McpAppMessage,
    type McpAppModelContext,
} from "./McpAppHost.js";
import { McpAppForm, type McpFormResponse, type McpFormResource } from "./McpAppForm.js";
import { McpContentLabel } from "./McpComposerAttachments.js";
import { appendMcpDraft } from "./mcp-app-draft.js";
import { sending, markSending, submitMessage } from "./Composer.js";
import {
    McpAppEntrypoints,
    McpAppsSettings,
    McpAppsMentions,
    toolTitle,
    type McpAppServer,
    type McpAppTool,
} from "./settings/McpAppsSettings.js";
import type { Action, Data } from "./services.js";
export type McpWorkspaceServer = McpAppServer & { pluginId?: string; marketplace?: string; installedDigest?: string };
type FormRequest = {
    requestId: string;
    threadId: string;
    serverId: string;
    generation: string | number;
    instanceId?: string;
    message: string;
    requestedSchema: unknown;
};
type FormResourceRequest = { projectId: string; threadId: string; requestId: string; fieldName: string; uri?: string };
function formResource(operation: "pick" | "release", request: FormResourceRequest): Promise<{ resources?: McpFormResource[] }> {
    const desktop = (window as unknown as { arealDesktop?: {
        mcpFormResource?: (operation: string, request: FormResourceRequest) => Promise<{ resources?: McpFormResource[] }>;
    } }).arealDesktop;
    if (!desktop?.mcpFormResource) return Promise.reject(new Error("本机资源选择不可用"));
    return desktop.mcpFormResource(operation, request);
}
const appTab = (app: McpAppDescriptor) => `mcp-app:${app.instanceId}`;
const visible = (block: ContentBlock) =>
    !(block.annotations?.audience?.length === 1 && block.annotations.audience[0] === "assistant");
function entrypoint(tool: McpAppTool, kind: string) {
    const value = tool._meta?.["openai/ui"] as { entrypoints?: { type?: string }[] } | undefined;
    return value?.entrypoints?.some((entry) => entry.type === kind) === true;
}
export function useMcpAppsWorkspace({
    project,
    threadId,
    action,
    onOpenThread,
    onReveal,
    onRemoveTab,
    onError,
}: {
    project?: Data;
    threadId: string;
    action: Action;
    onOpenThread: (projectId: string, threadId: string) => Promise<void>;
    onReveal: (tab: string, owner: { projectId: string; threadId: string }) => void;
    onRemoveTab: (tab: string) => void;
    onError: (message: string) => void;
}) {
    const [servers, setServers] = useState<McpWorkspaceServer[]>([]),
        [loading, setLoading] = useState(false),
        [error, setError] = useState("");
    const [apps, setApps] = useState<McpAppDescriptor[]>([]),
        [forms, setForms] = useState<FormRequest[]>([]),
        [formError, setFormError] = useState("");
    const [formPreview, setFormPreview] = useState<{
        requestId: string;
        contents: { uri?: string; text?: string; mimeType?: string }[];
    } | null>(null);
    const appsRef = useRef(apps);
    appsRef.current = apps;
    const current = useRef({
        project,
        threadId,
        action,
        onOpenThread,
        onReveal,
        onRemoveTab,
        onError,
    });
    current.current = { project, threadId, action, onOpenThread, onReveal, onRemoveTab, onError };
    const readEpoch = useRef(0),
        formPending = useRef(new Set<string>());
    const refresh = useCallback(async () => {
        const { project, threadId, action } = current.current;
        if (!project?.state?.connected) {
            setServers([]);
            return;
        }
        const epoch = ++readEpoch.current;
        setLoading(true);
        setError("");
        try {
            const result = await action("manage", {
                operation: "mcpApps",
                projectId: project.id,
                ...(threadId ? { threadId } : {}),
            });
            if (epoch !== readEpoch.current) return;
            if (!Array.isArray(result.data)) throw Error("应用目录格式无效");
            setServers(result.data);
            const stale = appsRef.current.filter(
                (app) =>
                    app.projectId === project.id &&
                    !result.data.some(
                        (server: McpWorkspaceServer) =>
                            server.serverId === app.serverId &&
                            server.generation === app.generation,
                    ),
            );
            for (const app of stale) {
                void mcpAppDesktop()
                    .mcpApp({ operation: "close", token: app.token })
                    .catch(() => {});
                current.current.onRemoveTab(appTab(app));
            }
            if (stale.length)
                setApps((items) =>
                    items.filter((app) => !stale.some((item) => item.token === app.token)),
                );
        } catch (cause) {
            if (epoch === readEpoch.current) {
                setServers([]);
                setError(cause instanceof Error ? cause.message : "应用目录不可用");
            }
        } finally {
            if (epoch === readEpoch.current) setLoading(false);
        }
    }, []);
    useEffect(() => {
        void refresh();
        return () => {
            readEpoch.current++;
        };
    }, [project?.id, project?.state?.connected, threadId, refresh]);
    useEffect(() => {
        const listener = () => void refresh();
        window.addEventListener("areal-plugins-changed", listener);
        return () => window.removeEventListener("areal-plugins-changed", listener);
    }, [refresh]);
    useEffect(
        () =>
            mcpAppDesktop().onMcpAppEvent((event) => {
                if (
                    !("method" in event.notification) ||
                    event.notification.method !== "ui/notifications/host-context-changed"
                )
                    return;
                const context = event.notification.params;
                if (context && typeof context === "object")
                    setApps((items) =>
                        items.map((app) =>
                            app.token === event.token
                                ? { ...app, hostContext: { ...app.hostContext, ...context } }
                                : app,
                        ),
                    );
            }),
        [],
    );
    useEffect(
        () => () => {
            for (const app of appsRef.current)
                void mcpAppDesktop()
                    .mcpApp({ operation: "close", token: app.token })
                    .catch(() => {});
        },
        [],
    );
    const close = useCallback(async (tab: string) => {
        const app = appsRef.current.find((item) => appTab(item) === tab);
        if (!app) return;
        await mcpAppDesktop().mcpApp({ operation: "close", token: app.token });
        setApps((items) => items.filter((item) => item.token !== app.token));
        current.current.onRemoveTab(tab);
    }, []);
    async function ensureThread(forceNew = false) {
        const { project, threadId, action, onOpenThread } = current.current;
        if (!project?.state?.connected) throw Error("请先连接项目");
        if (
            !forceNew &&
            threadId &&
            project.state?.threads[threadId] &&
            !project.state.threads[threadId].desktop?.archived
        )
            return { projectId: project.id, threadId };
        const result = await action("create", { projectId: project.id });
        if (typeof result.threadId !== "string") throw Error("无法创建应用会话");
        await onOpenThread(project.id, result.threadId);
        return { projectId: project.id, threadId: result.threadId };
    }
    async function openApp(
        server: McpWorkspaceServer,
        tool: McpAppTool,
        options: {
            kind?: "global" | "thread" | "file";
            filePath?: string;
            deepLink?: string;
            arguments?: Record<string, unknown>;
        } = {},
    ) {
        const { project } = current.current;
        if (!project) throw Error("请先选择项目");
        const global = options.kind === "global";
        const existing = appsRef.current.find(
            (app) =>
                app.projectId === project.id &&
                app.serverId === server.serverId &&
                app.generation === server.generation &&
                app.toolMetadata?.name === tool.name &&
                !options.arguments &&
                (global || (app.threadId === current.current.threadId && !options.filePath)),
        );
        if (existing) {
            if (options.deepLink)
                setApps((items) =>
                    items.map((app) =>
                        app.token === existing.token
                            ? {
                                  ...app,
                                  hostContext: {
                                      ...app.hostContext,
                                      "openai/deepLink": { url: options.deepLink },
                                  },
                              }
                            : app,
                    ),
                );
            await current.current.onOpenThread(existing.projectId, existing.threadId);
            current.current.onReveal(appTab(existing), existing);
            return;
        }
        const owner = await ensureThread(global);
        const directory = await current.current.action("manage", {
            operation: "mcpApps",
            projectId: owner.projectId,
            threadId: owner.threadId,
        });
        if (current.current.project?.id !== project.id || owner.projectId !== project.id)
            throw Error("应用所属项目已变化，请重新打开。");
        if (!Array.isArray(directory.data)) throw Error("应用目录格式无效");
        const servers: McpWorkspaceServer[] = directory.data;
        const connectedServer = servers.find((candidate) =>
            candidate.serverId === server.serverId && candidate.pluginId === server.pluginId &&
            candidate.installedDigest === server.installedDigest,
        );
        const connectedTool = connectedServer?.tools.find((candidate) => candidate.name === tool.name);
        if (!connectedServer || !connectedTool)
            throw Error("应用连接或插件版本已变化，请刷新后重新打开。");
        const app = await openMcpApp({
            ...owner,
            serverId: connectedServer.serverId,
            expectedGeneration: connectedServer.generation,
            toolName: connectedTool.name,
            ...(options.filePath ? { filePath: options.filePath } : {}),
            ...(options.deepLink ? { deepLink: options.deepLink } : {}),
            ...(options.arguments ? { arguments: options.arguments } : {}),
        });
        setApps((items) => [...items, app]);
        current.current.onReveal(appTab(app), app);
    }
    async function message(value: McpAppMessage) {
        const { project, action } = current.current;
        if (
            !project ||
            project.id !== value.projectId ||
            !project.state?.threads[value.threadId] ||
            project.state.threads[value.threadId].desktop?.archived
        )
            throw Error("应用所属会话已不可用");
        const owner =
            value.target === "new"
                ? await ensureThread(true)
                : { projectId: value.projectId, threadId: value.threadId };
        const key = `areal-gui:draft:${owner.projectId}:${owner.threadId}`;
        if (
            sending.has(key) ||
            project.pending?.some((entry: Data) => entry.params?.threadId === owner.threadId)
        )
            throw Error("会话有待确认的提交，请稍后重试");
        if (!value.send) {
            appendMcpDraft(key, value.content);
            await current.current.onOpenThread(owner.projectId, owner.threadId);
            return;
        }
        const plain = value.content
            .filter((block) => block.type === "text" && !block._meta?.["openai/title"])
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
        const content = value.content.filter(
            (block) => block.type !== "text" || block._meta?.["openai/title"],
        );
        const running = project.state.threads[owner.threadId]?.turns?.some(
            (turn: Data) => turn.status === "inProgress",
        );
        markSending(key, true);
        try {
            await submitMessage(action, owner.projectId, owner.threadId, plain, [], {
                appMessage: true,
                mcpContent: content,
                enqueue: !!running,
            });
        } finally {
            markSending(key, false);
        }
    }
    async function modelContext(value: McpAppModelContext) {
        setApps((items) =>
            items.map((app) =>
                app.instanceId === value.instanceId &&
                app.projectId === value.projectId &&
                app.threadId === value.threadId
                    ? {
                          ...app,
                          hostContext: {
                              ...app.hostContext,
                              "openai/modelContext": {
                                  content: value.content ?? [],
                                  ...(value.structuredContent
                                      ? { structuredContent: value.structuredContent }
                                      : {}),
                              },
                          },
                      }
                    : app,
            ),
        );
    }
    async function clearContext(app: McpAppDescriptor) {
        const reply = (await mcpAppDesktop().mcpApp({
            operation: "request",
            token: app.token,
            request: {
                jsonrpc: "2.0",
                id: crypto.randomUUID(),
                method: "ui/update-model-context",
                params: { content: [] },
            },
        })) as { error?: unknown };
        if (reply.error) throw Error("无法移除应用上下文");
        setApps((items) =>
            items.map((item) =>
                item.token === app.token
                    ? { ...item, hostContext: { ...item.hostContext, "openai/modelContext": null } }
                    : item,
            ),
        );
    }
    useEffect(() => {
        const desktop = mcpAppDesktop();
        if (!desktop?.onMcpAppDeepLink) return;
        return desktop.onMcpAppDeepLink(async (link) => {
            const candidates = servers.filter(
                (server) =>
                    server.pluginId === link.pluginId &&
                    (!link.marketplace || server.marketplace === link.marketplace),
            );
            const matches = candidates.flatMap((server) =>
                server.tools
                    .filter((tool) => tool.name === link.toolName && entrypoint(tool, "global"))
                    .map((tool) => ({ server, tool })),
            );
            if (matches.length !== 1) throw Error("链接未匹配唯一的已连接插件应用");
            await openApp(matches[0].server, matches[0].tool, {
                kind: "global",
                deepLink: link.path,
            });
        });
    }, [servers, project?.id]);
    useEffect(() => {
        let active = true,
            timer: ReturnType<typeof setTimeout> | undefined;
        if (!project?.state?.connected || !threadId) {
            setForms([]);
            return;
        }
        const pid = project.id,
            tid = threadId;
        setForms([]);
        setFormError("");
        const read = async () => {
            try {
                const result = await current.current.action("manage", {
                    operation: "mcpForms",
                    projectId: pid,
                    threadId: tid,
                });
                if (active) {
                    if (!Array.isArray(result.data)) throw Error("表单列表格式无效");
                    setForms(result.data.filter((form: FormRequest) => form.threadId === tid));
                    setFormError("");
                }
            } catch (cause) {
                if (active)
                    setFormError(cause instanceof Error ? cause.message : "无法读取待回复表单");
            } finally {
                if (active) timer = setTimeout(() => void read(), 3000);
            }
        };
        void read();
        return () => {
            active = false;
            if (timer) clearTimeout(timer);
        };
    }, [project?.id, project?.state?.connected, threadId]);
    async function respond(form: FormRequest, response: McpFormResponse | { unsupported: true }) {
        const key = `${form.threadId}:${form.requestId}`;
        if (formPending.current.has(key)) throw Error("原表单回复正在核对，请勿重新提交");
        const owner = current.current.project;
        if (
            !owner ||
            current.current.threadId !== form.threadId ||
            !forms.some(
                (item) => item.requestId === form.requestId && item.generation === form.generation,
            )
        )
            throw Error("表单已过期");
        formPending.current.add(key);
        try {
            await current.current.action("manage", {
                operation: "mcpFormRespond",
                projectId: owner.id,
                threadId: form.threadId,
                requestId: form.requestId,
                response,
            });
            setForms((items) => items.filter((item) => item.requestId !== form.requestId));
            formPending.current.delete(key);
        } catch (cause) {
            if (!(cause as { submissionUnknown?: boolean }).submissionUnknown)
                formPending.current.delete(key);
            throw cause;
        }
    }
    async function previewForm(form: FormRequest, target: unknown) {
        const owner = current.current.project;
        if (!owner || current.current.threadId !== form.threadId) throw Error("表单已过期");
        const result = await current.current.action("manage", {
            operation: "mcpFormPreview",
            projectId: owner.id,
            threadId: form.threadId,
            requestId: form.requestId,
            target,
        });
        if (current.current.project?.id !== owner.id || current.current.threadId !== form.threadId)
            return;
        if (
            target &&
            typeof target === "object" &&
            "type" in target &&
            target.type === "mcp_app_tool"
        ) {
            if (!("name" in target) || typeof target.name!=="string") throw Error("预览应用名称无效");
            const advertised = target as { name: string; arguments?: Record<string, unknown> };
            const server = servers.find(
                (item) => item.serverId === form.serverId && item.generation === form.generation,
            );
            const tool = server?.tools.find((item) => item.name === advertised.name);
            if (!server || !tool) throw Error("预览应用已不可用");
            await openApp(server, tool, { arguments: advertised.arguments ?? {} });
        } else {
            if (!Array.isArray(result.contents)) throw Error("资源预览格式无效");
            setFormPreview({ requestId: form.requestId, contents: result.contents });
        }
    }
    const contentFor = (app: McpAppDescriptor) => {
        const context = app.hostContext["openai/modelContext"] as
            { content?: ContentBlock[] } | null | undefined;
        return context?.content?.filter(visible) ?? [];
    };
    return {
        servers,
        loading,
        error,
        refresh,
        openApp,
        ensureThread,
        close,
        apps,
        titleFor: (tab: string) => {
            const app = apps.find((item) => appTab(item) === tab);
            return app ? (app.toolMetadata?.title ?? app.toolMetadata?.name ?? "应用") : undefined;
        },
        render: (tab: string) => {
            const app = apps.find((item) => appTab(item) === tab);
            return app ? (
                <McpAppHost
                    key={app.token}
                    app={app}
                    context={app.hostContext}
                    closeOnUnmount={false}
                    onMessage={message}
                    onModelContext={modelContext}
                    onClose={() => {
                        void close(tab).catch((cause) => current.current.onError(cause.message));
                    }}
                    onError={onError}
                />
            ) : (
                <p role="status">应用已关闭，请从应用入口重新打开。</p>
            );
        },
        contexts: (
            <div aria-label="应用上下文">
                {apps
                    .filter(
                        (app) =>
                            app.projectId === project?.id &&
                            app.threadId === threadId &&
                            contentFor(app).length > 0,
                    )
                    .map((app) => (
                        <div key={app.token}>
                            <details>
                                <summary>
                                    {app.toolMetadata?.title ??
                                        app.toolMetadata?.name ??
                                        "应用上下文"}{" "}
                                    · {contentFor(app).length} 项
                                </summary>
                                {contentFor(app).map((block, index) => (
                                    <McpContentLabel key={index} block={block} />
                                ))}
                            </details>
                            <button
                                onClick={() =>
                                    void clearContext(app).catch((cause) => onError(cause.message))
                                }
                            >
                                移除应用上下文
                            </button>
                        </div>
                    ))}
            </div>
        ),
        formsView: (
            <>
                {forms.map((form) => (
                    <McpAppForm
                        key={`${form.serverId}:${form.generation}:${form.requestId}`}
                        requestId={form.requestId}
                        message={form.message}
                        requestedSchema={form.requestedSchema}
                        onRespond={(_id, response) => respond(form, response)}
                        onUnsupported={() => respond(form, { unsupported: true })}
                        onPreview={(target) => previewForm(form, target)}
                        onPickResources={async (fieldName) => {
                            if (!project?.id || current.current.project?.id !== project.id || current.current.threadId !== form.threadId)
                                throw new Error("Form owner expired");
                            const owner = { projectId: project.id, threadId: form.threadId, requestId: form.requestId, fieldName };
                            const result = await formResource("pick", owner);
                            if (current.current.project?.id !== owner.projectId || current.current.threadId !== owner.threadId) {
                                await Promise.all((result.resources ?? []).map(item => formResource("release", { ...owner, uri: item.uri })));
                                throw new Error("Form owner expired");
                            }
                            return result.resources ?? [];
                        }}
                        onReleaseResource={async (fieldName, uri) => {
                            if (!project?.id) throw new Error("Form owner expired");
                            await formResource("release", { projectId: project.id, threadId: form.threadId, requestId: form.requestId, fieldName, uri });
                        }}
                    />
                ))}
                {formPreview && forms.some((form) => form.requestId === formPreview.requestId) && (
                    <section aria-label="资源预览">
                        <button onClick={() => setFormPreview(null)}>关闭资源预览</button>
                        {formPreview.contents.map((resource, index) => (
                            <article key={index}>
                                <strong>{resource.mimeType ?? "资源"}</strong>
                                {typeof resource.text === "string" ? (
                                    <pre
                                        style={{
                                            whiteSpace: "pre-wrap",
                                            maxHeight: 300,
                                            overflow: "auto",
                                        }}
                                    >
                                        {resource.text}
                                    </pre>
                                ) : (
                                    <p>此二进制资源无法显示文本预览。</p>
                                )}
                            </article>
                        ))}
                    </section>
                )}
                {formError && forms.length > 0 && <p role="alert">{formError}</p>}
            </>
        ),
    };
}
export function McpAppsHub({
    workspace,
    project,
    threadId,
    action,
    pluginId,
}: {
    workspace: ReturnType<typeof useMcpAppsWorkspace>;
    project?: Data;
    threadId: string;
    action: Action;
    pluginId?: string;
}) {
    const [selected, setSelected] = useState<string | null>(null),
        [feedback, setFeedback] = useState("");
    const servers = pluginId === undefined
        ? workspace.servers
        : workspace.servers.filter((server) => server.pluginId === pluginId);
    const server = servers.find((server) => server.serverId === selected);
    const command = (request: Record<string, unknown>) => action("manage", request);
    const run = async (server: McpWorkspaceServer, tool: McpAppTool) => {
        setFeedback("");
        if (tool._meta?.ui || tool._meta?.["ui/resourceUri"]) {
            await workspace.openApp(server, tool);
            return;
        }
        if (!project || !threadId) throw Error("请先选择应用会话");
        const result = (await command({
            operation: "mcpExtensionCall",
            projectId: project.id,
            threadId,
            serverId: server.serverId,
            expectedGeneration: server.generation,
            kind: "settingsAction",
            arguments: { toolName: tool.name },
            requestId: crypto.randomUUID(),
        })) as Data;
        if (result.isError) throw Error("应用操作未完成");
        setFeedback(
            (result.content ?? [])
                .filter((block: Data) => block.type === "text")
                .map((block: Data) => block.text)
                .join("\n") || "操作已完成",
        );
    };
    return (
        <section aria-label="插件应用">
            <div>
                <h3>已连接应用</h3>
                <button disabled={workspace.loading} onClick={() => void workspace.refresh()}>
                    刷新应用
                </button>
            </div>
            {workspace.error && <p role="alert">{workspace.error}</p>}
            {!workspace.loading && !servers.length && (
                <p>没有可用应用。请先在插件详情中明确连接 MCP 服务器。</p>
            )}
            <McpAppEntrypoints
                servers={servers}
                kind="global"
                onOpen={(server, tool) =>
                    void workspace
                        .openApp(server, tool, { kind: "global" })
                        .catch((cause) => setFeedback(cause.message))
                }
            />
            <label>
                应用设置
                <select
                    value={selected ?? ""}
                    onChange={(event) => setSelected(event.target.value || null)}
                >
                    <option value="">选择应用</option>
                    {servers.map((server) => (
                        <option key={server.serverId} value={server.serverId}>
                            {server.title ?? server.serverId}
                        </option>
                    ))}
                </select>
            </label>
            {server &&
                (!threadId ? (
                    <button
                        onClick={() =>
                            void workspace
                                .ensureThread()
                                .catch((cause) => setFeedback(cause.message))
                        }
                    >
                        创建应用会话
                    </button>
                ) : server.capabilities?.["openai/settings"] ? (
                    <McpAppsSettings
                        key={`${server.serverId}:${server.generation}:${threadId}`}
                        server={server}
                        projectId={project!.id}
                        threadId={threadId}
                        command={command}
                        onTool={run}
                    />
                ) : (
                    <p>此应用未声明结构化设置。</p>
                ))}
            {feedback && <p role="status">{feedback}</p>}
        </section>
    );
}
export function McpMentionsPicker({
    servers,
    projectId,
    threadId,
    action,
    onClose,
}: {
    servers: McpWorkspaceServer[];
    projectId: string;
    threadId: string;
    action: Action;
    onClose: () => void;
}) {
    const candidates = servers.filter((server) => server.capabilities?.["openai/mentions"]);
    const [selected, setSelected] = useState(candidates[0]?.serverId ?? "");
    const server = candidates.find((item) => item.serverId === selected);
    return (
        <section aria-label="选择应用引用">
            <button onClick={onClose}>关闭引用选择</button>
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                {candidates.map((server) => (
                    <option key={server.serverId} value={server.serverId}>
                        {server.title ?? server.serverId}
                    </option>
                ))}
            </select>
            {server ? (
                <McpAppsMentions
                    server={server}
                    projectId={projectId}
                    threadId={threadId}
                    command={(request) => action("manage", request)}
                    onSelect={(item) => {
                        const key = `areal-gui:draft:${projectId}:${threadId}`;
                        const text = localStorage.getItem(key) ?? "";
                        if (/(^|\s)@$/.test(text)) localStorage.setItem(key, text.slice(0, -1));
                        appendMcpDraft(key, [item]);
                        onClose();
                    }}
                />
            ) : (
                <p>当前连接没有可搜索的应用引用。</p>
            )}
        </section>
    );
}
