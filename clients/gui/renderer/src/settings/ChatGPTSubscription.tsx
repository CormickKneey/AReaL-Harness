import { useEffect, useRef, useState } from "react";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button.js";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../components/ui/select.js";
import { Feedback, useResource } from "./common.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";
import { subscriptionProjection } from "./provider-ui-state.js";
import type { Action, Data } from "../services.js";

const recovery: Record<string, string> = {
    ready: "模型来自当前账号，实际权限和额度以服务端为准。",
    refreshing: "刷新由后台完成，已保存的连接和模型配置继续保留。",
    temporarily_unavailable: "登录和配置已保留，请稍后重试状态。",
    storage_locked: "解锁本机安全存储后重试状态。",
    reauth_required: "授权已终止，请为此账号重新登录。",
    permission_denied: "请检查账号授权、地域或服务策略。",
    quota_exceeded: "请在 ChatGPT 设置检查本应用用量，不会自动切换至 API Key 计费。",
    signed_out: "在浏览器授权应用使用所选 ChatGPT 账号。",
};

export function ChatGPTSubscription({
    action,
    onModelsChange,
    onAccountChange,
    onReadyChange,
}: {
    action: Action;
    onModelsChange?: (models: Data[]) => void;
    onAccountChange?: (label: string) => void;
    onReadyChange?: (ready: boolean) => void;
}) {
    const api = (operation: string, values: Data = {}) =>
        action("chatgpt", { operation, provider: "openai", ...values });
    const resource = useResource(() => api("status"), "chatgpt-subscription-openai");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const value = resource.value;
    const projection = subscriptionProjection(value);
    const retained = useRef<{ accountId?: string; models: Data[] }>({ models: [] });
    const models: Data[] = value?.models ?? [];
    const chosenModel = models[0]?.id ?? "";
    const accounts: Data[] = value?.accounts ?? [];
    useEffect(() => {
        if (!value) return;
        if (value.activeAccountId && retained.current.accountId !== value.activeAccountId)
            retained.current = { accountId: value.activeAccountId, models: [] };
        // 暂时不可读不删除已显示的同账号模型；其操作资格仍由真实状态决定。
        if (!projection.temporary)
            retained.current.models = value.authenticated ? (value.models ?? []) : [];
        onModelsChange?.(retained.current.models);
        onAccountChange?.(`${value.email || "ChatGPT"} · 订阅 · ${projection.label}`);
        onReadyChange?.(projection.canTest && !resource.error);
    }, [value, resource.error, onModelsChange, onAccountChange, onReadyChange]);

    useEffect(() => {
        if (!value?.login) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            await resource.refresh();
            if (!disposed) timer = setTimeout(poll, 1500);
        };
        timer = setTimeout(poll, 1500);
        return () => {
            disposed = true;
            clearTimeout(timer);
        };
    }, [value?.login?.loginId, resource.refresh]);

    const run = async (operation: string, values: Data = {}) => {
        setBusy(true);
        setError("");
        setMessage("");
        try {
            await api(operation, { model: chosenModel, ...values });
            if (operation === "probe") setMessage("连接成功，已收到模型的完整回复。");
            await resource.refresh();
        } catch (cause) {
            setError((cause as Error).message);
        } finally {
            setBusy(false);
        }
    };
    const disabled = busy || resource.loading;
    return (
        <div data-subscription-kind="openai">
            <SettingsSection
                className="subscription-settings"
                title="ChatGPT 订阅"
                description="浏览器授权 → 连接检测 → 当前账号模型。API Key 的计费与此连接独立。"
                action={
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="刷新 ChatGPT 登录状态"
                        disabled={disabled}
                        onClick={() => void resource.refresh()}
                    >
                        <RefreshCw size={14} className={resource.loading ? "animate-spin" : ""} />
                    </Button>
                }
            >
                <Feedback
                    error={error || resource.error || value?.error || value?.modelError}
                    message={message}
                />
                <SettingsGroupCard>
                    <SettingsRow
                        label={value?.email || "ChatGPT 账号"}
                        description={
                            value?.login
                                ? "等待浏览器授权，完成后页面会自动更新。"
                                : (recovery[projection.state] ?? "请刷新核对连接状态。")
                        }
                        control={
                            <>
                                {value?.login ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => void run("cancel")}
                                    >
                                        取消登录
                                    </Button>
                                ) : projection.canSignIn ? (
                                    <Button
                                        size="sm"
                                        disabled={disabled}
                                        onClick={() => void run("login")}
                                    >
                                        <LogIn size={14} />
                                        {projection.state === "reauth_required"
                                            ? "重新登录"
                                            : "使用 ChatGPT 登录"}
                                    </Button>
                                ) : value?.authenticated ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={disabled}
                                        onClick={() => void run("logout")}
                                    >
                                        <LogOut size={14} />
                                        退出登录
                                    </Button>
                                ) : null}
                            </>
                        }
                    />
                </SettingsGroupCard>
                <p role="status" aria-label="ChatGPT 连接状态" className="settings-muted">
                    订阅 · {resource.loading && !value ? "正在读取状态" : projection.label}
                </p>
                {projection.retryable && (
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
                            setError("");
                            void resource.refresh();
                        }}
                    >
                        重试状态
                    </Button>
                )}
                {accounts.length > 1 && (
                    <div>
                        <label
                            htmlFor="chatgpt-account"
                            className="mb-1 block text-ui-base text-foreground-subtle"
                        >
                            已保存账号
                        </label>
                        <Select<string>
                            value={value?.activeAccountId ?? null}
                            items={accounts.map((account) => ({
                                value: account.id,
                                label: `${account.label}${account.email ? ` · ${account.email}` : ""}${account.active ? " · 当前" : ""}`,
                            }))}
                            onValueChange={(id) => {
                                if (!id || id === value?.activeAccountId) return;
                                const account = accounts.find((account) => account.id === id);
                                void run(account?.state === "saved" ? "selectAccount" : "login", {
                                    accountId: id,
                                });
                            }}
                        >
                            <SelectTrigger
                                id="chatgpt-account"
                                aria-label="已保存 ChatGPT 账号"
                                disabled={
                                    disabled ||
                                    !!value?.login ||
                                    projection.state === "storage_locked"
                                }
                                className="w-full justify-between"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {accounts.map((account) => (
                                    <SelectItem key={account.id} value={account.id}>
                                        {account.label}
                                        {account.email ? ` · ${account.email}` : ""}
                                        {account.active ? " · 当前" : ""}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}
                {!value?.login && projection.state !== "storage_locked" && (
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        onClick={() => void run("login", { newAccount: true })}
                    >
                        添加 ChatGPT 账号
                    </Button>
                )}
                {value?.diagnostic && (
                    <details>
                        <summary className="settings-muted">诊断信息</summary>
                        <p className="settings-muted break-all">
                            {value.diagnostic.code} · {value.diagnostic.phase}
                            {value.diagnostic.httpStatus
                                ? ` · HTTP ${value.diagnostic.httpStatus}`
                                : ""}
                            {value.diagnostic.requestId
                                ? ` · Request ID ${value.diagnostic.requestId}`
                                : ""}
                        </p>
                    </details>
                )}
                {value?.authenticated && (
                    <div className="subscription-models-footer flex flex-wrap items-center justify-between gap-3 pt-1">
                        <span className="settings-muted">
                            测试发送少量模型请求，使用当前账号的应用额度。
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={
                                disabled || !projection.canTest || !!value.login || !!resource.error
                            }
                            onClick={() => void run("probe")}
                        >
                            {busy ? "正在检查…" : "测试连接"}
                        </Button>
                    </div>
                )}
            </SettingsSection>
        </div>
    );
}
