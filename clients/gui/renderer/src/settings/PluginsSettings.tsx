import { useGuardedNavigation } from "./UnsavedChanges.js";
import {
  PluginCatalogSettings,
  type PluginCatalogProps,
} from "./PluginCatalogSettings.js";
import { useState } from "react";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { McpSettings, SkillsSettings } from "./ResourceSettings.js";
import { Feedback } from "./common.js";
import { useInstalledPluginResources } from "./pluginResources.js";

export function PluginsSettings({
  initialTab = "catalog",
  apps,
  ...props
}: PluginCatalogProps & { initialTab?: string }) {
  const navigate = useGuardedNavigation();
  const [tab, setTab] = useState(initialTab);
  const [scope, setScope] = useState("user");
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const resources = useInstalledPluginResources(
    props.project?.id ?? null, !!props.project?.state?.connected, props.action,
  );
  const managePlugin = (id: string) => navigate(() => {
    setSelectedPluginId(id);
    setTab("catalog");
  });
  return (
    <div className="plugin-settings">
      <div className="flex items-center justify-between gap-4">
        <p className="plugin-subtitle text-foreground-subtle text-ui-sm">
          管理插件、Skills 与 MCP 服务器
        </p>
        <SettingsSegmentedTabs
          ariaLabel="插件类型"
          activateOnFocus={false}
          items={[
            { label: "插件", value: "catalog" },
            { label: "Skills", value: "skills" },
            { label: "MCP", value: "mcp" },
          ]}
          value={tab}
          onValueChange={(value) => navigate(() => setTab(value))}
        />
      </div>
      <div hidden={tab !== "catalog"}>
        <PluginCatalogSettings
          key={props.project?.id}
          {...props}
          apps={apps}
          active={tab === "catalog"}
          selectedPluginId={selectedPluginId}
          onSelectPlugin={setSelectedPluginId}
        />
      </div>
      {tab !== "catalog" && <>
        <p className="text-foreground-subtle text-ui-sm">
          资源范围仅筛选独立资源。插件资源显示当前项目的有效状态，由所属插件管理。
        </p>
        <Feedback error={resources.error} message={resources.loading ? "正在读取插件资源…" : resources.notice} />
        {tab === "mcp" ? (
          <McpSettings {...props} scope={scope} onScopeChange={setScope}
            pluginServers={resources.mcp} onManagePlugin={managePlugin} onRefreshPlugins={resources.refresh} />
        ) : (
          <SkillsSettings {...props} scope={scope} onScopeChange={setScope}
            pluginSkills={resources.skills} onManagePlugin={managePlugin} onRefreshPlugins={resources.refresh} />
        )}
      </>}
    </div>
  );
}
