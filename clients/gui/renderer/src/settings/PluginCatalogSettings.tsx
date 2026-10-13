import { useCallback, useEffect, useRef, useState } from "react";
import { Package } from "lucide-react";
import {PluginAuthConfiguration} from "./PluginAuthConfiguration.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback, SettingsDialog } from "./common.js";
import { SettingsBadge } from "./SettingsPageParts.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { ResourceScope, type ScopedProps } from "./ScopedSkillsSettings.js";
import type { Data } from "../services.js";

type PluginSkill = {
  id: string;
  revision: string;
  name: string;
  description: string;
  allowImplicitInvocation: boolean;
  onboarding: boolean;
};
type PluginDetail = {
  revision: number;
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string | null;
  installed: boolean;
  installedVersion: string | null;
  installedDigest: string | null;
  installedSkills: PluginSkill[];
  installedOnboardingSkill: string | null;
  enabled: boolean;
  source: string;
  sourceDigest: string;
  catalogSource?: unknown;
  sourceKind?: string;
  resolvedCommit?: string;
  packageVersion?: string;
  integrity?: string;
  components: string[];
  diagnostics: string[];
  skills: PluginSkill[];
  onboardingSkill: string | null;
};
type PluginList = {
  revision: number;
  data: PluginDetail[];
  marketplaces: { name: string; root: string }[];
  errors: string[];
};
type PluginMutation =
  | "marketplaceAdd"
  | "pluginInstall"
  | "pluginConfigure"
  | "pluginUninstall"
  | "pluginSetup"
  | "pluginResolve"
  | "marketplaceAddGit"
  | "marketplaceRemove"
  | "marketplaceUpdate"
  | "pluginConnection"
  | "pluginAuth"
  | "pluginAuthConfigure"
  | "connectorConfigure";
type PluginSubmission = { mutation: PluginMutation; requestId: string };
type PluginReceipt =
  | { confirmed: false; state: string }
  | {
      confirmed: true;
      accepted: boolean;
      result?: {
        thread?: { id: string };
        turn?: { id: string };
        requestId?: string;
      };
      error?: PluginFailure;
      warning?: string;
    };
const pluginMethods: Record<string, PluginMutation> = {
  "areal/marketplace/add": "marketplaceAdd",
  "areal/plugin/install": "pluginInstall",
  "areal/plugin/configure": "pluginConfigure",
  "areal/plugin/uninstall": "pluginUninstall",
  "areal/plugin/setup": "pluginSetup",
  "areal/plugin/resolve": "pluginResolve",
  "areal/marketplace/addGit": "marketplaceAddGit",
  "areal/marketplace/remove": "marketplaceRemove",
  "areal/marketplace/update": "marketplaceUpdate",
  "areal/plugin/connection": "pluginConnection",
  "areal/plugin/auth": "pluginAuth",
  "areal/plugin/auth/configure": "pluginAuthConfigure",
  "areal/plugin/connector/configure": "connectorConfigure",
};
type PluginFailure = {
  message: string;
  code?: string | number;
  reason?: string;
  submissionUnknown?: boolean;
  requestId?: string;
};
function failure(cause: unknown): PluginFailure {
  if (cause instanceof Error) return cause;
  return { message: "插件操作失败，请刷新目录核对状态。" };
}
function failureText(error: PluginFailure | null) {
  if (!error) return "";
  return [
    error.submissionUnknown
      ? "提交结果待核对，不会自动重发。请点击“核对插件提交”查询原请求。"
      : "",
    error.message,
    error.code !== undefined ? `错误：${error.code}` : "",
    error.reason,
    error.requestId ? `请求：${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** 插件包状态归 Core；手工 Skill/MCP 设置仍使用各自原有入口。 */
export type PluginCatalogProps = ScopedProps & {
  onOpenThread?: (projectId: string, threadId: string) => void;
};
export function PluginCatalogSettings({
  project,
  thread,
  action,
  onOpenThread,
}: PluginCatalogProps) {
  const projectId = project?.id;
  const connected = !!project?.state?.connected;
  const [catalog, setCatalog] = useState<PluginList | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState<PluginFailure | null>(null);
  const [message, setMessage] = useState("");
  const [setupThreadId, setSetupThreadId] = useState<string | null>(null);
  const [submission, setSubmission] = useState<PluginSubmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("catalog");
  const [scope, setScope] = useState("user");
  const [adding, setAdding] = useState(false);
  const [root, setRoot] = useState("");
  const [addKind, setAddKind] = useState("local");
  const [gitRef, setGitRef] = useState("");
  const [preview, setPreview] = useState<PluginDetail | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [connectionTrust, setConnectionTrust] = useState(false);
  const [connections, setConnections] = useState<Data[]>([]);
  const [connectionError, setConnectionError] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [connectorToken, setConnectorToken] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const readGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const actionRef = useRef(action);
  actionRef.current = action;
  const api = useCallback(
    async (operation: string, values: Data = {}) => {
      try {
        return await actionRef.current("manage", { projectId, operation, ...values });
      } finally {
        // Main clears its configuration gate before replying, including UNKNOWN.
        // Re-read only the catalog; keep the form's original submission receipt alive.
        if (operation === "pluginAuthCredential")
          window.dispatchEvent(new Event("areal-plugins-changed"));
      }
    },
    [projectId],
  );
  const refresh = useCallback(async () => {
    if (!connected) return;
    const generation = ++readGeneration.current;
    setLoading(true);
    setReadError("");
    try {
      const capability = await api("pluginCapabilities");
      if (!mounted.current || generation !== readGeneration.current) return;
      setSupported(capability.enabled);
      if (!capability.enabled) {
        setCatalog(null);
        return;
      }
      const result: PluginList = await api("plugins");
      if (mounted.current && generation === readGeneration.current)
        setCatalog(result);
    } catch (cause) {
      if (mounted.current && generation === readGeneration.current) {
        setReadError(failure(cause).message);
        setCatalog(null);
      }
    } finally {
      if (mounted.current && generation === readGeneration.current)
        setLoading(false);
    }
  }, [api, connected]);
  useEffect(() => {
    mounted.current = true;
    const changed = () => void refresh();
    window.addEventListener("areal-plugins-changed", changed);
    void refresh();
    return () => {
      window.removeEventListener("areal-plugins-changed", changed);
      mounted.current = false;
      readGeneration.current++;
      detailGeneration.current++;
    };
  }, [refresh]);
  const readDetail = useCallback(
    async (id: string) => {
      const generation = ++detailGeneration.current;
      setDetailLoading(true);
      setDetail(null);
      setDetailError("");
      try {
        const result: PluginDetail = await api("plugin", { id });
        if (mounted.current && generation === detailGeneration.current)
          setDetail(result);
      } catch (cause) {
        if (mounted.current && generation === detailGeneration.current)
          setDetailError(failure(cause).message);
      } finally {
        if (mounted.current && generation === detailGeneration.current)
          setDetailLoading(false);
      }
    },
    [api],
  );
  useEffect(() => {
    if (selected) void readDetail(selected);
  }, [selected, readDetail]);
  useEffect(() => {
    setPreview(null);
    setReviewed(false);
    setConnectionTrust(false);
    setConnections([]);
    setConnectorToken("");
    setCredentialRef("");
  }, [selected]);
  useEffect(() => {
    setConnectionTrust(false);
  }, [detail?.installedDigest]);
  useEffect(() => {
    if (!detail?.installed) {
      setConnections([]);
      return;
    }
    let current = true;
    setConnectionError("");
    void api("pluginMcp")
      .then((result) => {
        if (current)
          setConnections(
            (Array.isArray(result.data) ? result.data : []).filter(
              (row: Data) => row.pluginId === detail.id,
            ).flatMap((row:Data) => Array.isArray(row.servers) && row.servers.length ? row.servers.map((server:Data) => ({...server,pluginId:row.pluginId,state:server.state ?? row.state,authenticationTiming:row.authenticationTiming})) : [row]),
          );
      })
      .catch((cause) => {
        if (current) setConnectionError(failure(cause).message);
      });
    return () => {
      current = false;
    };
  }, [
    detail?.id,
    detail?.installedDigest,
    detail?.installed,
    api,
    catalog?.revision,
    busy,
  ]);
  const pending = !!project?.pending?.length;
  const disabled =
    !connected ||
    busy ||
    loading ||
    !catalog ||
    !supported ||
    pending ||
    !!error?.submissionUnknown;
  const mutate = async (operation: PluginMutation, values: Data) => {
    if (active.current || disabled || !connected) return;
    active.current = true;
    setBusy(true);
    setError(null);
    setMessage("");
    const requestId = crypto.randomUUID();
    try {
      const result = await api(operation, { ...values, requestId });
      if (!mounted.current) return;
      if (operation === "pluginResolve") {
        setPreview(result as PluginDetail);
        setReviewed(false);
      }
      window.dispatchEvent(new Event("areal-plugins-changed"));
      if (operation === "pluginSetup" && result.thread?.id)
        setSetupThreadId(result.thread.id);
      if (operation === "marketplaceAdd" || operation === "marketplaceAddGit") {
        setAdding(false);
        setRoot("");
      }
      setMessage(
        operation === "pluginAuth" ? `认证状态：${result?.status ?? "尚未发起"}` : operation === "pluginSetup"
          ? `设置技能已提交到对话 ${result.thread?.id ?? thread?.id ?? ""}。请回到对话查看执行与审批。`
          : "操作已完成。",
      );
    } catch (cause) {
      if (mounted.current) {
        const error = failure(cause);
        if (error.submissionUnknown && operation !== "pluginAuth")
          setSubmission({
            mutation: operation,
            requestId: error.requestId ?? requestId,
          });
        setError(
          error.submissionUnknown && operation !== "pluginAuth"
            ? {
                ...error,
                message: error.message,
                requestId: error.requestId ?? requestId,
              }
            : operation === "pluginAuth" ? {...error,submissionUnknown:false} : error,
        );
      }
    } finally {
      // 只重读权威状态；冲突或 UNKNOWN 不会触发任何写入重试。
      if (mounted.current) {
        await refresh();
        if (selected) await readDetail(selected);
        if (mounted.current) setBusy(false);
      }
      active.current = false;
    }
  };
  const pendingPlugin = project?.pending?.find(
    (entry: Data) =>
      !entry.awaitingResponse &&
      pluginMethods[entry.method] &&
      typeof entry.params?.requestId === "string",
  );
  const recoverable: PluginSubmission | null =
    submission ??
    (pendingPlugin
      ? {
          mutation: pluginMethods[pendingPlugin.method],
          requestId: pendingPlugin.params.requestId,
        }
      : null);
  const recoverSubmission = async () => {
    if (!recoverable || active.current || !connected) return;
    active.current = true;
    setBusy(true);
    setMessage("");
    try {
      const receipt: PluginReceipt = await api("pluginSubmission", recoverable);
      if (!mounted.current) return;
      if (!receipt.confirmed) {
        setSubmission(recoverable);
        setError({
          message:
            receipt.state === "accepted"
              ? "原提交仍在处理中，请稍后再次核对。"
              : "原提交结果仍未确认，请稍后再次核对。",
          submissionUnknown: true,
          requestId: recoverable.requestId,
        });
        return;
      }
      setSubmission(null);
      if (!receipt.accepted) {
        setError({
          message: receipt.error?.message ?? "原插件操作已确认失败。",
          code: receipt.error?.code,
          reason: receipt.error?.reason,
          requestId: recoverable.requestId,
        });
        return;
      }
      setError(null);
      if (recoverable.mutation === "pluginSetup" && receipt.result?.thread?.id)
        setSetupThreadId(receipt.result.thread.id);
      if (
        recoverable.mutation === "marketplaceAdd" ||
        recoverable.mutation === "marketplaceAddGit"
      ) {
        setAdding(false);
        setRoot("");
      }
      setMessage(receipt.warning ?? "原提交已确认完成，未重新执行。");
    } catch (cause) {
      if (mounted.current) {
        const error = failure(cause);
        setSubmission(recoverable);
        setError({
          ...error,
          message: `无法核对原提交：${error.message}`,
          submissionUnknown: true,
          requestId: recoverable.requestId,
        });
      }
    } finally {
      if (mounted.current) {
        await refresh();
        if (selected) await readDetail(selected);
        if (mounted.current) setBusy(false);
      }
      active.current = false;
    }
  };
  const recoveryButton = recoverable && (
    <Button
      variant="outline"
      disabled={busy || loading}
      onClick={() => void recoverSubmission()}
    >
      核对插件提交
    </Button>
  );
  const previewCurrent =
    !!detail &&
    !!preview &&
    preview.id === detail.id &&
    preview.source === detail.source &&
    preview.sourceDigest === detail.sourceDigest &&
    preview.revision === catalog?.revision;
  const install = () => {
    if (!previewCurrent || !reviewed || !preview) return;
    void mutate("pluginInstall", {
      id: preview.id,
      source: preview.source,
      expectedDigest: preview.sourceDigest,
      scope,
      expectedRevision: preview.revision,
    });
  };
  const saveConnectorCredential = async () => {
    if (
      !detail?.installedDigest ||
      !connectorId.trim() ||
      !connectorToken ||
      credentialBusy
    )
      return;
    const requestId = crypto.randomUUID();
    const secret = connectorToken;
    setConnectorToken("");
    setCredentialBusy(true);
    setError(null);
    try {
      const saved = await api("connectorCredential", {
        id: detail.id,
        connectorId: connectorId.trim(),
        provider: "github",
        expectedDigest: detail.installedDigest,
        secret,
        requestId,
      });
      if (typeof saved.credentialRef !== "string" || !saved.credentialRef)
        throw new Error("凭据保存未返回受保护引用。");
      setCredentialRef(saved.credentialRef);
      setMessage("GitHub Connector 配置已保存，请明确连接该插件。");
      window.dispatchEvent(new Event("areal-plugins-changed"));
      await refresh();
    } catch (cause) {
      const error = failure(cause);
      if (error.submissionUnknown)
        setSubmission({
          mutation: "connectorConfigure",
          requestId: error.requestId ?? requestId,
        });
      setError(error);
    } finally {
      setCredentialBusy(false);
    }
  };
  const closeDetail = () => {
    detailGeneration.current++;
    setSelected(null);
    setDetail(null);
    setDetailError("");
  };
  const items = (catalog?.data ?? []).filter(
    (item) =>
      (view !== "installed" || item.installed) &&
      `${item.displayName} ${item.name} ${item.id} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  // A credential save restarts Core. Keep the selected form/receipt mounted while
  // disconnected; project changes still reset this owner through the parent's key.
  if (!connected && !catalog && !selected)
    return (
      <div className="resource-empty">
        <Package size={26} />
        <strong>连接项目后管理插件包</strong>
        <p>请先在侧栏选择项目并连接 Core。用户与项目插件由该 Core 统一管理。</p>
      </div>
    );
  return (
    <div className="resource-settings scoped-catalog">
      <div className="resource-catalog-bar">
        <SettingsSegmentedTabs
          ariaLabel="插件目录视图"
          items={[
            { label: "目录", value: "catalog" },
            { label: "已安装", value: "installed" },
          ]}
          value={view}
          onValueChange={setView}
        />
        <SettingsSearchInput
          aria-label="搜索插件包"
          placeholder="搜索插件包…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          clearLabel="清除插件搜索"
        />
        <Button
          variant="outline"
          disabled={!connected || busy || loading}
          onClick={() => void refresh()}
        >
          {loading ? "刷新中…" : "刷新目录"}
        </Button>
        <Button disabled={disabled} onClick={() => setAdding(true)}>
          添加来源
        </Button>
      </div>
      <p className="text-foreground-subtle text-ui-sm">
        先解析并核对来源，再安装不可变快照。安装不会启动服务器；连接 MCP
        和运行设置均需明确操作。
      </p>
      {supported === false && (
        <Feedback error="当前 Core 不支持插件目录。请升级到支持插件包的 Core 后重新连接项目。" />
      )}
      <Feedback error={failureText(error)} message={message} />
      <Feedback error={readError} />
      {!selected && !adding && recoveryButton}
      {!selected && setupThreadId && onOpenThread && (
        <Button onClick={() => onOpenThread(projectId, setupThreadId)}>
          打开设置对话
        </Button>
      )}
      {pending && (
        <Feedback error="项目有待核对的提交。请先恢复原提交结果，再管理插件。" />
      )}
      {!!catalog?.errors.length && (
        <div role="status">
          {catalog.errors.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </div>
      )}
      {!!catalog?.marketplaces.length && (
        <details>
          <summary>插件来源（{catalog.marketplaces.length}）</summary>
          <ul>
            {catalog.marketplaces.map((item) => (
              <li key={item.root}>
                <strong>{item.name}</strong>
                <p className="break-all text-foreground-subtle">{item.root}</p>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void mutate("marketplaceRemove", {
                      root: item.root,
                      expectedRevision: catalog.revision,
                    })
                  }
                >
                  移除来源
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void mutate("marketplaceUpdate", {
                expectedRevision: catalog.revision,
              })
            }
          >
            刷新 Git 来源快照
          </Button>
        </details>
      )}
      <div className="settings-resource-list">
        {items.map((item) => (
          <article className="skill-resource-row" key={item.id}>
            <button
              className="resource-card"
              disabled={busy}
              aria-label={`查看插件 ${item.id}`}
              onClick={() => setSelected(item.id)}
            >
              <Package size={20} />
              <span>
                <strong>{item.displayName || item.name}</strong>
                <small>{item.description || item.id}</small>
              </span>
            </button>
            <SettingsBadge>
              {item.installed ? (item.enabled ? "已启用" : "已停用") : "未安装"}
            </SettingsBadge>
            {!!item.diagnostics.length && (
              <SettingsBadge>能力受限</SettingsBadge>
            )}
          </article>
        ))}
      </div>
      {!loading && catalog && !items.length && (
        <div className="resource-empty">
          <Package size={26} />
          <strong>
            {query
              ? "没有匹配的插件"
              : view === "installed"
                ? "尚未安装插件"
                : "目录中没有插件"}
          </strong>
          <p>
            {view === "installed"
              ? "切换到目录，查看插件详情并选择安装范围。"
              : "添加包含 marketplace.json 的本地 marketplace 根目录。"}
          </p>
        </div>
      )}
      {adding && (
        <SettingsDialog
          title="添加插件来源"
          description="选择本地目录或 Git marketplace。读取来源不会安装插件或启动服务器。"
          busy={busy}
          onClose={() => setAdding(false)}
        >
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                addKind === "git" ? "marketplaceAddGit" : "marketplaceAdd",
                {
                  ...(addKind === "git"
                    ? {
                        url: root.trim(),
                        ...(gitRef.trim() ? { refName: gitRef.trim() } : {}),
                      }
                    : { root: root.trim() }),
                  expectedRevision: catalog?.revision,
                },
              );
            }}
          >
            <label>
              来源类型
              <select
                value={addKind}
                onChange={(event) => {
                  setAddKind(event.target.value);
                  setRoot("");
                }}
              >
                <option value="local">本地目录</option>
                <option value="git">Git 仓库</option>
              </select>
              {addKind === "git" ? "Git URL" : "Marketplace 根目录"}
              <Input
                autoFocus
                required
                value={root}
                disabled={busy}
                placeholder={
                  addKind === "git"
                    ? "https://github.com/owner/marketplace.git"
                    : "/path/to/marketplace"
                }
                onChange={(event) => setRoot(event.target.value)}
              />
            </label>
            {addKind === "git" && (
              <label>
                分支、标签或提交（可选）
                <Input
                  value={gitRef}
                  onChange={(event) => setGitRef(event.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            <Feedback error={failureText(error)} />
            {recoveryButton}
            <div className="settings-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={disabled || !root.trim()}>
                添加目录
              </Button>
            </div>
          </form>
        </SettingsDialog>
      )}
      {selected && (
        <SettingsDialog
          title={detail?.displayName || detail?.name || selected}
          description={detail?.description || "查看插件内容、来源与可用能力。"}
          busy={busy}
          onClose={closeDetail}
        >
          {detailLoading && <p role="status">正在读取插件详情…</p>}
          <Feedback
            error={detailError || failureText(error)}
            message={message}
          />
          {recoveryButton}
          {setupThreadId && onOpenThread && (
            <Button onClick={() => onOpenThread(projectId, setupThreadId)}>
              打开设置对话
            </Button>
          )}
          {detailError && (
            <Button variant="outline" onClick={() => void readDetail(selected)}>
              重试读取详情
            </Button>
          )}
          {detail && (
            <div className="settings-form">
              <dl>
                <dt>插件标识</dt>
                <dd className="break-all">{detail.id}</dd>
                <dt>目录可用版本</dt>
                <dd>{detail.version || "未声明"}</dd>
                <dt>已安装版本</dt>
                <dd>
                  {detail.installed
                    ? detail.installedVersion || "未声明"
                    : "未安装"}
                </dd>
                <dt>当前来源快照</dt>
                <dd className="break-all">{detail.source}</dd>
                <dt>目录包组件</dt>
                <dd>{detail.components.join("、") || "无"}</dd>
                <dt>有效状态</dt>
                <dd>
                  {detail.installed
                    ? detail.enabled
                      ? "已启用"
                      : "已停用"
                    : "未安装"}
                </dd>
              </dl>
              {detail.installed &&
                detail.installedDigest !== detail.sourceDigest && (
                  <Feedback message="目录包与已安装包的内容不同。当前运行和设置使用已安装的快照。" />
                )}
              {!!detail.diagnostics.length && (
                <section aria-label="目录包能力诊断">
                  <strong>目录包能力与限制</strong>
                  <ul>
                    {detail.diagnostics.map((text, index) => (
                      <li key={index}>{text}</li>
                    ))}
                  </ul>
                </section>
              )}
              {[
                ...(detail.installed
                  ? [{ label: "已安装 Skills", skills: detail.installedSkills }]
                  : []),
                { label: "目录包 Skills", skills: detail.skills },
              ].map(({ label, skills }) => (
                <section aria-label={label} key={label}>
                  <strong>
                    {label}（{skills.length}）
                  </strong>
                  <ul>
                    {skills.map((skill) => (
                      <li key={skill.id}>
                        <strong>{skill.name}</strong>
                        {skill.onboarding && " · 设置技能"}
                        {!skill.allowImplicitInvocation && " · 仅显式调用"}
                        <p>{skill.description}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <section aria-label="来源解析与预览">
                <h3>来源预览</h3>
                {detail.catalogSource !== undefined && (
                  <pre className="whitespace-pre-wrap break-all">
                    {JSON.stringify(detail.catalogSource, null, 2)}
                  </pre>
                )}
                <Button
                  variant="outline"
                  disabled={disabled || detailLoading}
                  onClick={() =>
                    void mutate("pluginResolve", {
                      id: detail.id,
                      expectedRevision: catalog?.revision,
                    })
                  }
                >
                  解析并预览来源
                </Button>
                {preview?.id === detail.id && (
                  <dl>
                    <dt>内容摘要</dt>
                    <dd className="break-all">{preview.sourceDigest}</dd>
                    <dt>固定提交</dt>
                    <dd>{preview.resolvedCommit ?? "本地内容快照"}</dd>
                    <dt>包版本</dt>
                    <dd>
                      {preview.packageVersion ?? preview.version ?? "未声明"}
                    </dd>
                    <dt>完整性</dt>
                    <dd className="break-all">
                      {preview.integrity ?? "Core 内容摘要"}
                    </dd>
                  </dl>
                )}
                {previewCurrent && (
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />
                    我已核对以上来源、版本和内容摘要
                  </label>
                )}
                {preview && !previewCurrent && (
                  <p role="status">目录已变化，请重新解析来源后安装。</p>
                )}
              </section>
              <ResourceScope
                value={scope}
                onChange={setScope}
                project={project}
                disabled={disabled}
              />
              <p className="text-foreground-subtle text-ui-sm">
                {scope === "user"
                  ? "保存到用户范围，供连接同一用户目录的项目使用。"
                  : "保存到当前项目范围。项目配置可覆盖用户配置；上方显示 Core 计算的有效状态。"}
              </p>
              {detail.installed ? (
                <>
                  <div className="settings-form-actions">
                    <Button
                      variant="outline"
                      disabled={disabled || detailLoading}
                      onClick={() =>
                        void mutate("pluginConfigure", {
                          id: detail.id,
                          scope,
                          enabled: true,
                          expectedRevision: catalog?.revision,
                        })
                      }
                    >
                      在{scope === "user" ? "用户" : "项目"}范围启用
                    </Button>
                    <Button
                      variant="outline"
                      disabled={disabled || detailLoading}
                      onClick={() =>
                        void mutate("pluginConfigure", {
                          id: detail.id,
                          scope,
                          enabled: false,
                          expectedRevision: catalog?.revision,
                        })
                      }
                    >
                      在{scope === "user" ? "用户" : "项目"}范围停用
                    </Button>
                  </div>
                  <Button
                    variant="outline"
                    disabled={disabled || detailLoading}
                    onClick={() =>
                      void mutate("pluginUninstall", {
                        id: detail.id,
                        expectedRevision: catalog?.revision,
                      })
                    }
                  >
                    卸载插件
                  </Button>
                </>
              ) : (
                <Button
                  disabled={
                    disabled || detailLoading || !previewCurrent || !reviewed
                  }
                  onClick={install}
                >
                  安装到{scope === "user" ? "用户" : "当前项目"}
                </Button>
              )}
              {detail.installed && (
                <section aria-label="插件连接与认证">
                  <h3>MCP 连接</h3>
                  <p className="break-all">
                    已安装摘要：{detail.installedDigest}
                  </p>
                  <Feedback error={connectionError} />
                  {connections.length ? (
                    connections.map((row, index) => (
                      <div key={String(row.id ?? row.serverId ?? index)}>
                        <strong>{row.id ?? row.serverId}</strong>
                        <span>
                          {" "}
                          · {String(row.state ?? row.status ?? "未连接")}
                        </span>
                        {row.message && <p>{String(row.message)}</p>}
                        {row.config?.authentication && <p>{row.authenticationTiming === "ON_INSTALL" ? "此插件要求安装后认证。完成认证后再连接服务。" : "首次需要受保护功能时，请先完成认证。"}</p>}
                        {row.config?.authentication && detail.installedDigest && <PluginAuthConfiguration key={`${detail.id}:${row.serverId}:${detail.installedDigest}`} pluginId={detail.id} server={row} digest={detail.installedDigest} disabled={disabled} command={api} onSaved={()=>{window.dispatchEvent(new Event("areal-plugins-changed"));void readDetail(detail.id);}} />}
                        {(row.authentication === "required" || row.authentication === "optional" ||
                          /auth|认证/i.test(
                            String(row.state ?? row.status),
                          )) && (
                          <div>
                            <Button
                              disabled={disabled}
                              onClick={() =>
                                void mutate("pluginAuth", {
                                  id: detail.id,
                                  server: row.id ?? row.serverId,
                                  authOperation: "start",
                                  expectedDigest: detail.installedDigest,
                                })
                              }
                            >
                              {row.config?.authenticationRequirements?.apiKey ? "启用认证" : "在浏览器中认证"}
                            </Button>
                            <Button
                              variant="outline"
                              disabled={disabled}
                              onClick={() =>
                                void mutate("pluginAuth", {
                                  id: detail.id,
                                  server: row.id ?? row.serverId,
                                  authOperation: "status",
                                  expectedDigest: detail.installedDigest,
                                })
                              }
                            >
                              核对认证状态
                            </Button>
                            <Button
                              variant="outline"
                              disabled={disabled}
                              onClick={() =>
                                void mutate("pluginAuth", {
                                  id: detail.id,
                                  server: row.id ?? row.serverId,
                                  authOperation: "cancel",
                                  expectedDigest: detail.installedDigest,
                                })
                              }
                            >
                              取消认证
                            </Button>
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <p>
                      没有已连接的插件服务器。连接失败、认证待完成和清理待完成会在此分别显示。
                    </p>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={connectionTrust}
                      onChange={(event) =>
                        setConnectionTrust(event.target.checked)
                      }
                    />
                    我信任此已安装快照并允许启动其 MCP 服务器
                  </label>
                  <div className="settings-form-actions">
                    <Button
                      disabled={
                        disabled ||
                        !detail.enabled ||
                        !detail.installedDigest ||
                        !connectionTrust
                      }
                      onClick={() =>
                        void mutate("pluginConnection", {
                          connect: true,
                          id: detail.id,
                          expectedDigest: detail.installedDigest,
                        })
                      }
                    >
                      信任并连接
                    </Button>
                    <Button
                      variant="outline"
                      disabled={disabled || !detail.installedDigest}
                      onClick={() =>
                        void mutate("pluginConnection", {
                          connect: false,
                          id: detail.id,
                          expectedDigest: detail.installedDigest,
                        })
                      }
                    >
                      断开连接
                    </Button>
                  </div>
                  {detail.installedDigest !== detail.sourceDigest && (
                    <Button
                      disabled={disabled || !previewCurrent || !reviewed}
                      onClick={install}
                    >
                      安装已核对的新快照
                    </Button>
                  )}
                  <details>
                    <summary>GitHub Connector 配置</summary>
                    <p>
                      保留插件声明的原始 Connector
                      ID。凭据保存在受保护的桌面凭据存储中。
                    </p>
                    <label>
                      原始 Connector ID
                      <Input
                        value={connectorId}
                        onChange={(event) => {
                          setConnectorId(event.target.value);
                          setCredentialRef("");
                        }}
                        disabled={busy || credentialBusy}
                      />
                    </label>
                    <label>
                      GitHub 访问令牌
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={connectorToken}
                        onChange={(event) =>
                          setConnectorToken(event.target.value)
                        }
                        disabled={busy || credentialBusy}
                      />
                    </label>
                    <Button
                      variant="outline"
                      disabled={
                        disabled ||
                        credentialBusy ||
                        !connectorId.trim() ||
                        !connectorToken
                      }
                      onClick={() => void saveConnectorCredential()}
                    >
                      安全保存并配置 GitHub
                    </Button>
                    {credentialRef && <p role="status">受保护凭据已配置</p>}
                  </details>
                </section>
              )}
              {detail.installed && detail.installedOnboardingSkill && (
                <section>
                  <strong>已安装设置技能</strong>
                  <p className="break-all">{detail.installedOnboardingSkill}</p>
                  <p>
                    点击后在普通对话中运行，由对话展示执行与审批。安装不会自动运行设置。
                  </p>
                  <Button
                    disabled={
                      disabled ||
                      detailLoading ||
                      !detail.installed ||
                      !detail.enabled
                    }
                    onClick={() =>
                      void mutate("pluginSetup", {
                        id: detail.id,
                        ...(thread?.id ? { threadId: thread.id } : {}),
                      })
                    }
                  >
                    运行设置
                  </Button>
                </section>
              )}
            </div>
          )}
        </SettingsDialog>
      )}
    </div>
  );
}
