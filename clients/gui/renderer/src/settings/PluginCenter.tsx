import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useGuardedNavigation } from "./UnsavedChanges.js";
import { PluginHookSettings } from "./PluginHookSettings.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Box, ChevronRight, MoreHorizontal, Package, Plug, Plus, RefreshCw, Store, Upload } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Switch } from "../components/ui/switch.js";
import { McpSettings } from "./ResourceSettings.js";
import { SettingsPluginIcon } from "./settingsNavIcons.js";
import { PluginSkillsPage, type CenterSkill, type ResourceDraftSeed } from "./PluginSkillsPage.js";
import "./PluginCenter.css";
import { PluginConnectionPanel } from "./PluginConnectionPanel.js";
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
export type PluginDetail = {
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
  catalogSource?: Data;
  interface?: Data;
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
  marketplaces: { name: string; root: string; sourceUrl?: string; resolvedCommit?: string }[];
  errors: string[];
};
type PluginMutation =
  | "pluginArchiveImport"
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
  | "connectorConfigure"
  | "pluginHooksConfigure";
type PluginSubmission = { mutation: PluginMutation; requestId: string; projectId: string };
type PluginOperation = PluginSubmission & { pluginId?: string };
type PluginActivity = PluginOperation & { kind: "submit" | "check" };
type PluginPreview = Pick<PluginDetail,
  "id" | "revision" | "source" | "sourceDigest" | "resolvedCommit" | "packageVersion" | "version" | "integrity">;
type PluginReceipt =
  | { confirmed: false; state: string }
  | {
      confirmed: true;
      accepted: boolean;
      result?: Partial<PluginDetail> & {
        thread?: { id: string };
        turn?: { id: string };
        requestId?: string;
      };
      error?: PluginFailure;
      warning?: string;
    };
const pluginMethods: Record<string, PluginMutation> = {
  "areal/plugin/importArchive": "pluginArchiveImport",
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
  "areal/plugin/hooks/configure": "pluginHooksConfigure",
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
  operation?: PluginOperation;
};
function isSourceOperation(operation: PluginOperation | null | undefined, projectId: string | undefined, pluginId: string | undefined) {
  return !!operation && !!projectId && !!pluginId && operation.mutation === "pluginResolve" && operation.projectId === projectId && operation.pluginId === pluginId;
}
function previewFromResult(result: Partial<PluginDetail> | undefined): PluginPreview | null {
  if (!result || typeof result.id !== "string" || !result.id.trim() ||
    typeof result.source !== "string" || !result.source.trim() ||
    typeof result.sourceDigest !== "string" || !result.sourceDigest.trim() ||
    typeof result.revision !== "number" || !Number.isSafeInteger(result.revision) || result.revision < 0) return null;
  return {
    id: result.id,
    revision: result.revision,
    source: result.source,
    sourceDigest: result.sourceDigest,
    resolvedCommit: typeof result.resolvedCommit === "string" ? result.resolvedCommit : undefined,
    packageVersion: typeof result.packageVersion === "string" ? result.packageVersion : undefined,
    version: typeof result.version === "string" ? result.version : null,
    integrity: typeof result.integrity === "string" ? result.integrity : undefined,
  };
}
function failure(cause: unknown): PluginFailure {
  if (cause instanceof Error) return cause;
  return { message: "插件操作失败，请刷新目录核对状态。" };
}
function failureText(error: PluginFailure | null) {
  if (!error) return "";
  return [
    error.submissionUnknown
      ? "提交结果待核对，不会自动重发。请核对原请求。"
      : "",
    error.message,
    error.code !== undefined ? `错误：${error.code}` : "",
    error.reason,
    error.requestId ? `请求：${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

type ListRoute = { kind: "market"; audience: "public" | "personal" } | { kind: "skills" } | { kind: "installed"; tab: "plugins" | "mcp" | "skills" | "markets" };
type CenterRoute = ListRoute | { kind: "plugin"; id: string; returnTo: ListRoute } | { kind: "skill"; skill: CenterSkill; returnTo: ListRoute };
export type PluginCenterProps = ScopedProps & {
  active: boolean;
  marketRequest: number;
  surface: "workspace" | "settings";
  projects: Data[];
  initialTab?: "plugins" | "mcp" | "skills" | "markets";
  onOpenThread?: (projectId: string, threadId: string) => void;
  apps?: (pluginId: string) => ReactNode;
  onSettings: () => void;
  onMarket: () => void;
  onChooseProject: () => void;
  onSelectProject: (id: string) => void;
  onStartDraft: (seed: ResourceDraftSeed) => Promise<void>;
};
const officialMarket = (url?: string) => !!url && /^https:\/\/github\.com\/openai\/plugins(?:\.git)?\/?$/i.test(url);
export function PluginCenter({ project: selectedProject, projects, thread, action, onOpenThread, apps,
  active: panelActive, surface, marketRequest, initialTab = "plugins", onSettings, onMarket, onChooseProject, onSelectProject, onStartDraft,
}: PluginCenterProps) {
  const navigate = useGuardedNavigation();
  const [ownerId, setOwnerId] = useState<string | undefined>(selectedProject?.id);
  const project = projects.find(item => item.id === ownerId);
  const projectId = project?.id;
  const connected = !!project?.state?.connected;
  const [route, setRoute] = useState<CenterRoute>({ kind: "market", audience: "public" });
  const navigateRoute = (next: CenterRoute) => navigate(() => { setMessage(""); setRoute(next); });
  const listRoute = route.kind === "plugin" || route.kind === "skill" ? route.returnTo : route;
  const [selected, updateSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const setSelected = (id: string | null) => {
    if (authPending && id !== selected) { setMessage("原认证配置提交仍待核对，请先完成核对。"); return; }
    navigate(() => {
      if (id) updateSelected(id);
      setRoute(id ? { kind: "plugin", id, returnTo: listRoute } : listRoute);
    });
  };
  const [catalog, setCatalog] = useState<PluginList | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState<PluginFailure | null>(null);
  const [message, setMessage] = useState("");
  const [setupThreadId, setSetupThreadId] = useState<string | null>(null);
  const [submission, setSubmission] = useState<PluginOperation | null>(null);
  const [activity, setActivity] = useState<PluginActivity | null>(null);
  const busy = activity !== null;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("user");
  const [adding, setAdding] = useState(false);
  const [root, setRoot] = useState("");
  const [addKind, setAddKind] = useState("local");
  const [gitRef, setGitRef] = useState("");
  const [sparsePaths, setSparsePaths] = useState("");
  const [archive, setArchive] = useState<{ selectionToken: string; fileName: string } | null>(null);
  const [allConnections, setAllConnections] = useState<Data[]>([]);
  const [mcpAddRequest, setMcpAddRequest] = useState(0);
  const [mcpScope, setMcpScope] = useState("user");
  useEffect(() => {
    if (route.kind !== "installed" || route.tab !== "mcp") setMcpAddRequest(0);
  }, [route]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [authRequests, setAuthRequests] = useState<Set<string>>(() => new Set());
  const authPending = authRequests.size > 0;
  const onAuthActivity = useCallback((id: string, pending: boolean) => setAuthRequests(previous => {
    if (previous.has(id) === pending) return previous;
    const next = new Set(previous);
    if (pending) next.add(id); else next.delete(id);
    return next;
  }), []);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [installReview, setInstallReview] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [submissionDetails, setSubmissionDetails] = useState(false);
  const [copiedDigest, setCopiedDigest] = useState(false);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionReadKey, setConnectionReadKey] = useState(0);
  const [connections, setConnections] = useState<Data[]>([]);
  const [connectionError, setConnectionError] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [connectorToken, setConnectorToken] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [hookSources,setHookSources]=useState<{id:string;digest:string;origin:string;enabled:boolean}[]>([]);
  const active = useRef(false);
  const mounted = useRef(true);
  const readGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const actionRef = useRef(action);
  actionRef.current = action;
  useEffect(() => {
    if (busy || credentialBusy || authPending || submission || error?.submissionUnknown || project?.pending?.length) return;
    if (selectedProject?.id !== ownerId) {
      setOwnerId(selectedProject?.id);
      setCatalog(null);
      setDetail(null);
      updateSelected(null);
      setPreview(null);
      setError(null);
      setSubmission(null);
      setRoute(current => current.kind === "plugin" || current.kind === "skill" ? current.returnTo : current);
    }
  }, [selectedProject?.id, ownerId, busy, credentialBusy, authPending, submission, error?.submissionUnknown, project?.pending?.length]);
  const savedRoutes = useRef<{ workspace: CenterRoute; settings: CenterRoute }>({ workspace: { kind: "market", audience: "public" }, settings: { kind: "installed", tab: initialTab } });
  const lastSurface = useRef(surface);
  useEffect(() => {
    if (surface !== lastSurface.current) {
      savedRoutes.current[lastSurface.current] = route;
      const restored = savedRoutes.current[surface];
      if (restored.kind === "plugin" && authPending && restored.id !== selected) {
        setRoute(route);
        setMessage("原认证配置提交仍待核对，请先完成核对。");
      } else {
        if (restored.kind === "plugin") updateSelected(restored.id);
        setRoute(restored);
      }
      lastSurface.current = surface;
    }
  }, [surface, initialTab]);
  useEffect(() => {
    if (marketRequest) setRoute({ kind: "market", audience: "public" });
  }, [marketRequest]);
  const previousTab = useRef(initialTab);
  useEffect(() => {
    if (surface === "settings" && initialTab !== previousTab.current) setRoute({ kind: "installed", tab: initialTab });
    previousTab.current = initialTab;
  }, [surface, initialTab]);
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
      const pluginConnections = await api("pluginMcp");
      if (mounted.current && generation === readGeneration.current)
        setAllConnections(Array.isArray(pluginConnections.data) ? pluginConnections.data : []);
      const hooks=await api("pluginHooks");
      if(mounted.current && generation===readGeneration.current){
        setHookSources(Array.isArray(hooks.data)?hooks.data.flatMap((row:Data)=>
          typeof row.sourceKind==='string' && typeof row.pluginId==='string' && typeof row.installedDigest==='string' && typeof row.origin==='string' && typeof row.enabled==='boolean'
          ?[{id:row.pluginId,digest:row.installedDigest,origin:row.origin,enabled:row.enabled}]:[]):[]);
      }
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
      if (selectedRef.current !== id) return;
      const generation = ++detailGeneration.current;
      setDetailLoading(true);
      setDetail(current => current?.id === id ? current : null);
      setDetailError("");
      try {
        const result: PluginDetail = await api("plugin", { id });
        if (mounted.current && generation === detailGeneration.current && selectedRef.current === id)
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
  }, [selected, readDetail, catalog?.revision]);
  useEffect(() => {
    setPreview(current => current?.id === selected ? current : null);
    setReviewed(false);
    setInstallReview(false);
    setDetailsOpen(false);
    setScopeOpen(false);
    setSubmissionDetails(false);
    setCopiedDigest(false);
    setConnections([]);
    setConnectorToken("");
    setCredentialRef("");
  }, [selected]);
  useEffect(() => {
    setInstallReview(false);
    setDetailsOpen(false);
    setScopeOpen(false);
    setSubmissionDetails(false);
    setCopiedDigest(false);
  }, [detail?.installedDigest]);
  useEffect(() => {
    if (!detail?.installed) {
      setConnections([]);
      return;
    }
    let current = true;
    setConnectionError("");
    setConnectionLoading(true);
    void api("pluginMcp")
      .then((result) => {
        if (current)
          setConnections(
            (Array.isArray(result.data) ? result.data : []).filter(
              (row: Data) => row.pluginId === detail.id && row.installedDigest === detail.installedDigest,
            )
          );
      })
      .catch((cause) => {
        if (current) setConnectionError(failure(cause).message);
      }).finally(() => { if (current) setConnectionLoading(false); });
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
    connectionReadKey,
  ]);
  const pendingEntries: Data[] = project?.pending ?? [];
  const pending = !!pendingEntries.length;
  const disabled =
    !connected ||
    busy ||
    loading ||
    !catalog ||
    !supported ||
    pending ||
    authPending ||
    !!error?.submissionUnknown;
  const acceptPreview = (result: Partial<PluginDetail> | undefined, operation: PluginOperation) => {
    const next = previewFromResult(result);
    setReviewed(false);
    if (!next || (operation.pluginId && next.id !== operation.pluginId)) {
      setPreview(null);
      setError({ message: "来源解析已完成，但返回的预览不完整。请刷新目录后重新解析来源。", operation });
      return false;
    }
    setPreview(next);
    return true;
  };
  const mutate = async (operation: PluginMutation, values: Data) => {
    if (active.current || disabled || !connected) return;
    active.current = true;
    const requestId = crypto.randomUUID();
    const original: PluginOperation = {
      mutation: operation, projectId: projectId!, requestId,
      ...(typeof values.id === "string" ? { pluginId: values.id } : {}),
    };
    setActivity({ ...original, kind: "submit" });
    setError(null);
    setMessage("");
    if (operation === "pluginResolve") {
      setPreview(null);
      setReviewed(false);
    }
    try {
      const result = await api(operation, { ...values, requestId });
      if (!mounted.current) return;
      if (operation === "pluginResolve" || operation === "pluginArchiveImport") {
        if (!acceptPreview(result, original)) {
          window.dispatchEvent(new Event("areal-plugins-changed"));
          return;
        }
        if (operation === "pluginArchiveImport") {
          setArchive(null);
          setInstallReview(true);
          updateSelected(result.id);
          setRoute({ kind: "plugin", id: result.id, returnTo: listRoute });
        }
      }
      window.dispatchEvent(new Event("areal-plugins-changed"));
      if (operation === "pluginSetup" && result.thread?.id)
        setSetupThreadId(result.thread.id);
      if (operation === "marketplaceAdd" || operation === "marketplaceAddGit") {
        setAdding(false);
        setRoot("");
      }
      if (operation === "pluginInstall") setInstallReview(false);
      setMessage(
        operation === "pluginAuth" ? "" : operation === "pluginSetup"
          ? "设置技能已提交，请回到对话查看执行与审批。"
          : operation === "pluginResolve" || operation === "pluginConnection" || operation === "pluginInstall" ? "" : "操作已完成。",
      );
      return result;
    } catch (cause) {
      if (mounted.current) {
        const error = failure(cause);
        const failedOperation = { ...original, requestId: error.requestId ?? requestId };
        if (error.submissionUnknown && operation !== "pluginAuth")
          setSubmission(failedOperation);
        setError(
          error.submissionUnknown && operation !== "pluginAuth"
            ? {
                ...error,
                message: error.message,
                requestId: error.requestId ?? requestId,
                operation: failedOperation,
              }
            : { ...error, message: error.message, ...(operation === "pluginAuth" ? { submissionUnknown: false } : {}), operation: failedOperation },
        );
      }
    } finally {
      // 只重读权威状态；冲突或 UNKNOWN 不会触发任何写入重试。
      if (mounted.current) {
        await refresh();
        if (selectedRef.current) await readDetail(selectedRef.current);
        if (mounted.current) setActivity(null);
      }
      active.current = false;
    }
  };
  const submissionAwaiting = !!submission && submission.projectId === projectId && pendingEntries.some(
    entry => entry.awaitingResponse === true && entry.params?.requestId === submission.requestId && pluginMethods[entry.method] === submission.mutation,
  );
  const pendingPlugin = pendingEntries.find(
    (entry: Data) =>
      !entry.awaitingResponse &&
      pluginMethods[entry.method] &&
      typeof entry.params?.requestId === "string",
  );
  const recoverable: PluginOperation | null =
    (submissionAwaiting ? null : submission) ??
    (pendingPlugin
      ? {
          mutation: pluginMethods[pendingPlugin.method],
          projectId: projectId!,
          requestId: pendingPlugin.params.requestId,
          ...(typeof pendingPlugin.params.id === "string" ? { pluginId: pendingPlugin.params.id } : {}),
        }
      : null);
  const recoverSubmission = async () => {
    if (!recoverable || active.current || !connected) return;
    active.current = true;
    setActivity({ ...recoverable, kind: "check" });
    setMessage("");
    try {
      const receipt: PluginReceipt = await actionRef.current("manage", {
        operation: "pluginSubmission", mutation: recoverable.mutation,
        projectId: recoverable.projectId, requestId: recoverable.requestId,
      });
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
          operation: recoverable,
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
          operation: recoverable,
        });
        return;
      }
      setError(null);
      if (recoverable.mutation === "pluginResolve" && !acceptPreview(receipt.result, recoverable)) return;
      if (recoverable.mutation === "pluginArchiveImport" && receipt.result?.id) {
        updateSelected(receipt.result.id);
        setRoute({ kind: "plugin", id: receipt.result.id, returnTo: listRoute });
        setArchive(null);
        setPreview(null);
        setReviewed(false);
        await readDetail(receipt.result.id);
      }
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
          operation: recoverable,
        });
      }
    } finally {
      if (mounted.current) {
        await refresh();
        if (selectedRef.current) await readDetail(selectedRef.current);
        if (mounted.current) setActivity(null);
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
      {recoverable?.mutation === "pluginConnection" ? "核对连接结果" : "核对插件提交"}
    </Button>
  );
  const previewCurrent =
    !!detail &&
    !!preview &&
    preview.id === detail.id &&
    preview.source === detail.source &&
    preview.sourceDigest === detail.sourceDigest &&
    preview.revision === catalog?.revision;
  const pendingKind = pendingEntries.some(entry => entry.awaitingResponse !== true) ||
    (submission && !submissionAwaiting) || (error?.submissionUnknown && !submissionAwaiting)
    ? "unknown" : pending || busy || submissionAwaiting ? "active" : "none";
  const pendingMessage = pendingKind === "unknown"
    ? pendingEntries.some(entry => entry.awaitingResponse !== true && (!pluginMethods[entry.method] || typeof entry.params?.requestId !== "string")) || !recoverable
      ? "项目中有结果待核对的操作，请回到原操作入口核对后再管理插件。"
      : "原插件提交结果待核对，不会自动重发。"
    : pendingKind === "active"
      ? activity?.kind === "submit" && activity.mutation === "marketplaceAddGit" || pendingEntries.some(entry => entry.awaitingResponse === true && entry.method === "areal/marketplace/addGit")
        ? "正在添加插件市场…"
        : "项目操作正在处理中，请稍候。"
      : "";
  const displayedError = error?.submissionUnknown && submissionAwaiting && error.requestId === submission?.requestId ? null : error;
  const operationError = displayedError?.submissionUnknown ? "" : failureText(displayedError);
  const operationMessage = displayedError?.submissionUnknown ? failureText(displayedError) : message;
  const sourceRecovery = isSourceOperation(recoverable, projectId, detail?.id);
  const checkingSource = activity?.kind === "check" && isSourceOperation(activity, projectId, detail?.id);
  const resolvingSource = activity?.kind === "submit" && isSourceOperation(activity, projectId, detail?.id) ||
    submissionAwaiting && isSourceOperation(submission, projectId, detail?.id) || pendingEntries.some(
    entry => entry.awaitingResponse === true && entry.method === "areal/plugin/resolve" && entry.params?.id === detail?.id,
  );
  const sourceFailure = isSourceOperation(displayedError?.operation, projectId, detail?.id) ? displayedError : null;
  const sourceError = !checkingSource && !resolvingSource && !sourceRecovery && !sourceFailure?.submissionUnknown ? failureText(sourceFailure) : "";
  const sourceMessage = checkingSource ? "正在核对原来源解析…"
    : resolvingSource ? "正在解析来源…"
    : sourceRecovery ? "来源解析结果待核对，不会自动重发。"
    : sourceFailure?.submissionUnknown ? failureText(sourceFailure)
    : sourceError ? ""
    : pendingMessage || (previewCurrent ? "来源已解析，请核对摘要后安装。" : "");
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
          projectId: projectId!,
          requestId: error.requestId ?? requestId,
        });
      setError(error);
    } finally {
      setCredentialBusy(false);
    }
  };
  const closeDetail = () => navigateRoute(listRoute);
  const installed = (catalog?.data ?? []).filter(item => item.installed);
  const packageSkills: CenterSkill[] = installed.flatMap(item => item.installedSkills.map(skill => ({
    ...skill, key: `${item.id}:${item.installedDigest}:${skill.id}`, enabled: item.enabled,
    sourceLabel: `插件 · ${item.displayName || item.name}`, pluginId: item.id, projectId, scope: "plugin",
  })));
  const pluginServers = allConnections.flatMap(row => {
    const owner = installed.find(item => item.id === row.pluginId && item.installedDigest === row.installedDigest);
    return owner ? (row.servers ?? []).map((server: Data) => ({ key: `${row.pluginId}:${row.installedDigest}:${server.serverId}`, serverId: server.serverId,
      state: server.state ?? row.state, owner: { pluginId: owner.id, pluginName: owner.displayName || owner.name, installedDigest: owner.installedDigest!, enabled: owner.enabled } })) : [];
  });
  const audience = listRoute.kind === "market" ? listRoute.audience : "personal";
  const markets = catalog?.marketplaces ?? [];
  const marketFor = (item: PluginDetail) => markets.find(market => item.id.endsWith(`@${market.name}`));
  const items = (catalog?.data ?? []).filter(item =>
    (listRoute.kind !== "installed" || item.installed) &&
    (listRoute.kind !== "market" || (audience === "public" ? officialMarket(marketFor(item)?.sourceUrl) : !officialMarket(marketFor(item)?.sourceUrl))) &&
    `${item.displayName} ${item.name} ${item.id} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const openSkill = (skill: CenterSkill) => navigateRoute({ kind: "skill", skill, returnTo: listRoute });
  const createSkill = async () => {
    if (draftBusy) return;
    setDraftBusy(true); setError(null);
    try {
      if (!project || project.projectless) throw new Error("请先选择要创建 Skill 的项目。");
      await onStartDraft({ kind: "creator", projectId: project.id });
    } catch (cause) { setError(failure(cause)); }
    finally { setDraftBusy(false); }
  };
  const startPluginDraft = async (plugin: PluginDetail, text: string) => {
    setDraftBusy(true); setError(null);
    const skill = plugin.installedSkills.find(item => !item.onboarding) || plugin.installedSkills[0];
    try {
      await onStartDraft({ text, ...(skill ? { skill: { ...skill, source: `插件 · ${plugin.displayName || plugin.name}` } } : {}) });
    } catch (cause) { setError(failure(cause)); }
    finally { setDraftBusy(false); }
  };
  const pickArchive = async () => {
    setError(null);
    try {
      const selection = await api("pluginArchivePick");
      if (!selection.canceled) setArchive(selection);
    } catch (cause) { setError(failure(cause)); }
  };
  const addMenu = <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="outline" disabled={disabled} aria-label="添加资源">添加</Button>} />
    <DropdownMenuContent align="end">
      <DropdownMenuItem onClick={() => setAdding(true)}><Store size={16} />添加市场</DropdownMenuItem>
      <DropdownMenuItem onClick={() => navigate(() => { setRoute({ kind: "installed", tab: "mcp" }); setMcpAddRequest(value => value + 1); })}><Plug size={16} />添加 MCP</DropdownMenuItem>
      <DropdownMenuItem onClick={() => void pickArchive()}><Upload size={16} />上传插件包</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
  const showPlugins = listRoute.kind === "market" || listRoute.kind === "installed" && listRoute.tab === "plugins";
  const isDetail = route.kind === "plugin" || route.kind === "skill";
  const title = route.kind === "plugin" ? detail?.displayName || detail?.name || selected : route.kind === "skill" ? route.skill.name : listRoute.kind === "market" ? "插件市场" : listRoute.kind === "skills" ? "Skills" : "插件";
  return (
    <div className={`plugin-center ${surface === "settings" ? "plugin-center-settings" : "plugin-center-workspace"}`} hidden={!panelActive}>
      {surface === "workspace" && <aside className="plugin-center-sidebar" aria-label="插件导航">
        <div className="plugin-center-sidebar-title">AReaL Harness</div>
        <small className="plugin-nav-label">扩展</small>
        <button aria-current={listRoute.kind === "market" && !isDetail ? "page" : undefined} onClick={() => navigateRoute({ kind: "market", audience: "public" })}><SettingsPluginIcon width={15} height={15} />插件市场</button>
        <button aria-current={listRoute.kind === "skills" && !isDetail ? "page" : undefined} onClick={() => navigateRoute({ kind: "skills" })}><Box size={15} strokeWidth={1.5} />Skills</button>
        <small className="plugin-nav-label plugin-installed-label">已安装</small>
        <div className="plugin-installed-shortcuts">{installed.map(item => <button key={item.id} aria-current={route.kind === "plugin" && selected === item.id ? "page" : undefined} onClick={() => setSelected(item.id)}><Package size={16} /><span>{item.displayName || item.name}</span></button>)}</div>
        <button className="plugin-center-manage" onClick={() => navigate(onSettings)}>管理已安装</button>
      </aside>}
      <div className="plugin-center-scroll"><div className={`plugin-center-content ${isDetail ? "plugin-center-detail" : ""}`}>
        {isDetail ? <nav className="plugin-breadcrumb" aria-label="面包屑"><button aria-label="返回插件列表" onClick={closeDetail}><ArrowLeft size={15} />{listRoute.kind === "installed" ? "插件设置" : listRoute.kind === "skills" ? "Skills" : "插件市场"}</button><ChevronRight size={13} /><span>{title}</span></nav> : <>
          {!(surface === "workspace" && listRoute.kind === "skills") && <header className="plugin-center-header"><div>{project && <p className="plugin-management-context" title={project.root}>管理项目 · {project.name || project.root?.split(/[\\/]/).pop()}</p>}<h1>{title}</h1><p>{listRoute.kind === "market" ? "发现并安装插件，扩展 AReaL Harness 的能力。" : listRoute.kind === "skills" ? "为不同任务添加可复用的专业能力。" : "管理已安装的插件、MCP 和 Skills。"}</p></div>
            <div className="plugin-center-toolbar">
              {(showPlugins || listRoute.kind === "installed" && listRoute.tab === "markets") && <SettingsSearchInput containerClassName="plugin-center-search" aria-label="搜索插件包" placeholder="搜索插件…" value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery("")} clearLabel="清除插件搜索" />}
              {listRoute.kind === "skills" ? <Button disabled={draftBusy} onClick={() => void createSkill()}>创建 Skill</Button> : <>
                {surface === "settings" && <Button variant="outline" onClick={() => navigate(onMarket)}>浏览市场</Button>}
                <Button variant="ghost" size="icon" aria-label="刷新市场" disabled={!connected || busy || loading} onClick={() => void refresh()}><RefreshCw size={16} /></Button>{addMenu}
              </>}
            </div>
          </header>}
          {listRoute.kind === "market" && <SettingsSegmentedTabs ariaLabel="市场范围" items={[{ label: "公共", value: "public" }, { label: "个人", value: "personal" }]} value={audience} onValueChange={value => { setQuery(""); navigateRoute({ kind: "market", audience: value as "public" | "personal" }); }} />}
          {listRoute.kind === "installed" && <SettingsSegmentedTabs ariaLabel="已安装资源类型" activateOnFocus={false} items={[{ label: "插件", value: "plugins" }, { label: "MCP", value: "mcp" }, { label: "Skills", value: "skills" }, { label: "市场", value: "markets" }]} value={listRoute.tab} onValueChange={value => { setQuery(""); navigateRoute({ kind: "installed", tab: value as "plugins" | "mcp" | "skills" | "markets" }); }} />}
        </>}
        {projectId !== selectedProject?.id && <Feedback message={`正在保留项目 ${project?.name || project?.root || ownerId} 的原提交。核对完成后再切换管理上下文。`} />}
        {!project && <div className="resource-empty"><Package size={28} /><strong>选择项目后浏览插件</strong><p>插件目录由已打开项目的 Core 管理。</p><div className="plugin-context-actions">{projects.filter(item => !item.projectless).map(item => <Button key={item.id} variant="outline" onClick={() => onSelectProject(item.id)}>{item.name || item.root.split(/[\\/]/).pop()}</Button>)}<Button onClick={onChooseProject}>打开项目</Button></div></div>}
        {project && !connected && <Feedback message="项目 Core 尚未连接。当前内容和原提交已保留。" />}
      {supported === false && (
        <Feedback error="当前 Core 不支持插件目录。请升级到支持插件包的 Core 后重新连接项目。" />
      )}
      {!isDetail && <Feedback error={operationError} message={operationMessage} />}
      <Feedback error={readError} />
      {surface === "settings" && !isDetail && listRoute.kind === "installed" && listRoute.tab === "plugins" && hookSources.length > 0 && <SettingsDisclosure title={<> 高级 · 独立钩子 </>}>
        {hookSources.map(source=><SettingsDisclosure key={source.id} className="settings-section" title={<> {source.id==='__hooks_user__'?'用户钩子':'项目钩子'} · {source.enabled?'全局开关已启用':'全局开关已停用'} </>}>
        <p className="text-ui-sm break-all">{source.origin}</p>
        <PluginHookSettings id={source.id} installedDigest={source.digest} disabled={disabled}
          api={api} refreshKey={catalog?.revision}
          onConfigure={async params=>{await mutate("pluginHooksConfigure",params);}} />
      </SettingsDisclosure>)}
      </SettingsDisclosure>}
      {!isDetail && !adding && recoveryButton}
      {!isDetail && setupThreadId && onOpenThread && (
        <Button onClick={() => onOpenThread(projectId, setupThreadId)}>
          打开设置对话
        </Button>
      )}
      {!isDetail && <Feedback message={pendingMessage} />}
      {!!catalog?.errors.length && (
        <div role="status">
          {catalog.errors.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </div>
      )}
      {!isDetail && showPlugins && project && <div className={listRoute.kind === "installed" ? "plugin-compact-list" : "plugin-market-groups"}>
        {(listRoute.kind === "installed" ? ["已安装"] : [...new Set(items.map(item => audience === "personal" ? marketFor(item)?.name || "导入的插件包" : item.interface?.category || "插件"))]).map(group => {
          const rows = listRoute.kind === "installed" ? items : items.filter(item => (audience === "personal" ? marketFor(item)?.name || "导入的插件包" : item.interface?.category || "插件") === group);
          return <section className="plugin-market-group" key={group}><h2>{group}</h2><div className={listRoute.kind === "installed" || audience === "personal" ? "plugin-row-list" : "plugin-catalog-grid"}>{rows.map(item => <article className="plugin-catalog-row" key={item.id} aria-label={`${item.displayName || item.name} · 插件 ${item.id}`}>
            <button className="plugin-row-info" disabled={busy} aria-label={`查看插件 ${item.id}`} onClick={() => setSelected(item.id)}><span className="plugin-resource-icon"><Package size={20} /></span><span><strong>{item.displayName || item.name}</strong><small>{item.description || item.id}</small></span></button>
            {listRoute.kind === "installed" ? <Switch aria-label={`在当前项目${item.enabled ? "停用" : "启用"}插件 ${item.id}`} checked={item.enabled} disabled={disabled} onCheckedChange={enabled => void mutate("pluginConfigure", { id: item.id, scope: "project", enabled, expectedRevision: catalog?.revision })} /> : <button className="plugin-row-action" aria-label={`${item.installed ? "管理" : "添加"}插件 ${item.id}`} disabled={busy} onClick={() => setSelected(item.id)}>{item.installed ? "已添加" : <Plus size={18} />}</button>}
          </article>)}</div></section>;
        })}
        {!loading && catalog && !items.length && <div className="resource-empty"><Package size={28} /><strong>{query ? "没有匹配的插件" : listRoute.kind === "installed" ? "尚未安装插件" : audience === "public" ? "尚未添加官方插件市场" : "尚未添加个人插件市场"}</strong><p>{query ? "试试其他名称或关键词。" : "添加市场后，查看真实插件内容并审核安装。"}</p>{!query && listRoute.kind === "market" && <Button variant="outline" disabled={disabled} onClick={() => { setAddKind(audience === "public" ? "git" : "local"); setRoot(audience === "public" ? "https://github.com/openai/plugins.git" : ""); setAdding(true); }}>添加插件市场</Button>}</div>}
      </div>}
      {(route.kind === "skills" || route.kind === "installed" && route.tab === "skills" || route.kind === "skill") && <PluginSkillsPage action={action} projects={projects} project={project} packageSkills={packageSkills} selected={route.kind === "skill" ? route.skill : null} onOpen={openSkill} onManagePlugin={setSelected} onStartDraft={onStartDraft} compact={listRoute.kind === "installed"} onCreate={() => void createSkill()} createBusy={draftBusy} />}
      {!isDetail && listRoute.kind === "installed" && listRoute.tab === "mcp" && <McpSettings project={project} thread={thread} action={action} scope={mcpScope} onScopeChange={setMcpScope} pluginServers={pluginServers} onManagePlugin={setSelected} onRefreshPlugins={refresh} addRequest={mcpAddRequest} />}
      {!isDetail && listRoute.kind === "installed" && listRoute.tab === "markets" && <div className="plugin-compact-list">{markets.filter(item => `${item.name} ${item.sourceUrl || item.root}`.toLowerCase().includes(query.toLowerCase())).map(item => <article className="plugin-catalog-row" key={item.root}><span className="plugin-resource-icon"><Store size={19} /></span><div className="plugin-market-info"><strong>{item.name}</strong><small>{item.sourceUrl || item.root}</small>{item.resolvedCommit && <small>{item.resolvedCommit}</small>}</div><Button variant="ghost" disabled={disabled} onClick={() => void mutate("marketplaceRemove", { root: item.root, expectedRevision: catalog?.revision })}>移除来源</Button></article>)}<Button variant="outline" disabled={disabled} onClick={() => void mutate("marketplaceUpdate", { expectedRevision: catalog?.revision })}>刷新 Git 来源快照</Button></div>}
      {panelActive && archive && <SettingsDialog title="上传插件包" description="先导入并检查 ZIP 插件包，再审核内容摘要与安装范围。" busy={busy} onClose={() => setArchive(null)}><p>{archive.fileName}</p><Feedback error={operationError} message={operationMessage || pendingMessage} />{recoveryButton}<div className="settings-form-actions"><Button variant="outline" disabled={busy} onClick={() => setArchive(null)}>取消</Button><Button disabled={disabled} onClick={() => void mutate("pluginArchiveImport", { selectionToken: archive.selectionToken, expectedRevision: catalog?.revision })}>导入并预览</Button></div></SettingsDialog>}
      {panelActive && adding && (
        <SettingsDialog
          title="添加插件市场"
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
                        ...(sparsePaths.trim() ? { sparsePaths: sparsePaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean) } : {}),
                      }
                    : { root: root.trim() }),
                  expectedRevision: catalog?.revision,
                },
              );
            }}
          >
            <div className="settings-choice-field">
              来源类型
              <SettingsSelect value={addKind} onValueChange={selectedValue => {
                  setAddKind(selectedValue);
                  setRoot("");
                }} aria-label="来源类型">
                <option value="local">本地目录</option>
                <option value="git">Git 仓库</option>
              </SettingsSelect>
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
            </div>
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
            {addKind === "git" && <label>稀疏检出路径（可选）<textarea rows={3} value={sparsePaths} onChange={event => setSparsePaths(event.target.value)} placeholder="每行一个相对于仓库根目录的路径" /></label>}
            <Feedback error={operationError} message={operationMessage || pendingMessage} />
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
        <article data-testid="plugin-detail-page" className="plugin-detail-page" hidden={route.kind !== "plugin" || !panelActive}>
          <header className="plugin-detail-header">
            <span className="plugin-resource-icon"><Package size={30} /></span>
            <div><h1>{detail?.displayName || detail?.name || selected}</h1><p>{detail?.description}</p>
              {detail && marketFor(detail) && <p className="plugin-source-label">来源：{officialMarket(marketFor(detail)?.sourceUrl) ? "OpenAI 插件市场" : marketFor(detail)?.name}</p>}
            </div>
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多插件操作"><MoreHorizontal size={18} /></Button>} />
              <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void navigator.clipboard.writeText(detail?.id || selected)}>复制插件标识</DropdownMenuItem>
                {detail?.installed && <DropdownMenuItem disabled={disabled} onClick={() => void mutate("pluginUninstall", { id: detail.id, expectedRevision: catalog?.revision })}>卸载插件</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          {detailLoading && !detail && <p role="status">正在读取插件详情…</p>}
          <Feedback error={detailError || (pendingKind !== "unknown" ? displayedError?.message : "")} />
          {detailError && <Button variant="outline" onClick={() => void readDetail(selected)}>重试读取详情</Button>}
          {detail && <div className="plugin-detail-body">
            {pendingKind === "unknown" ? <section className="plugin-status-panel" aria-label="插件提交状态">
              <h2>{recoverable?.mutation === "pluginConnection" ? "连接结果待核对" : "操作结果待核对"}</h2>
              <p className="plugin-status-description">尚未确认上次操作是否完成，请先核对原请求。</p>
              <div className="plugin-service-row"><div><strong>{detail.displayName || detail.name}</strong><p>结果待核对</p></div>
                <div className="plugin-service-actions">{recoveryButton}<Button variant="outline" aria-expanded={submissionDetails} aria-controls="plugin-submission-details" onClick={() => setSubmissionDetails(value => !value)}>{submissionDetails ? "收起本次提交" : "查看本次提交"}</Button></div>
              </div>
              <p className="plugin-status-note">核对前暂不可重复提交或修改配置。</p>
              {submissionDetails && <div id="plugin-submission-details"><p>{pendingMessage}</p><pre>{failureText(displayedError) || recoverable?.requestId}</pre></div>}
            </section> : busy && activity?.mutation !== "pluginAuth" ? <section className="plugin-status-panel" aria-label="插件操作进度" aria-busy="true">
              <h2>{checkingSource ? "正在核对原来源解析…" : resolvingSource ? "正在解析来源…" : activity?.kind === "check" ? "正在核对原提交…" : activity?.mutation === "pluginConnection" ? "正在更新连接…" : "正在处理…"}</h2>
              <p className="plugin-status-description">请稍候，不会重复提交。</p>
            </section> : !detail.installed || installReview ? <section className="plugin-status-panel" aria-label="来源解析与预览">
              <h2>{detail.installed ? "核对新安装快照" : "尚未安装"}</h2>
              <p className="plugin-status-description">核对来源后，选择安装范围。</p>
              {!installReview && preview?.id !== detail.id ? <div className="plugin-service-row"><div><strong>{detail.displayName || detail.name} 插件包</strong><p>安装前需要核对来源。</p></div>
                <Button disabled={disabled || detailLoading} onClick={() => { setInstallReview(true); void mutate("pluginResolve", { id: detail.id, expectedRevision: catalog?.revision }); }}>核对来源并安装</Button>
              </div> : <div className="plugin-install-review">
                <Feedback error={sourceError} message={sourceMessage} />
                {preview?.id === detail.id && <dl className="plugin-metadata">
                  <dt>来源</dt><dd>{marketFor(detail)?.sourceUrl || detail.catalogSource?.url || detail.source}</dd>
                  {(preview.packageVersion || preview.version) && <><dt>包版本</dt><dd>{preview.packageVersion || preview.version}</dd></>}
                  <dt>内容摘要</dt><dd><code>{preview.sourceDigest}</code></dd>
                  {preview.resolvedCommit && <><dt>固定提交</dt><dd><code>{preview.resolvedCommit}</code></dd></>}
                  {preview.integrity && <><dt>完整性</dt><dd><code>{preview.integrity}</code></dd></>}
                </dl>}
                {previewCurrent && <>
                  <div className="plugin-scope-field"><span>安装范围</span><ResourceScope value={scope} onChange={setScope} project={project} disabled={disabled} /></div>
                  <p className="plugin-status-note">{scope === "user" ? "同一用户目录下的项目可用。" : "保存到当前项目范围。"}</p>
                  <label className="plugin-consent"><input type="checkbox" checked={reviewed} disabled={disabled} onChange={event => setReviewed(event.target.checked)} /><span>我已核对以上来源、版本和内容摘要</span></label>
                </>}
                {preview && !previewCurrent && <p role="status">目录已变化，请重新解析来源后安装。</p>}
                <div className="plugin-service-actions">
                  {previewCurrent ? <Button disabled={disabled || !reviewed} onClick={install}>{detail.installed ? "安装已核对的新快照" : `安装到${scope === "user" ? "用户" : "当前项目"}`}</Button> :
                    <Button disabled={disabled} onClick={() => void mutate("pluginResolve", { id: detail.id, expectedRevision: catalog?.revision })}>重新解析来源</Button>}
                  <Button variant="outline" disabled={busy} onClick={() => { setInstallReview(false); setPreview(null); setReviewed(false); }}>取消安装</Button>
                </div>
              </div>}
            </section> : !detail.enabled ? <section className="plugin-status-panel"><h2>当前项目已停用</h2><p className="plugin-status-description">管理启用范围后，再使用此插件。</p><Button disabled={disabled} onClick={() => setScopeOpen(true)}>管理启用范围</Button></section> :
              <PluginConnectionPanel key={`${projectId}:${detail.id}:${detail.installedDigest}`} detail={detail}
                snapshot={connections.find(row => row.pluginId === detail.id && row.installedDigest === detail.installedDigest)}
                loading={connectionLoading} error={connectionError} disabled={disabled || authPending} command={api}
                mutate={mutate} onRefresh={() => { setConnectionReadKey(value => value + 1); void refresh(); void readDetail(detail.id); }} onAuthActivity={onAuthActivity}
                onStart={() => void startPluginDraft(detail, `请使用 ${detail.displayName || detail.name} 帮助我完成任务。`)} draftBusy={draftBusy}
                connectorConfiguration={<SettingsDisclosure title="GitHub Connector 配置">
                  <p>凭据保存在受保护的桌面凭据存储中。修改前请先断开连接。</p>
                  <label>原始 Connector ID<SettingsSelect value={connectorId} onValueChange={value => { setConnectorId(value); setCredentialRef(""); }} disabled={disabled || credentialBusy} aria-label="原始 Connector ID"><option value="">选择声明的 Connector</option>{connections.flatMap(row => (row.connectors ?? []).map((item: Data) => <option key={item.id} value={item.id}>{item.id}</option>))}</SettingsSelect></label>
                  <label>GitHub 访问令牌<Input type="password" autoComplete="new-password" value={connectorToken} onChange={event => setConnectorToken(event.target.value)} disabled={disabled || credentialBusy} /></label>
                  <Button variant="outline" disabled={disabled || credentialBusy || !connectorId || !connectorToken || connections.some(row => row.state === "connected" || row.state === "partial")} onClick={() => void saveConnectorCredential()}>安全保存并配置 GitHub</Button>
                  {credentialRef && <p role="status">受保护凭据已配置</p>}
                </SettingsDisclosure>} />}
            {operationMessage && pendingKind !== "unknown" && !busy && <Feedback message={operationMessage} />}
            {setupThreadId && onOpenThread && <Button onClick={() => onOpenThread(projectId, setupThreadId)}>打开设置对话</Button>}
            {detail.installed && <div className="plugin-detail-setting-row" id="plugin-management">
              <div><h3>启用状态</h3><p>当前项目{detail.enabled ? "已启用" : "已停用"}</p>{detail.installedVersion && <p>已安装版本 {detail.installedVersion}</p>}</div>
              <Button variant="outline" disabled={disabled || authPending} aria-expanded={scopeOpen} aria-controls="plugin-scope-settings" onClick={() => setScopeOpen(value => !value)}>{scopeOpen ? "收起启用范围" : "管理启用范围"}</Button>
            </div>}
            {detail.installed && scopeOpen && <div id="plugin-scope-settings" className="plugin-scope-settings">
              <div className="plugin-scope-field"><span>修改范围</span><ResourceScope value={scope} onChange={setScope} project={project} disabled={disabled} /></div>
              <p>项目配置可覆盖用户配置；上方显示当前项目的有效状态。</p>
              <div className="plugin-service-actions"><Button variant="outline" disabled={disabled} onClick={() => void mutate("pluginConfigure", { id: detail.id, scope, enabled: true, expectedRevision: catalog?.revision })}>在{scope === "user" ? "用户" : "项目"}范围启用</Button>
                <Button variant="outline" disabled={disabled} onClick={() => void mutate("pluginConfigure", { id: detail.id, scope, enabled: false, expectedRevision: catalog?.revision })}>在{scope === "user" ? "用户" : "项目"}范围停用</Button></div>
            </div>}
            {detail.installed && detail.installedDigest !== detail.sourceDigest && <div className="plugin-detail-setting-row"><div><h3>目录内容已变化</h3><p>当前运行和设置仍使用已安装快照。</p></div><Button variant="outline" disabled={disabled} onClick={() => { setInstallReview(true); setReviewed(false); void mutate("pluginResolve", { id: detail.id, expectedRevision: catalog?.revision }); }}>核对新快照</Button></div>}
            <div className="plugin-detail-setting-row"><div><h3>来源与安装详情</h3><p>查看插件的来源、安装信息和技术详情。</p></div>
              <Button variant="outline" aria-expanded={detailsOpen} aria-controls="plugin-source-details" onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? "收起详情" : "查看详情"}</Button>
            </div>
            {detailsOpen && <div id="plugin-source-details" className="plugin-source-details">
              <dl className="plugin-metadata">
                <dt>来源</dt><dd>{officialMarket(marketFor(detail)?.sourceUrl) ? "OpenAI 插件市场" : marketFor(detail)?.name || detail.sourceKind || "本地插件包"}</dd>
                {detail.interface?.developerName && <><dt>开发者</dt><dd>{detail.interface.developerName}</dd></>}
                {detail.installedDigest && <><dt>当前安装快照</dt><dd><code>{detail.installedDigest.slice(0, 8)}…{detail.installedDigest.slice(-8)}</code> <Button variant="link" onClick={async () => { try { await navigator.clipboard.writeText(detail.installedDigest!); setCopiedDigest(true); } catch { setError({ message: "无法复制内容摘要。" }); } }}>{copiedDigest ? "已复制完整摘要" : "复制完整摘要"}</Button></dd></>}
                {detail.installed && <><dt>目录内容</dt><dd>{detail.installedDigest === detail.sourceDigest ? "与已安装快照一致" : "与已安装快照不同"}</dd></>}
                {detail.version && <><dt>目录版本</dt><dd>{detail.version}</dd></>}
                {detail.interface?.websiteUrl && <><dt>网站</dt><dd><a href={detail.interface.websiteUrl} target="_blank" rel="noreferrer">{detail.interface.websiteUrl}</a></dd></>}
              </dl>
              {detail.interface?.longDescription && <p className="plugin-long-description">{detail.interface.longDescription}</p>}
              {Array.isArray(detail.interface?.capabilities) && detail.interface.capabilities.length > 0 && <><h3>目录声明的能力</h3><ul>{detail.interface.capabilities.map((capability: string) => <li key={capability}>{capability}</li>)}</ul></>}
              <SettingsDisclosure title="技术详情"><dl className="plugin-metadata"><dt>插件标识</dt><dd>{detail.id}</dd><dt>来源快照路径</dt><dd>{detail.source}</dd><dt>目录组件</dt><dd>{detail.components.join("、") || "无"}</dd><dt>目录内容摘要</dt><dd>{detail.sourceDigest}</dd>{detail.installedDigest && <><dt>已安装内容摘要</dt><dd>{detail.installedDigest}</dd></>}</dl>
                {detail.catalogSource !== undefined && <pre>{JSON.stringify(detail.catalogSource, null, 2)}</pre>}
                {!!detail.diagnostics.length && <><h3>目录包诊断</h3><ul>{detail.diagnostics.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
                {displayedError && <pre>{failureText(displayedError)}</pre>}
              </SettingsDisclosure>
              {detail.installed && detail.skills.length > 0 && (detail.installedDigest !== detail.sourceDigest) && <SettingsDisclosure title="目录包 Skills"><ul>{detail.skills.map(skill => <li key={skill.id}><strong>{skill.name}</strong><p>{skill.description}</p></li>)}</ul></SettingsDisclosure>}
            </div>}
            {(detail.installed ? detail.installedSkills : detail.skills).length > 0 && <section aria-label={detail.installed ? "已安装 Skills" : "目录包 Skills"} className="plugin-detail-resources"><h3>{detail.installed ? "已安装 Skills" : "目录包 Skills"}</h3><ul>{(detail.installed ? detail.installedSkills : detail.skills).map(skill => <li key={skill.id}><button disabled={!detail.installed || !detail.enabled} className="plugin-skill-link" onClick={() => openSkill({ ...skill, key: `${detail.id}:${skill.id}`, sourceLabel: `插件 · ${detail.displayName || detail.name}`, scope: "plugin", pluginId: detail.id, projectId, enabled: detail.enabled })}>{skill.name}</button><p>{skill.description}</p></li>)}</ul></section>}
            {detail.installed && detail.installedDigest && <PluginHookSettings id={detail.id} installedDigest={detail.installedDigest} disabled={disabled || detailLoading} api={api} onConfigure={async parameters => { await mutate("pluginHooksConfigure", parameters); }} refreshKey={catalog?.revision} />}
            {detail.installed && apps?.(detail.id)}
            {detail.installed && detail.installedOnboardingSkill && <section className="plugin-detail-resources"><h3>插件设置</h3><p>在普通对话中运行设置技能，由对话展示执行与审批。</p><Button disabled={disabled || !detail.enabled} onClick={() => void mutate("pluginSetup", { id: detail.id, ...(thread?.id ? { threadId: thread.id } : {}) })}>运行设置</Button></section>}
          </div>}
        </article>
      )}
      </div></div>
    </div>
  );
}
