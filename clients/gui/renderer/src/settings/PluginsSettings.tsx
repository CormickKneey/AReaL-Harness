import { useGuardedNavigation } from "./UnsavedChanges.js";
import {
  PluginCatalogSettings,
  type PluginCatalogProps,
} from "./PluginCatalogSettings.js";
import { useState, type ReactNode } from "react";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { McpSettings, SkillsSettings } from "./ResourceSettings.js";

/** 插件包与手工资源共用设置入口，各自由原有状态所有者管理。 */
export function PluginsSettings({
  initialTab = "catalog",
  apps,
  ...props
}: PluginCatalogProps & { initialTab?: string; apps?: ReactNode }) {
  const navigate = useGuardedNavigation();
  const [tab, setTab] = useState(initialTab);
  const [scope, setScope] = useState("user");
  return (
    <div className="plugin-settings">
      <div className="flex items-center justify-between gap-4">
        <p className="plugin-subtitle text-foreground-subtle text-ui-sm">
          管理插件包、技能（Skills）与 MCP 服务器
        </p>
        <SettingsSegmentedTabs
          ariaLabel="插件类型"
          activateOnFocus={false}
          items={[
            { label: "插件包", value: "catalog" },
            { label: "MCP", value: "mcp" },
            ...(apps ? [{label:"应用",value:"apps"}] : []),
            { label: "Skills", value: "skills" },
          ]}
          value={tab}
          onValueChange={(value) => navigate(() => setTab(value))}
        />
      </div>
      {tab === "catalog" ? (
        <PluginCatalogSettings
          key={props.project?.id}
          {...props}
        />
      ) : tab === "apps" ? apps : tab === "mcp" ? (
        <McpSettings {...props} scope={scope} onScopeChange={setScope} />
      ) : (
        <SkillsSettings {...props} scope={scope} onScopeChange={setScope} />
      )}
    </div>
  );
}
