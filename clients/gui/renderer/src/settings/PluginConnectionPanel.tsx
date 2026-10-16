import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { Feedback } from "./common.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { PluginAuthConfiguration } from "./PluginAuthConfiguration.js";
import { pluginMcpStateLabel } from "./pluginResources.js";
import type { PluginDetail } from "./PluginCenter.js";
import type { Data } from "../services.js";

type AuthState = "notStarted" | "pending" | "ready" | "failed" | "cancelled" | "unknown";
type Props = {
  detail: PluginDetail;
  snapshot?: Data;
  loading: boolean;
  error: string;
  disabled: boolean;
  command: (operation: string, values?: Data) => Promise<Data>;
  mutate: (operation: "pluginAuth" | "pluginConnection", values: Data) => Promise<Data | undefined>;
  onRefresh: () => void;
  onAuthActivity: (id: string, pending: boolean) => void;
  onStart: () => void;
  draftBusy: boolean;
  connectorConfiguration: ReactNode;
};

/** Projects the installed package's authoritative connection snapshot; consent is only a local draft. */
export function PluginConnectionPanel({ detail, snapshot, loading, error, disabled, command, mutate,
  onRefresh, onAuthActivity, onStart, draftBusy, connectorConfiguration }: Props) {
  const [auth, setAuth] = useState<Record<string, AuthState>>({});
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [consentOpen, setConsentOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [acting, setActing] = useState("");
  const [fullDigest, setFullDigest] = useState(false);
  const generation = useRef(0);
  const actingRef = useRef(false);
  const servers: Data[] = snapshot?.servers ?? [];
  const connectors: Data[] = snapshot?.connectors ?? [];
  const authenticatedServers = servers.filter(server => server.config?.authentication);
  useEffect(() => {
    const request = ++generation.current;
    setAuthLoading(true);
    setAuthError("");
    void Promise.allSettled(authenticatedServers.map(async server => {
      const result = await command("pluginAuth", { id: detail.id, server: server.serverId, authOperation: "status" });
      // Core returns null before the first authentication attempt; this is not UNKNOWN.
      return [server.serverId, result === null ? "notStarted" : result.status] as const;
    })).then(results => {
      if (request !== generation.current) return;
      const next: Record<string, AuthState> = {};
      results.forEach((result, index) => {
        const id = authenticatedServers[index].serverId;
        next[id] = result.status === "fulfilled" && ["notStarted", "pending", "ready", "failed", "cancelled"].includes(result.value[1])
          ? result.value[1] : "unknown";
      });
      setAuth(next);
      if (results.some(result => result.status === "rejected")) setAuthError("认证状态未能确认，请核对后再继续。");
      setAuthLoading(false);
    });
    return () => { ++generation.current; };
  }, [detail.id, detail.installedDigest, snapshot, command]);

  const authenticate = async (server: Data, operation: string) => {
    if (disabled || actingRef.current) return;
    actingRef.current = true;
    const request = generation.current;
    setActing(`${server.serverId}:${operation}`);
    const result = await mutate("pluginAuth", { id: detail.id, server: server.serverId,
      authOperation: operation, expectedDigest: detail.installedDigest });
    // A refresh may have replaced this projection while the operation was in flight.
    if (request === generation.current) {
      setAuth(previous => ({ ...previous, [server.serverId]: result === null ? "notStarted" : result?.status ?? "unknown" }));
      if (result === undefined) setAuthError("认证结果尚未确认，请先核对认证状态。");
    }
    setActing("");
    actingRef.current = false;
  };
  const needsAuth = (server: Data) => server.state !== "disabled" && ((server.state === "authRequired" && auth[server.serverId] !== "ready") ||
    (server.config?.authentication && auth[server.serverId] !== "ready" &&
      (server.authentication === "required" || snapshot?.authenticationTiming === "ON_INSTALL")));
  const authPending = authenticatedServers.some(server => auth[server.serverId] === "pending" || auth[server.serverId] === "unknown");
  const authUnknown = authenticatedServers.some(server => auth[server.serverId] === "unknown");
  const authRequired = servers.some(needsAuth);
  const connected = snapshot?.state === "connected" && servers.some(server => server.state === "connected");
  const partial = snapshot?.state === "partial";
  const cleanupUnknown = snapshot?.state === "cleanupUnknown";
  const uncertain = snapshot?.state === "unknown" || servers.some(server => server.state === "unknown");
  const allDisabled = servers.length > 0 && servers.every(server => server.state === "disabled") && !connectors.length;
  const configurationBlocked = !servers.length && !connectors.length && snapshot?.diagnostics?.some((item: Data) => item.class === "configuration" || item.class === "policy");
  const mappingRequired = connectors.some(connector => connector.state === "missingMapping" || connector.state === "authRequired");
  const hasConnections = servers.length > 0 || connectors.length > 0;
  const blocked = disabled || loading || authLoading || !!acting;
  const title = loading || !snapshot ? "正在读取连接状态…" : cleanupUnknown ? "清理结果待核对"
    : uncertain ? "连接状态待核对" : allDisabled ? "服务已停用" : configurationBlocked ? "连接配置需要处理"
    : partial ? "部分服务未连接" : authUnknown ? "认证结果待核对" : authPending ? "等待认证完成" : authRequired ? "需要认证" : mappingRequired ? "需要配置连接"
    : connected ? "已连接" : !hasConnections ? "已安装"
    : authenticatedServers.length && authenticatedServers.every(server => auth[server.serverId] === "ready") ? "认证完成，等待连接" : "等待连接";
  const description = cleanupUnknown ? "旧服务的清理尚未确认，暂不可重新连接。"
    : uncertain ? "请先重新读取当前连接状态，不会重新提交连接。"
    : allDisabled ? "当前配置未启用任何 MCP 服务。"
    : configurationBlocked ? "服务声明无效或受宿主策略限制，请查看连接诊断。"
    : authUnknown ? "尚未确认认证结果，请先核对认证状态。"
    : authPending ? "请完成认证并核对状态，尚未连接的服务不会自动启动。"
    : authRequired ? "完成认证后，再确认信任并连接服务。"
    : mappingRequired ? "请配置此插件声明的 Connector 后再连接。"
    : connected ? "插件服务已可在对话中使用。"
    : partial ? "部分服务可用，请查看未连接服务的状态。"
    : !hasConnections && snapshot ? "插件已安装并启用。" : "连接前，请确认信任当前安装快照。";

  return <section className="plugin-status-panel" aria-label="插件连接状态">
    <h2>{title}</h2><p className="plugin-status-description">{description}</p>
    <Feedback error={error || authError} />
    {!!error && <Button variant="outline" onClick={onRefresh}>重新读取连接状态</Button>}
    {!loading && snapshot && <>
      {servers.map(server => {
        const status = auth[server.serverId];
        const pending = status === "pending" || status === "unknown";
        const requires = needsAuth(server);
        return <div className="plugin-service-row" key={server.serverId}>
          <div className="plugin-service-info"><strong>{server.config?.title || (servers.length === 1 ? `${detail.displayName || detail.name} MCP` : server.serverId)}</strong>
            <p>{status === "unknown" ? "认证结果待核对" : pending ? "认证进行中" : requires ? "需要认证" : `${status === "ready" ? "已认证 · " : ""}${pluginMcpStateLabel(server.state)}`}</p>
            {server.message && <Feedback error={String(server.message)} />}
          </div>
          {server.config?.authentication && <div className="plugin-service-actions">
            {pending ? <><Button disabled={blocked} onClick={() => void authenticate(server, "status")}>核对认证状态</Button>
              {status === "pending" && <Button variant="outline" disabled={blocked} onClick={() => void authenticate(server, "cancel")}>取消本次认证</Button>}</>
              : requires ? <Button disabled={blocked} onClick={() => void authenticate(server, "start")}>{server.config.authenticationRequirements?.apiKey ? "启用认证" : "在浏览器中认证"}</Button> : null}
          </div>}
        </div>;
      })}
      {mappingRequired && connectorConfiguration}
      {uncertain && <Button variant="outline" disabled={loading} onClick={onRefresh}>核对连接状态</Button>}
      {(connected || partial || (!hasConnections && !configurationBlocked)) && <div className="plugin-connection-actions plugin-service-actions">
        <Button disabled={disabled || draftBusy || !detail.enabled} onClick={onStart}>开始对话</Button>
        {(connected || partial) && <Button variant="outline" disabled={blocked} onClick={() => {
          setConsent(false); setConsentOpen(false);
          void mutate("pluginConnection", { id: detail.id, expectedDigest: detail.installedDigest, connect: false });
        }}>断开并撤销信任</Button>}
      </div>}
      {(connected || partial) && <p className="plugin-status-note">断开后，再次连接需要重新确认信任。</p>}
      {hasConnections && !connected && !cleanupUnknown && !uncertain && !allDisabled && !authPending && !authRequired && !mappingRequired && <>
        {!consentOpen ? <Button disabled={blocked} onClick={() => setConsentOpen(true)}>审阅并连接</Button> :
          <div className="plugin-trust-review">
            <h3>本次授权</h3><p>允许启动此插件声明的 MCP 服务，并在对话中使用其工具。</p>
            <p>安装快照 <code>{fullDigest ? detail.installedDigest : `${detail.installedDigest?.slice(0, 8)}…${detail.installedDigest?.slice(-8)}`}</code>{" "}
              <Button variant="link" onClick={() => setFullDigest(value => !value)}>{fullDigest ? "收起完整摘要" : "查看完整摘要"}</Button></p>
            <label className="plugin-consent"><input type="checkbox" checked={consent} disabled={blocked}
              onChange={event => setConsent(event.target.checked)} />
              <span>我信任当前安装快照，并允许启动其 MCP 服务。</span></label>
            <div className="plugin-service-actions"><Button disabled={blocked || !consent} onClick={() => {
              if (!consent) return;
              setConsent(false);
              void mutate("pluginConnection", { id: detail.id, expectedDigest: detail.installedDigest, connect: true });
            }}>信任并连接</Button><Button variant="outline" disabled={blocked} onClick={() => { setConsent(false); setConsentOpen(false); }}>暂不连接</Button></div>
            {!consent && <p className="plugin-status-note">请先确认信任当前安装快照。</p>}
          </div>}
      </>}
      {!connected && !partial && !consentOpen && authenticatedServers.map(server => <PluginAuthConfiguration key={server.serverId} pluginId={detail.id}
        server={server} digest={detail.installedDigest!} disabled={disabled || connected || partial}
        command={command} onActivityChange={onAuthActivity} onSaved={onRefresh} />)}
      {!mappingRequired && connectors.length > 0 && connectorConfiguration}
      {!!snapshot.diagnostics?.length && <SettingsDisclosure title="连接诊断"><pre>{JSON.stringify(snapshot.diagnostics, null, 2)}</pre></SettingsDisclosure>}
    </>}
  </section>;
}
