import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SettingsSection, SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";
import type { Action, Data } from "../services.js";

const networkDiagnostics: Record<string, string> = {
    "funnel-capability-unknown":
        "无法明确确认本机 Funnel 端口能力，未进行公网配置。请联系管理员核对。",
    "funnel-port-denied": "本机没有此端口的 Funnel 授权。私人入口仍可恢复或移除。",
    "unsupported-funnel-port": "Funnel 仅支持 443、8443 或 10000；请先创建合适端口的私人映射。",
    "public-confirmation-required": "请再次明确确认将此 Remote 入口公开到互联网。",
    unavailable: "未找到 Tailscale CLI。请先在 Host 安装并确认命令可用，再重新检测。",
    "unsupported-version":
        "Tailscale 版本不支持已验证的持久 Serve 配置。请升级到稳定版 1.52.0 或更新版本。",
    "not-logged-in": "Host 尚未登录 Tailscale。请在 Tailscale 中登录后重新检测。",
    "https-disabled": "tailnet 未启用此 Host 的 HTTPS。请联系 tailnet 管理员检查 HTTPS 设置。",
    "https-unknown": "无法确认 HTTPS 能力。请检查 Tailscale 登录和 HTTPS 设置。",
    "mapping-collision": "HTTPS 端口已有其他配置。请保留它，选择其他空闲端口。",
    "mapping-exists": "本应用已有映射记录。请先检测，再恢复或移除。",
    "mapping-changed": "映射已被外部更改。本应用不会覆盖或删除它；请在 Tailscale 核对配置后重试。",
    "mapping-absent": "已记录的映射不再存在。请移除旧记录，再创建新方案。",
    "listener-drift": "Remote 监听器与映射端口不一致。请关闭 Remote、移除旧映射后重新启用。",
    "unverified-listener": "Remote 入口已离线。请先在此页启用 Remote。",
    "network-changed": "Host 网络身份、登录或 HTTPS 状态已变化。请重新检测并核对映射。",
    "cleanup-pending": "映射撤销尚未完成。入口未发布；请检查 Tailscale 后重试移除。",
    "reconciliation-required": "映射操作尚待核对。请明确确认恢复或移除。",
    "persistence-failed": "网络状态未能保存。请检查系统安全存储和磁盘，再恢复或移除映射。",
    "cli-failed": "Tailscale 命令未完成。请检查本机 Tailscale 状态，再恢复或移除映射。",
    timeout: "Tailscale 检测超时。请检查本机服务后重试。",
    "stale-proposal": "网络方案已失效。请重新生成方案并确认。",
    "invalid-origin":
        "请输入规范的 HTTPS origin，例如 https://remote.example.org；不要包含路径、结尾斜杠、凭据、查询或 fragment。",
    "invalid-port": "请输入 1–65535 范围内的整数 HTTPS 端口。",
};
const networkLoginDiagnostics: Record<string, string> = {
    "logged-in": "Host 已登录；手机状态未验证。",
    "not-logged-in": "Host 尚未登录。请在 Tailscale 中登录后重新检测。",
    "approval-required": "Host 需要管理员批准。请在 Tailscale 完成后重新检测。",
    stopped: "Host 的 Tailscale 已停止。请启动本机 Tailscale 服务后重新检测。",
    starting: "Host 的 Tailscale 正在启动。请稍后重新检测。",
    unknown: "无法确认 Host 的 Tailscale 登录状态。请在本机检查后重新检测。",
};
const networkDiagnostic = (code: string) =>
    networkDiagnostics[code] ??
    `网络状态无法确认（${code}）。请检查本机 Tailscale 后重新检测；不会自动改用公网。`;

function GrantReview({
    device,
    projects,
    pending,
    busy,
    run,
}: {
    device: Data;
    projects: Data[];
    pending?: boolean;
    busy: boolean;
    run: (request: Data) => Promise<void>;
}) {
    const id = device.devicePeerId ?? device.id;
    const [selected, setSelected] = useState<string[]>(device.projectIds ?? []);
    const [preset, setPreset] = useState(
        device.capabilities?.includes("submit") ? "Operator" : "Observer",
    );
    return (
        <fieldset aria-label={`${pending ? "确认设备" : "授权设备"} ${id}`} className="p-4">
            <legend>{device.displayName ?? device.name}</legend>
            <p className="break-all">设备指纹：{id}</p>
            {!pending && (
                <p>
                    {device.status === "reviewRequired"
                        ? "旧设备需要复核，尚未授权"
                        : device.status === "revoked"
                          ? "已撤销"
                          : `已授权 · 版本 ${device.revision}`}
                </p>
            )}
            {device.status !== "revoked" && (
                <>
                    <p>
                        设备可读取所选项目内的授权会话内容，包括正文中主动包含的敏感信息。名称可伪造，请核对完整指纹。
                    </p>
                    {projects.map((project) => (
                        <label className="block py-2" key={project.id}>
                            <input
                                type="checkbox"
                                checked={selected.includes(project.id)}
                                onChange={(event) =>
                                    setSelected((old) =>
                                        event.target.checked
                                            ? [...old, project.id]
                                            : old.filter((id) => id !== project.id),
                                    )
                                }
                            />{" "}
                            {project.name ?? project.root.split("/").at(-1)}
                        </label>
                    ))}
                    <label>
                        权限预设{" "}
                        <select
                            aria-label="权限预设"
                            value={preset}
                            onChange={(event) => setPreset(event.target.value)}
                        >
                            <option value="Observer">Observer · 观察、审查</option>
                            <option value="Operator">
                                Operator · 观察、审查、发送、停止、回答、暂停任务
                            </option>
                        </select>
                    </label>
                    <p>
                        手机只可使用 Host 当前声明的能力；项目、设备授权与 Core 条件仍会逐次校验。
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            disabled={busy || !selected.length}
                            onClick={() =>
                                void run({
                                    operation: pending ? "approve" : "updateGrant",
                                    id,
                                    projects: selected,
                                    preset,
                                })
                            }
                        >
                            {pending ? "确认配对" : "保存授权"}
                        </Button>
                        <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                                void run({ operation: pending ? "reject" : "revoke", id })
                            }
                        >
                            {pending ? "拒绝配对" : "撤销访问"}
                        </Button>
                    </div>
                </>
            )}
        </fieldset>
    );
}

export function MobileSettings({ action, projects }: { action: Action; projects: Data[] }) {
    const [state, setState] = useState<Data>({ deviceGrants: [], pending: [] });
    const [error, setError] = useState(""),
        [busy, setBusy] = useState(false);
    const [invite, setInvite] = useState<Data | null>(null);
    const [inviteExpired, setInviteExpired] = useState(false);
    const [proposal, setProposal] = useState<Data | null>(null);
    const [serveConfirmed, setServeConfirmed] = useState(false);
    const [scopeConfirmed, setScopeConfirmed] = useState(false);
    const [funnelConfirmed, setFunnelConfirmed] = useState(false);
    const [httpsPort, setHttpsPort] = useState("443");
    const [organizationOrigin, setOrganizationOrigin] = useState("");
    const [visibility, setVisibility] = useState("private");
    const [organizationConfirmed, setOrganizationConfirmed] = useState(false);
    const [publicConfirmed, setPublicConfirmed] = useState(false);
    const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
    const [relayOrigin, setRelayOrigin] = useState("");
    const [enrollmentCode, setEnrollmentCode] = useState("");
    const [relayConfirmed, setRelayConfirmed] = useState(false);
    const [pairTransport, setPairTransport] = useState("direct");
    useEffect(() => {
        setRelayOrigin(state.relay ?? "");
    }, [state.relay]);
    const run = async (request: Data) => {
        setBusy(true);
        setError("");
        if (["networkPropose", "networkProposeScope"].includes(request.operation)) {
            setProposal(null);
            setServeConfirmed(false);
            setScopeConfirmed(false);
            setFunnelConfirmed(false);
        }
        try {
            const result = await action("remoteControl", request);
            if (request.operation === "pair") {
                setInvite(result);
                setInviteExpired(false);
            } else if (["networkPropose", "networkProposeScope"].includes(request.operation))
                setProposal(result);
            else {
                setState(result);
                if (result.directUrl !== state.directUrl) setInvite(null);
                if (request.operation !== "networkInspect") {
                    setProposal(null);
                    setServeConfirmed(false);
                    setScopeConfirmed(false);
                    setFunnelConfirmed(false);
                    setOrganizationConfirmed(false);
                    setPublicConfirmed(false);
                    setRecoveryConfirmed(false);
                    setInvite(null);
                }
            }
        } catch (error) {
            const failure = error as Error & { code?: string };
            setError(
                request.operation.startsWith("network") && typeof failure.code === "string"
                    ? networkDiagnostic(failure.code)
                    : failure.message,
            );
        } finally {
            if (request.operation === "enable") {
                setEnrollmentCode("");
                setRelayConfirmed(false);
            }
            if (["networkApply", "networkChangeScope"].includes(request.operation)) {
                setProposal(null);
                setServeConfirmed(false);
                setScopeConfirmed(false);
                setFunnelConfirmed(false);
                setInvite(null);
            }
            setBusy(false);
        }
    };
    useEffect(() => {
        let live = true;
        const read = () =>
            action("remoteControl", { operation: "status" })
                .then((value) => {
                    if (live) setState(value);
                })
                .catch((error) => {
                    if (live) setError(`Host 已离线或后台连接不可用：${error.message}`);
                });
        void read();
        const timer = setInterval(() => {
            void read();
            setInvite((old) => {
                if (old && old.expiresAt <= Date.now()) {
                    setInviteExpired(true);
                    return null;
                }
                return old;
            });
        }, 2000);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [action]);
    const reconnectUrl =
        pairTransport === "relay"
            ? state.relayUrl
            : state.directUrl && state.directHostId
              ? `${state.directUrl}/#host=${encodeURIComponent(state.directHostId)}`
              : "";
    return (
        <div className="settings-sections" aria-label="手机连接设置">
            <SettingsSection
                title="手机连接"
                description="选择 Direct 的 Tailscale Serve/组织 HTTPS 或自托管 Relay；手机申请后回到此处确认设备和项目。"
            >
                <SettingsGroupCard>
                    <SettingsRow
                        label="Remote 入口"
                        description="默认仅允许这台电脑的浏览器。配置 HTTPS 后手机才能使用；关闭会先停止入口，再等待撤销本应用 Serve 映射。"
                        control={
                            <div className="flex flex-wrap justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    disabled={busy || state.directEnabled}
                                    onClick={() => void run({ operation: "enableDirect" })}
                                >
                                    启用本机入口
                                </Button>
                                <Button
                                    variant="outline"
                                    disabled={busy || !state.directEnabled}
                                    onClick={() => void run({ operation: "disableDirect" })}
                                >
                                    关闭 Remote 并移除映射
                                </Button>
                            </div>
                        }
                    />
                    {reconnectUrl && (
                        <SettingsRow
                            label="当前连接链接"
                            description="已授权的当前浏览器会话可用此链接重连；清除身份后需要重新配对。"
                            controlLayout="wide"
                            control={
                                <Input
                                    aria-label="当前连接链接"
                                    readOnly
                                    value={reconnectUrl}
                                    onFocus={(event) => event.target.select()}
                                />
                            }
                        />
                    )}
                    {(state.directError || state.migrationError) && (
                        <p role="alert">{state.directError || state.migrationError}</p>
                    )}
                    <SettingsRow
                        label="配对入口"
                        description="二维码只包含此入口的公开地址、Host 指纹、房间和短期邀请。"
                        control={
                            <select
                                aria-label="配对入口"
                                value={pairTransport}
                                onChange={(event) => {
                                    setPairTransport(event.target.value);
                                    setInvite(null);
                                }}
                            >
                                <option value="direct">Direct · 本机/组织 HTTPS</option>
                                <option value="relay">Relay · 自托管中继</option>
                            </select>
                        }
                    />
                    <SettingsRow
                        label="配对新手机"
                        description="邀请两分钟内有效，只允许一台设备申请，桌面确认后才有访问权。"
                        control={
                            <Button
                                variant="secondary"
                                disabled={
                                    busy ||
                                    (pairTransport === "relay"
                                        ? !state.connected
                                        : !state.directEnabled)
                                }
                                onClick={() =>
                                    void run({ operation: "pair", transport: pairTransport })
                                }
                            >
                                配对新手机
                            </Button>
                        }
                    />
                </SettingsGroupCard>
                {invite && (
                    <div>
                        <img width="256" height="256" src={invite.qr} alt="手机配对二维码" />
                        <p>
                            {invite.payload.startsWith("https://")
                                ? "HTTPS 配对链接"
                                : "仅本机开发链接，手机无法访问"}
                            ；两分钟内有效。请勿分享给不信任的设备。
                        </p>
                        <label>
                            配对链接
                            <textarea
                                aria-label="配对链接"
                                className="w-full"
                                readOnly
                                value={invite.payload}
                                onFocus={(event) => event.target.select()}
                            />
                        </label>
                        <Button
                            variant="outline"
                            onClick={() => {
                                void navigator.clipboard
                                    .writeText(invite.payload)
                                    .catch(() => setError("复制失败，请选中链接手动复制"));
                            }}
                        >
                            复制链接
                        </Button>
                        <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => void run({ operation: "cancelPair" })}
                        >
                            取消邀请
                        </Button>
                    </div>
                )}
                {inviteExpired && <p role="status">配对邀请已过期，请生成新邀请。</p>}
                {error && <p role="alert">{error}</p>}
            </SettingsSection>
            <SettingsSection
                title="自托管 Relay"
                description="由你的组织提供 HTTPS 同源 Remote 页面。Host 仅向此来源建立出站 WSS；手机仍须核对指纹并经桌面批准。"
            >
                <SettingsGroupCard>
                    <fieldset disabled={busy} className="p-4">
                        <legend>登记或重新连接 Relay</legend>
                        <label>
                            Relay HTTPS 来源
                            <Input
                                aria-label="Relay HTTPS 来源"
                                value={relayOrigin}
                                placeholder="https://relay.example.org"
                                onChange={(event) => {
                                    setRelayOrigin(event.target.value);
                                    setRelayConfirmed(false);
                                }}
                            />
                        </label>
                        <label>
                            管理员一次性登记码
                            <Input
                                aria-label="管理员一次性登记码"
                                type="password"
                                autoComplete="off"
                                value={enrollmentCode}
                                onChange={(event) => {
                                    setEnrollmentCode(event.target.value);
                                    setRelayConfirmed(false);
                                }}
                            />
                        </label>
                        <p>
                            首次登记、更换来源或重新登记需要管理员生成的十分钟一次性码。已登记来源可留空以重新启用；长期凭据只保存于
                            Host 加密设置，不进入手机链接。
                        </p>
                        <label>
                            <input
                                type="checkbox"
                                checked={relayConfirmed}
                                onChange={(event) => setRelayConfirmed(event.target.checked)}
                            />{" "}
                            我信任此 HTTPS 来源提供的 Remote 页面，并确认向此 Relay
                            登记或重新连接。重新登记会断开旧 Relay 通道。
                        </label>
                        <div className="flex gap-2">
                            <Button
                                disabled={busy || !relayConfirmed || !relayOrigin}
                                onClick={() =>
                                    void run({
                                        operation: "enable",
                                        relay: relayOrigin,
                                        confirmed: true,
                                        ...(enrollmentCode ? { code: enrollmentCode } : {}),
                                    })
                                }
                            >
                                登记或启用 Relay
                            </Button>
                            <Button
                                variant="outline"
                                disabled={busy || !state.enabled}
                                onClick={() => void run({ operation: "disable" })}
                            >
                                关闭 Relay 连接
                            </Button>
                        </div>
                        <p role="status">
                            {state.connected
                                ? "Relay 已连接；手机实际可达性尚未验证。"
                                : state.enabled
                                  ? "Relay 未连接；请检查服务与 HTTPS 证书。"
                                  : "Relay 已关闭。"}
                        </p>
                        {state.relayError && <p role="alert">{state.relayError}</p>}
                    </fieldset>
                </SettingsGroupCard>
            </SettingsSection>
            <SettingsSection
                title="Direct 网络"
                description="只转发 Remote 入口。不会发布 Core 或桌面管理接口，也不会自动切换 Funnel。"
            >
                <SettingsGroupCard>
                    <p>
                        手机使用 Serve 时必须加入同一 tailnet。组织策略、手机 tailnet
                        成员资格及实际可达性尚未验证，本机检测成功不表示手机可连接。
                    </p>
                    <p>Host 离线时请回到电脑检查后台；配对链接过期时请重新生成邀请。</p>
                    <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run({ operation: "networkInspect" })}
                    >
                        检测网络工具
                    </Button>
                    {state.network?.inspection && (
                        <div role="status">
                            <p>Tailscale 版本：{state.network.inspection.version ?? "未知"}</p>
                            {state.network.inspection.diagnostic && (
                                <p>{networkDiagnostic(state.network.inspection.diagnostic)}</p>
                            )}
                            {state.network.inspection.login && (
                                <p>
                                    {networkLoginDiagnostics[state.network.inspection.login] ??
                                        networkLoginDiagnostics.unknown}
                                </p>
                            )}
                            {state.network.inspection.https && (
                                <p>
                                    {state.network.inspection.https === "enabled"
                                        ? "Host HTTPS 能力已启用；手机证书与网络链路仍需验证。"
                                        : networkDiagnostic(
                                              state.network.inspection.https === "disabled"
                                                  ? "https-disabled"
                                                  : "https-unknown",
                                          )}
                                </p>
                            )}
                        </div>
                    )}
                    {state.network?.diagnostic && (
                        <p role="alert">{networkDiagnostic(state.network.diagnostic)}</p>
                    )}
                    <fieldset disabled={busy} className="p-4">
                        <legend>Tailscale Serve · tailnet 私人入口</legend>
                        <label>
                            HTTPS 端口
                            <Input
                                aria-label="Serve HTTPS 端口"
                                type="number"
                                min={1}
                                max={65535}
                                value={httpsPort}
                                onChange={(event) => {
                                    setHttpsPort(event.target.value);
                                    setProposal(null);
                                    setServeConfirmed(false);
                                }}
                            />
                        </label>
                        <Button
                            disabled={busy || !state.directEnabled}
                            onClick={() =>
                                void run({
                                    operation: "networkPropose",
                                    httpsPort: Number(httpsPort),
                                })
                            }
                        >
                            生成 Serve 方案
                        </Button>
                        {proposal && !proposal.scope && (
                            <div>
                                <p>{proposal.confirmation}</p>
                                <p>入口：{proposal.publicOrigin}</p>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={serveConfirmed}
                                        onChange={(event) =>
                                            setServeConfirmed(event.target.checked)
                                        }
                                    />
                                    我明确确认按此方案更改本机网络配置，创建持久 Serve 映射。
                                </label>
                                <Button
                                    disabled={busy || !serveConfirmed}
                                    onClick={() =>
                                        void run({
                                            operation: "networkApply",
                                            proposalId: proposal.proposalId,
                                            confirmed: true,
                                        })
                                    }
                                >
                                    确认并应用 Serve
                                </Button>
                            </div>
                        )}
                        {!proposal && <p>生成方案后需要明确确认本机网络配置范围，才会执行 CLI。</p>}
                    </fieldset>
                    <fieldset disabled={busy} className="p-4">
                        <legend>可选 Funnel · 公网入口</legend>
                        <p>
                            默认保持私人入口。Funnel 会让互联网访问 Remote 入口；仍需 Host 指纹、
                            短期邀请、桌面确认与逐操作授权。公网能力未认证，策略、手机与实际可达性未知。
                            访问范围变化会使当前邀请和连接失效；请重新连接，配对时生成新邀请。
                        </p>
                        <p>
                            已保存范围：
                            {state.network?.scope === "public"
                                ? "公网"
                                : state.network?.scope === "private"
                                  ? "私人"
                                  : "待核对"}
                        </p>
                        {state.network?.inspection && (
                            <p>
                                本机 Funnel 允许端口：
                                {state.network.inspection.funnelPorts == null
                                    ? "未知"
                                    : state.network.inspection.funnelPorts.length
                                      ? state.network.inspection.funnelPorts.join("、")
                                      : "无"}
                                ；不代表公网验证通过。
                            </p>
                        )}
                        {state.network?.reconciliation && (
                            <p>
                                中断操作核对：
                                {{
                                    destination: "目标范围仍在",
                                    source: "原范围仍在",
                                    absent: "映射已不存在",
                                    changed: "映射已被外部更改",
                                }[state.network.reconciliation as string] ?? "未知"}
                                。请在下方明确恢复或移除。
                            </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                            <Button
                                disabled={
                                    busy ||
                                    !state.directEnabled ||
                                    state.network?.kind !== "tailscale" ||
                                    state.network?.scope !== "private"
                                }
                                onClick={() =>
                                    void run({ operation: "networkProposeScope", scope: "public" })
                                }
                            >
                                生成公网 Funnel 方案
                            </Button>
                            <Button
                                variant="outline"
                                disabled={
                                    busy ||
                                    !state.directEnabled ||
                                    state.network?.kind !== "tailscale" ||
                                    state.network?.scope !== "public"
                                }
                                onClick={() =>
                                    void run({ operation: "networkProposeScope", scope: "private" })
                                }
                            >
                                生成恢复私人入口方案
                            </Button>
                        </div>
                        {proposal?.scope && (
                            <div>
                                <p>{proposal.confirmation}</p>
                                <p>
                                    入口：{proposal.publicOrigin} ·{" "}
                                    {proposal.sourceScope === "private" ? "私人" : "公网"} →{" "}
                                    {proposal.scope === "public" ? "公网" : "私人"}
                                </p>
                                <label className="block">
                                    <input
                                        type="checkbox"
                                        checked={scopeConfirmed}
                                        onChange={(event) =>
                                            setScopeConfirmed(event.target.checked)
                                        }
                                    />
                                    我明确确认按此方案更改入口访问范围。
                                </label>
                                {proposal.scope === "public" && (
                                    <label className="block">
                                        <input
                                            type="checkbox"
                                            checked={funnelConfirmed}
                                            onChange={(event) =>
                                                setFunnelConfirmed(event.target.checked)
                                            }
                                        />
                                        我再次确认将此 Remote 入口公开到互联网。
                                    </label>
                                )}
                                <Button
                                    disabled={
                                        busy ||
                                        !scopeConfirmed ||
                                        (proposal.scope === "public" && !funnelConfirmed)
                                    }
                                    onClick={() =>
                                        void run({
                                            operation: "networkChangeScope",
                                            proposalId: proposal.proposalId,
                                            confirmed: scopeConfirmed,
                                            publicConfirmed: funnelConfirmed,
                                        })
                                    }
                                >
                                    确认更改入口范围
                                </Button>
                            </div>
                        )}
                    </fieldset>
                    <fieldset disabled={busy} className="p-4">
                        <legend>组织 HTTPS</legend>
                        <label>
                            HTTPS origin
                            <Input
                                aria-label="组织 HTTPS origin"
                                placeholder="https://remote.example.com"
                                value={organizationOrigin}
                                onChange={(event) => {
                                    setOrganizationOrigin(event.target.value);
                                    setOrganizationConfirmed(false);
                                    setPublicConfirmed(false);
                                }}
                            />
                        </label>
                        <label>
                            访问范围
                            <select
                                aria-label="组织入口访问范围"
                                value={visibility}
                                onChange={(event) => {
                                    setVisibility(event.target.value);
                                    setOrganizationConfirmed(false);
                                    setPublicConfirmed(false);
                                }}
                            >
                                <option value="private">组织私有网络</option>
                                <option value="public">可能公开访问</option>
                            </select>
                        </label>
                        <p>
                            这里只保存应用接受的精确 HTTPS 来源和配对链接。组织须自行配置指向 Remote
                            的代理、证书、WebSocket 和 ACL；代理必须保留该来源的
                            Host，不能依赖转发身份头。
                        </p>
                        <label className="block">
                            <input
                                type="checkbox"
                                checked={organizationConfirmed}
                                onChange={(event) => setOrganizationConfirmed(event.target.checked)}
                            />
                            我确认组织入口已安排妥当，并同意保存此来源；应用不会配置或验证代理、证书和
                            ACL。
                        </label>
                        {visibility === "public" && (
                            <label className="block">
                                <input
                                    type="checkbox"
                                    checked={publicConfirmed}
                                    onChange={(event) => setPublicConfirmed(event.target.checked)}
                                />
                                我再次确认此 HTTPS 入口可能被公网访问。
                            </label>
                        )}
                        <Button
                            disabled={
                                busy ||
                                !state.directEnabled ||
                                !organizationConfirmed ||
                                (visibility === "public" && !publicConfirmed)
                            }
                            onClick={() =>
                                void run({
                                    operation: "networkConfigureOrganization",
                                    publicOrigin: organizationOrigin,
                                    visibility,
                                    confirmed: true,
                                    publicConfirmed,
                                })
                            }
                        >
                            保存组织 HTTPS 来源
                        </Button>
                    </fieldset>
                    {state.network?.kind && (
                        <fieldset disabled={busy} className="p-4">
                            <legend>恢复或移除本应用网络配置</legend>
                            <p>
                                恢复只读核对已记录映射的实际范围，不重放发布命令；移除只撤销精确匹配的本应用
                                Serve/Funnel
                                映射，组织模式仅清除应用来源。外部更改的映射不会被覆盖。
                            </p>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={recoveryConfirmed}
                                    onChange={(event) => setRecoveryConfirmed(event.target.checked)}
                                />
                                我确认仅处理本应用记录，并选择下方恢复或移除操作。
                            </label>
                            <div className="flex gap-2">
                                <Button
                                    disabled={busy || !recoveryConfirmed}
                                    onClick={() =>
                                        void run({ operation: "networkRecover", confirmed: true })
                                    }
                                >
                                    核对并恢复
                                </Button>
                                <Button
                                    variant="outline"
                                    disabled={busy || !recoveryConfirmed}
                                    onClick={() =>
                                        void run({ operation: "networkRemove", confirmed: true })
                                    }
                                >
                                    移除网络配置
                                </Button>
                            </div>
                        </fieldset>
                    )}
                </SettingsGroupCard>
            </SettingsSection>
            {!!state.pending.length && (
                <SettingsSection
                    title="确认手机"
                    description="核对浏览器显示的设备指纹，再明确选择项目与权限。"
                >
                    {state.pending.map((device: Data) => (
                        <GrantReview
                            key={device.id}
                            device={device}
                            projects={projects}
                            pending
                            busy={busy}
                            run={run}
                        />
                    ))}
                </SettingsSection>
            )}
            <SettingsSection
                title="设备授权"
                description="保存范围或撤销会关闭该设备的现有连接。已下载的数据无法追回。"
            >
                <SettingsGroupCard>
                    {(state.deviceGrants ?? []).map((device: Data) => (
                        <GrantReview
                            key={`${device.devicePeerId}:${device.revision}`}
                            device={device}
                            projects={projects}
                            busy={busy}
                            run={run}
                        />
                    ))}
                    {!state.deviceGrants?.length && (
                        <p className="settings-card-empty">还没有已配对设备</p>
                    )}
                </SettingsGroupCard>
            </SettingsSection>
        </div>
    );
}
