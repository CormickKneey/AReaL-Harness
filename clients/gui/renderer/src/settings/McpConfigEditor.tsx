import { Textarea } from "@areal/ui";
import { useI18n } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useState } from "react";
import { Input } from "../components/ui/input.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import type { Data } from "../services.js";

/** ZCode 的表单/JSON 交互，字段严格映射到 Core ServerConfig。 */
export function McpConfigEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"form" | "json">("form");
  let config: Data | null = null;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.transport && typeof parsed.transport === "object") config = parsed;
  } catch {}
  const update = (patch: Data) => onChange(JSON.stringify({ ...config, ...patch }, null, 2));
  const transport = config?.transport ?? {};
  const updateTransport = (patch: Data) => update({ transport: { ...transport, ...patch } });
  return (
    <>
      <SettingsSegmentedTabs
        items={[
          { value: "form", label: t("settings.mcpConfigEditor.form") },
          { value: "json", label: "JSON" },
        ]}
        value={mode}
        onValueChange={setMode}
      />
      {mode === "json" || !config ? (
        <label>
          {t("settings.mcpConfigEditor.mcpConfigurationJSON")}
          <Textarea
            unstyled
            data-slot={undefined}
            rows={12}
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {!config && <small>{t("settings.mcpConfigEditor.fixTheJSONBeforeSwitchingToThe")}</small>}
        </label>
      ) : (
        <>
          <div className="settings-choice-field">
            {t("settings.mcpConfigEditor.type")}
            <SettingsSelect
              aria-label={t("settings.mcpConfigEditor.type")}
              value={transport.type}
              onValueChange={(selectedValue) =>
                update({
                  transport:
                    selectedValue === "stdio"
                      ? { type: "stdio", command: "", args: [] }
                      : { type: "streamableHttp", url: "" },
                })
              }
            >
              <option value="stdio">{t("settings.mcpConfigEditor.stdioLocalCommand")}</option>
              <option value="streamableHttp">{t("settings.mcpConfigEditor.streamableHttp")}</option>
            </SettingsSelect>
          </div>
          {transport.type === "stdio" ? (
            <>
              <label>
                {t("settings.mcpConfigEditor.command")}
                <Input
                  required
                  value={transport.command ?? ""}
                  onChange={(e) => updateTransport({ command: e.target.value })}
                  placeholder="npx"
                />
              </label>
              <label>
                {t("settings.mcpConfigEditor.argumentsOnePerLine")}
                <Textarea
                  unstyled
                  data-slot={undefined}
                  rows={2}
                  value={(transport.args ?? []).join("\n")}
                  onChange={(e) =>
                    updateTransport({
                      args: e.target.value ? e.target.value.split("\n") : [],
                    })
                  }
                  placeholder={"-y\n@modelcontextprotocol/server-memory"}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                {t("settings.mcpConfigEditor.serverURL")}
                <Input
                  required
                  type="url"
                  value={transport.url ?? ""}
                  onChange={(e) => updateTransport({ url: e.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <label>
                {t("settings.mcpConfigEditor.authenticationEnvironmentVariableOptional")}
                <Input
                  value={transport.bearerTokenEnv ?? ""}
                  onChange={(e) => updateTransport({ bearerTokenEnv: e.target.value || null })}
                  placeholder="MY_SERVICE_TOKEN"
                />
              </label>
            </>
          )}
          <SettingsDisclosure title={<> {t("settings.mcpConfigEditor.advancedSettings")}</>}>
            <div className="settings-form mt-3">
              {transport.type === "stdio" && (
                <>
                  <label>
                    {t("settings.mcpConfigEditor.workingDirectoryOptional")}
                    <Input
                      value={transport.cwd ?? ""}
                      onChange={(e) => updateTransport({ cwd: e.target.value || null })}
                    />
                  </label>
                  <label>
                    {t("settings.mcpConfigEditor.inheritedEnvironmentVariablesOneNamePerLine")}
                    <Textarea
                      unstyled
                      data-slot={undefined}
                      rows={2}
                      value={(transport.envVars ?? []).join("\n")}
                      onChange={(e) =>
                        updateTransport({
                          envVars: e.target.value ? e.target.value.split("\n") : [],
                        })
                      }
                      placeholder="MY_SERVICE_TOKEN"
                    />
                    <small>
                      {t("settings.mcpConfigEditor.enterVariableNamesFromTheStartupEnvironment")}
                    </small>
                  </label>
                </>
              )}
              <label>
                {t("settings.mcpConfigEditor.startupTimeoutMs")}
                <Input
                  type="number"
                  min={1}
                  placeholder="30000"
                  value={config.startupTimeoutMs ?? ""}
                  onChange={(e) =>
                    update({
                      startupTimeoutMs: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </label>
              <label>
                {t("settings.mcpConfigEditor.callTimeoutMs")}
                <Input
                  type="number"
                  min={1}
                  placeholder="120000"
                  value={config.callTimeoutMs ?? ""}
                  onChange={(e) =>
                    update({
                      callTimeoutMs: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </label>
            </div>
          </SettingsDisclosure>
        </>
      )}
    </>
  );
}
