import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { McpAppIcon } from "../McpAppIcon.js";
export type McpAppTool = {
    name: string;
    title?: string;
    annotations?: { title?: string; readOnlyHint?: boolean };
    icons?: { src: string }[];
    _meta?: Record<string, unknown>;
};
export type McpAppServer = {
    serverId: string;
    generation: string | number;
    tools: McpAppTool[];
    capabilities?: Record<string, unknown>;
    title?: string;
    icons?: { src: string }[];
};
export type McpAppsCommand = (request: Record<string, unknown>) => Promise<unknown>;
export const toolTitle = (tool: McpAppTool) => tool.title ?? tool.annotations?.title ?? tool.name;
const base = { title: z.string().min(1), description: z.string().optional() };
const fieldSchema = z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("boolean") }).strict(),
    z
        .object({
            ...base,
            type: z.literal("string"),
            enum: z.array(z.string()).min(1).optional(),
            minLength: z.number().int().nonnegative().optional(),
            maxLength: z.number().int().nonnegative().optional(),
            pattern: z.string().optional(),
        })
        .strict(),
    z
        .object({
            ...base,
            type: z.enum(["number", "integer"]),
            minimum: z.number().finite().optional(),
            maximum: z.number().finite().optional(),
            multipleOf: z.number().positive().optional(),
        })
        .strict(),
]);
const settingsSchema = z
    .object({
        schema: z
            .object({
                type: z.literal("object"),
                properties: z.record(z.string(), fieldSchema),
                required: z.array(z.string()).optional(),
            })
            .strict(),
        values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
        layout: z
            .array(
                z
                    .object({
                        kind: z.literal("group"),
                        title: z.string(),
                        items: z.array(
                            z.discriminatedUnion("kind", [
                                z
                                    .object({ kind: z.literal("property"), property: z.string() })
                                    .strict(),
                                z
                                    .object({
                                        kind: z.literal("tool"),
                                        tool: z.string(),
                                        title: z.string().optional(),
                                        description: z.string().optional(),
                                    })
                                    .strict(),
                            ]),
                        ),
                    })
                    .strict(),
            )
            .optional(),
    })
    .strict();
type Settings = z.infer<typeof settingsSchema>;
type Field = z.infer<typeof fieldSchema>;
export function validSetting(field: Field, value: unknown): boolean {
    if (field.type === "boolean") return typeof value === "boolean";
    if (field.type === "string")
        return (
            typeof value === "string" &&
            (!field.enum || field.enum.includes(value)) &&
            (field.minLength === undefined || [...value].length >= field.minLength) &&
            (field.maxLength === undefined || [...value].length <= field.maxLength) &&
            (field.pattern === undefined || new RegExp(field.pattern, "u").test(value))
        );
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (field.type !== "integer" || Number.isSafeInteger(value)) &&
        (field.minimum === undefined || value >= field.minimum) &&
        (field.maximum === undefined || value <= field.maximum) &&
        (field.multipleOf === undefined ||
            Math.abs(value / field.multipleOf - Math.round(value / field.multipleOf)) < 1e-9)
    );
}
export function parseMcpSettings(value: unknown, tools: McpAppTool[]): Settings {
    const data = settingsSchema.parse(value),
        properties = data.schema.properties;
    for (const name of data.schema.required ?? [])
        if (!(name in properties)) throw Error("Unknown required setting");
    for (const [name, field] of Object.entries(properties)) {
        if (field.type === "string" && field.pattern !== undefined) new RegExp(field.pattern, "u");
        if (!Object.hasOwn(data.values, name) || !validSetting(field, data.values[name]))
            throw Error("Invalid effective setting value");
    }
    if (Object.keys(data.values).some((name) => !Object.hasOwn(properties, name)))
        throw Error("Unknown setting value");
    const placed = new Set<string>();
    for (const group of data.layout ?? [])
        for (const item of group.items) {
            if (item.kind === "property") {
                if (!Object.hasOwn(properties, item.property) || placed.has(item.property))
                    throw Error("Invalid settings layout");
                placed.add(item.property);
            } else if (!tools.some((tool) => tool.name === item.tool))
                throw Error("Unknown same-server settings tool");
        }
    return data;
}
function structured(value: unknown): unknown {
    if (typeof value !== "object" || !value) throw Error("Invalid extension response");
    const data = value as {
        structuredContent?: unknown;
        result?: { structuredContent?: unknown };
        isError?: boolean;
    };
    if (data.isError) throw Error("Extension tool failed");
    return data.structuredContent ?? data.result?.structuredContent ?? value;
}
export function McpAppsSettings({
    server,
    projectId,
    threadId,
    command,
    onTool,
}: {
    server: McpAppServer;
    projectId: string;
    threadId: string;
    command: McpAppsCommand;
    onTool: (server: McpAppServer, tool: McpAppTool) => Promise<void>;
}) {
    const [data, setData] = useState<Settings | null>(null),
        [values, setValues] = useState<Record<string, string | number | boolean>>({}),
        [error, setError] = useState(""),
        [busy, setBusy] = useState(false);
    const epoch = useRef(0);
    const call = (kind: string, args: Record<string, unknown>) =>
        command({
            operation: "mcpExtensionCall",
            projectId,
            threadId,
            serverId: server.serverId,
            expectedGeneration: server.generation,
            kind,
            arguments: args,
            requestId: crypto.randomUUID(),
        });
    useEffect(() => {
        const version = ++epoch.current;
        setData(null);
        setError("");
        setBusy(true);
        void call("settingsRead", {})
            .then((result) => {
                const next = parseMcpSettings(structured(result), server.tools);
                if (epoch.current !== version) return;
                setData(next);
                setValues(next.values);
            })
            .catch(() => {
                if (epoch.current === version)
                    setError("此应用的设置格式不受支持，未应用任何更改。");
            })
            .finally(() => {
                if (epoch.current === version) setBusy(false);
            });
        return () => {
            epoch.current++;
        };
    }, [server.serverId, server.generation, projectId, threadId]);
    const groups = useMemo(() => {
        if (!data) return [];
        const declared = data.layout ?? [],
            placed = new Set(
                declared.flatMap((group) =>
                    group.items.flatMap((item) =>
                        item.kind === "property" ? [item.property] : [],
                    ),
                ),
            );
        const remaining = Object.keys(data.schema.properties)
            .filter((name) => !placed.has(name))
            .map((property) => ({ kind: "property" as const, property }));
        return [
            ...declared,
            ...(remaining.length
                ? [
                      {
                          kind: "group" as const,
                          title: declared.length ? "其他设置" : "设置",
                          items: remaining,
                      },
                  ]
                : []),
        ];
    }, [data]);
    async function save() {
        if (!data || busy) return;
        const version = epoch.current;
        setError("");
        const changed: Record<string, string | number | boolean> = {};
        for (const [name, field] of Object.entries(data.schema.properties)) {
            if (!validSetting(field, values[name])) {
                setError(`请检查“${field.title}”的值。`);
                return;
            }
            if (values[name] !== data.values[name]) changed[name] = values[name];
        }
        if (!Object.keys(changed).length) return;
        setBusy(true);
        try {
            await call("settingsUpdate", { set: changed });
            const next = parseMcpSettings(structured(await call("settingsRead", {})), server.tools);
            if (version === epoch.current) {
                setData(next);
                setValues(next.values);
            }
        } catch {
            if (version === epoch.current) setError("设置更新未确认。请刷新核对后再修改。");
        } finally {
            if (version === epoch.current) setBusy(false);
        }
    }
    return (
        <section aria-label={`${server.title ?? server.serverId} 设置`}>
            <h3>{server.title ?? server.serverId}</h3>
            {error && <p role="alert">{error}</p>}
            {groups.map((group, index) => (
                <fieldset key={index} disabled={busy}>
                    <legend>{group.title}</legend>
                    {group.items.map((item, index) => {
                        if (item.kind === "tool") {
                            const tool = server.tools.find((tool) => tool.name === item.tool)!;
                            return (
                                <button
                                    key={index}
                                    type="button"
                                    onClick={() => {
                                        setBusy(true);
                                        void onTool(server, tool)
                                            .catch(() => setError("操作未完成，请重试。"))
                                            .finally(() => setBusy(false));
                                    }}
                                >
                                    {toolTitle(tool)}
                                </button>
                            );
                        }
                        const name = item.property,
                            field = data!.schema.properties[name],
                            value = values[name];
                        return (
                            <label key={name} style={{ display: "block", marginBlock: 12 }}>
                                {field.title}
                                {field.description && (
                                    <small style={{ display: "block" }}>{field.description}</small>
                                )}
                                {field.type === "boolean" ? (
                                    <input
                                        type="checkbox"
                                        checked={value === true}
                                        onChange={(e) =>
                                            setValues({ ...values, [name]: e.target.checked })
                                        }
                                    />
                                ) : field.type === "string" && field.enum ? (
                                    <select
                                        value={String(value)}
                                        onChange={(e) =>
                                            setValues({ ...values, [name]: e.target.value })
                                        }
                                    >
                                        {field.enum.map((option) => (
                                            <option key={option}>{option}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        type={field.type === "string" ? "text" : "number"}
                                        value={String(value ?? "")}
                                        onChange={(e) =>
                                            setValues({
                                                ...values,
                                                [name]:
                                                    field.type === "string"
                                                        ? e.target.value
                                                        : e.target.value === ""
                                                          ? ""
                                                          : Number(e.target.value),
                                            })
                                        }
                                    />
                                )}
                            </label>
                        );
                    })}
                </fieldset>
            ))}
            <button disabled={busy || !data} onClick={() => void save()}>
                {busy ? "处理中…" : "保存设置"}
            </button>
        </section>
    );
}
export function McpAppEntrypoints({
    servers,
    kind,
    fileName,
    onOpen,
}: {
    servers: McpAppServer[];
    kind: "global" | "thread" | "file";
    fileName?: string;
    onOpen: (server: McpAppServer, tool: McpAppTool) => void;
}) {
    const entries = servers.flatMap((server) =>
        server.tools
            .filter((tool) => {
                const meta = tool._meta?.["openai/ui"] as { entrypoints?: unknown } | undefined;
                return (
                    Array.isArray(meta?.entrypoints) &&
                    meta.entrypoints.some((entry: unknown) => {
                        if (typeof entry !== "object" || !entry) return false;
                        const value = entry as { type?: unknown; extensions?: unknown };
                        if (value.type !== kind) return false;
                        return (
                            kind !== "file" ||
                            (Array.isArray(value.extensions) &&
                                value.extensions.some(
                                    (ext) =>
                                        typeof ext === "string" &&
                                        /^\.[a-z0-9._-]+$/i.test(ext) &&
                                        fileName?.toLowerCase().endsWith(ext.toLowerCase()),
                                ))
                        );
                    })
                );
            })
            .map((tool) => ({ server, tool })),
    );
    return (
        <nav aria-label="应用入口">
            {entries.map(({ server, tool }) => (
                <button
                    key={`${server.serverId}:${tool.name}`}
                    onClick={() => onOpen(server, tool)}
                >
                    <McpAppIcon icon={tool.icons?.[0] ?? server.icons?.[0]} />
                    {toolTitle(tool)}
                </button>
            ))}
        </nav>
    );
}
export type McpMentionResource = {
    type: "resource_link";
    uri: string;
    name: string;
    title?: string;
    mimeType?: string;
    _meta?: Record<string, unknown>;
};
export function McpAppsMentions({
    server,
    projectId,
    threadId,
    command,
    onSelect,
}: {
    server: McpAppServer;
    projectId: string;
    threadId: string;
    command: McpAppsCommand;
    onSelect: (item: McpMentionResource) => void;
}) {
    const [query, setQuery] = useState(""),
        [items, setItems] = useState<McpMentionResource[]>([]),
        [error, setError] = useState("");
    const epoch = useRef(0);
    useEffect(() => {
        const version = ++epoch.current;
        setItems([]);
        setError("");
        const timer = setTimeout(() => {
            void command({
                operation: "mcpExtensionCall",
                projectId,
                threadId,
                serverId: server.serverId,
                expectedGeneration: server.generation,
                kind: "mentionsSearch",
                arguments: { query },
                requestId: crypto.randomUUID(),
            })
                .then((value) => {
                    const data = z
                        .object({
                            items: z
                                .array(
                                    z
                                        .object({
                                            type: z.literal("resource_link"),
                                            uri: z.string().min(1),
                                            name: z.string().min(1),
                                            title: z.string().optional(),
                                            mimeType: z.string().optional(),
                                            _meta: z.record(z.string(), z.unknown()).optional(),
                                        })
                                        .passthrough(),
                                )
                                .max(500),
                        })
                        .parse(structured(value));
                    if (version === epoch.current) setItems(data.items);
                })
                .catch(() => {
                    if (version === epoch.current) setError("无法搜索此应用，请重试。");
                });
        }, 180);
        return () => {
            clearTimeout(timer);
            epoch.current++;
        };
    }, [query, server.serverId, server.generation, projectId, threadId]);
    return (
        <section aria-label="应用引用">
            <label>
                搜索引用
                <input value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            {error && <p role="alert">{error}</p>}
            <ul>
                {items.map((item, index) => (
                    <li key={`${item.uri}:${index}`}>
                        <button onClick={() => onSelect(item)}>{item.title ?? item.name}</button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
