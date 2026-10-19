import { useEffect } from "react";
import { SettingsSelect, SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";
import { Feedback, useResource } from "./common.js";
import { useSettingsOperation } from "./useSettingsOperation.js";
import type { Action, Data } from "../services.js";

/** Application default; current-thread configuration remains owned by SessionSettings. */
export function NewSessionModelSetting({ action, disabled, onBusyChange }: {
  action: Action; disabled: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const api = (operation: string, values: Data = {}) => action("providers", { operation, ...values });
  const catalog = useResource(() => api("list"), "application");
  const subscription = useResource(() => action("chatgpt", { operation: "status", provider: "openai" }), "chatgpt-subscription-openai");
  const { busy, error, run } = useSettingsOperation();
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const options = [
    ...(subscription.value?.authenticated ? subscription.value.models ?? [] : []).map((model: Data) => ({
      providerId: "areal_openai", modelId: model.id, label: model.displayName || model.name || model.id,
    })),
    ...(catalog.value?.data ?? []).filter((provider: Data) => provider.enabled).flatMap((provider: Data) =>
      provider.models.filter((model: Data) => model.enabled).map((model: Data) => ({
        providerId: provider.id, modelId: model.id, label: model.displayName || model.id,
      }))),
  ];
  const overrides = Object.entries(catalog.value?.effective?.sources ?? {}).filter(([field, source]) => field.startsWith("model.") && ["env", "cli"].includes((source as Data).kind));
  const current = catalog.value?.defaultModel;
  const value = current ? `${current.providerId}/${current.modelId}` : "";
  return <SettingsSection title="新会话" description="新会话沿用主会话最后一次受理的模型与思考强度；已有会话保持不变。没有使用记录或模型不可用时使用备用默认模型。">
    <Feedback error={catalog.error || subscription.error || error} />
    {overrides.length > 0 && <p role="status" className="settings-muted">命令行或环境配置覆盖了文件值；保存不会修改这些覆盖。</p>}
    <SettingsGroupCard><SettingsRow label="备用默认模型" control={
      <SettingsSelect aria-label="备用默认模型" value={value} disabled={disabled || busy || catalog.loading || subscription.loading || !options.length} onValueChange={next => {
        const choice = options.find(option => `${option.providerId}/${option.modelId}` === next);
        if (!choice || next === value) return;
        void run(async () => {
          try { catalog.accept(await api("defaultAndApply", { expectedRevision: catalog.value?.revision, model: { providerId: choice.providerId, modelId: choice.modelId } })); }
          catch (cause) { await catalog.refresh(); throw cause; }
        });
      }}>
        {!options.some(option => `${option.providerId}/${option.modelId}` === value) && <option value={value}>{current?.modelId || "尚未设置"}</option>}
        {options.map(option => <option key={`${option.providerId}/${option.modelId}`} value={`${option.providerId}/${option.modelId}`}>{option.label}</option>)}
      </SettingsSelect>
    } /></SettingsGroupCard>
  </SettingsSection>;
}
