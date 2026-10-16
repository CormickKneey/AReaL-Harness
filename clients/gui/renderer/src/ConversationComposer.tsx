import type { ComponentProps } from "react";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";
import type { Data } from "./services.js";

type ConversationComposerProps = Omit<ComponentProps<typeof ChatPromptEditor>, "betweenCancelAndSubmitAction"> & {
  project: Data;
  modelConfig?: Data;
  modelDisabled?: boolean;
  allowModelInheritance?: boolean;
  onConfigureModel: (values: Data) => void;
  onModelSettings: () => void;
};

/** Main and Side share the editor, toolbar and Core model catalog; callers own submission and drafts. */
export function ConversationComposer({ project, modelConfig: config, modelDisabled, onConfigureModel, onModelSettings, allowModelInheritance, ...editor }: ConversationComposerProps) {
  const value = allowModelInheritance && config?.model === undefined ? "__inherit" : config?.model ? `${config.model.providerId}/${config.model.modelId}` : "";
  const options = project.models.filter((item: Data) => item.providerId || !project.models.some((candidate: Data) => candidate.providerId && candidate.isDefault)).map(composerModelOption);
  if (config?.model && !options.some((option: { value: string }) => option.value === value)) {
    options.push({ value, label: config.model.modelId });
  } else if (config?.model === null) {
    const implicit = options.find((option: { value: string }) => option.value === "");
    const implicitEfforts = project.models.find((item: Data) => !item.providerId)?.reasoningEffortOptions;
    const historical = { value: "", label: config.modelName || "历史默认模型未知", efforts: implicitEfforts };
    if (implicit) options.splice(options.indexOf(implicit), 1, historical);
    else options.unshift(historical);
  }
  return <ChatPromptEditor {...editor} betweenCancelAndSubmitAction={<ComposerModelMenu
    disabled={modelDisabled}
    effort={config?.resolvedParameters?.reasoningEffort ?? config?.parameters?.reasoningEffort}
    value={value}
    options={[...(allowModelInheritance ? [{ value: "__inherit", label: "继承锚点模型" }] : []), ...options]}
    onEffortChange={value => onConfigureModel({ parameters: { ...config?.parameters, reasoningEffort: value || null } })}
    onChange={value => {
      if (value === "__inherit") { onConfigureModel({ model: undefined }); return; }
      if (!value) { onConfigureModel({ model: null }); return; }
      const model = project.models.find((item: Data) => `${item.providerId}/${item.modelId}` === value);
      if (model) onConfigureModel({ model: { providerId: model.providerId, modelId: model.modelId } });
    }}
    onClose={() => editor.inputApiRef?.current?.focus()}
    onConfigure={onModelSettings}
  />} />;
}
