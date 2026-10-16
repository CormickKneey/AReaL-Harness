import { useCallback, useEffect, useRef, useState } from "react";
import type { Action } from "../services.js";

export type PackageOwner = {
  pluginId: string;
  pluginName: string;
  installedDigest: string;
  enabled: boolean;
};
export type PluginSkillResource = {
  key: string;
  id: string;
  name: string;
  description: string;
  owner: PackageOwner;
};
export type PluginMcpResource = {
  key: string;
  serverId: string;
  state: string;
  owner: PackageOwner;
};
type InstalledPackage = {
  id: string;
  displayName: string;
  name: string;
  installed: boolean;
  installedDigest: string | null;
  enabled: boolean;
  installedSkills: { id: string; name: string; description: string }[];
};
type PluginConnection = {
  pluginId: string;
  installedDigest: string;
  state: string;
  servers: { serverId: string; state: string }[];
  diagnostics: unknown[];
};
type ResourceSnapshot = {
  projectId: string | null;
  skills: PluginSkillResource[];
  mcp: PluginMcpResource[];
  loading: boolean;
  error: string;
  notice: string;
};
export function pluginSourceLabel(owner: PackageOwner) {
  return `插件 ${owner.pluginName} · ${owner.pluginId}`;
}
export function pluginMcpStateLabel(state: string) {
  return ({
    connected: "已连接", disconnected: "未连接", failed: "连接失败",
    connecting: "连接中", disabled: "已停用", authRequired: "需要认证",
    partial: "部分服务未连接", cleanupUnknown: "清理结果待核对",
    authentication: "认证未完成", startup: "启动失败", discovery: "工具发现失败",
    stale: "工具目录已过期", notApplied: "未应用", unknown: "状态待核对",
    unsupported: "当前配置不受支持", missingMapping: "需要配置凭据映射",
    configuration: "服务配置无效，请在插件详情查看", policy: "服务配置受宿主策略限制",
  } as Record<string, string>)[state] ?? "状态待核对，请在插件详情查看";
}
function diagnosticText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const diagnostic = value as { serverId?: unknown; class?: unknown };
    if (typeof diagnostic.class === "string")
      return `${typeof diagnostic.serverId === "string" ? diagnostic.serverId + " · " : ""}${pluginMcpStateLabel(diagnostic.class)}`;
  }
  return "插件资源包含诊断信息，请在插件详情查看。";
}
const readError = (cause: unknown) =>
  cause instanceof Error ? cause.message : "读取插件资源失败。";

export function useInstalledPluginResources(
  projectId: string | null,
  connected: boolean,
  action: Action,
) {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot>({
    projectId: null, skills: [], mcp: [], loading: false, error: "", notice: "",
  });
  const generation = useRef(0);
  const actionRef = useRef(action);
  actionRef.current = action;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const next: ResourceSnapshot = { projectId, skills: [], mcp: [], loading: false, error: "", notice: "" };
    if (!projectId || !connected) {
      setSnapshot(next);
      return;
    }
    setSnapshot({ ...next, loading: true });
    const api = (operation: string) => actionRef.current("manage", { operation, projectId });
    try {
      const capability = await api("pluginCapabilities");
      if (request !== generation.current) return;
      if (!capability.enabled) {
        next.notice = "当前 Core 未启用插件目录。独立资源仍可使用。";
        setSnapshot(next);
        return;
      }
      const [catalog, connections] = await Promise.allSettled([api("plugins"), api("pluginMcp")]);
      if (request !== generation.current) return;
      const errors: string[] = [];
      const owners = new Map<string, PackageOwner>();
      if (catalog.status === "fulfilled") {
        const packages: InstalledPackage[] = catalog.value.data;
        for (const item of packages) {
          if (!item.installed || !item.installedDigest) continue;
          const owner: PackageOwner = {
            pluginId: item.id,
            pluginName: item.displayName || item.name,
            installedDigest: item.installedDigest,
            enabled: item.enabled,
          };
          owners.set(item.id, owner);
          for (const skill of item.installedSkills) {
            next.skills.push({
              key: JSON.stringify([item.id, item.installedDigest, "skill", skill.id]),
              id: skill.id, name: skill.name, description: skill.description, owner,
            });
          }
        }
        errors.push(...catalog.value.errors);
      } else errors.push(`插件目录：${readError(catalog.reason)}`);
      if (connections.status === "fulfilled" && catalog.status === "fulfilled") {
        const packages: PluginConnection[] = connections.value.data;
        for (const item of packages) {
          errors.push(...item.diagnostics.map((diagnostic) => `插件 ${item.pluginId}：${diagnosticText(diagnostic)}`));
          if (!item.servers.length) continue;
          const owner = owners.get(item.pluginId);
          if (!owner || owner.installedDigest !== item.installedDigest) {
            errors.push(`插件 ${item.pluginId} 的安装快照已变化，请刷新资源。`);
            continue;
          }
          for (const server of item.servers) {
            next.mcp.push({
              key: JSON.stringify([item.pluginId, item.installedDigest, "mcp", server.serverId]),
              serverId: server.serverId, state: server.state ?? item.state, owner,
            });
          }
        }
      } else if (connections.status === "rejected") {
        errors.push(`插件 MCP：${readError(connections.reason)}`);
      }
      next.error = errors.join(" ");
      setSnapshot(next);
    } catch (cause) {
      if (request === generation.current) setSnapshot({ ...next, error: readError(cause) });
    }
  }, [projectId, connected]);
  useEffect(() => {
    const changed = () => void refresh();
    window.addEventListener("areal-plugins-changed", changed);
    void refresh();
    return () => {
      generation.current++;
      window.removeEventListener("areal-plugins-changed", changed);
    };
  }, [refresh]);
  const current = snapshot.projectId === projectId && connected ? snapshot : {
    projectId, skills: [], mcp: [], loading: false, error: "",
    notice: !projectId ? "选择项目后查看已安装插件资源。" : !connected ? "项目尚未连接，请连接 Core 后查看插件资源。" : "",
  };
  return { ...current, refresh };
}
