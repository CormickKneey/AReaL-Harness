import type { ComponentProps } from "react";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";
import type { Data } from "./services.js";

type ConversationComposerProps = Omit<ComponentProps<typeof ChatPromptEditor>, "betweenCancelAndSubmitAction"> & {
  project: Data;
  modelConfig?: Data;
  modelDisabled?: boolean;
  onConfigureModel: (values: Data) => void;
  onModelSettings: () => void;
};

/** Main and Side share the editor, toolbar and Core model catalog; callers own submission and drafts. */
export function ConversationComposer({ project, modelConfig: config, modelDisabled, onConfigureModel, onModelSettings, ...editor }: ConversationComposerProps) {
  return <ChatPromptEditor {...editor} betweenCancelAndSubmitAction={<ComposerModelMenu
    disabled={modelDisabled}
    effort={config?.parameters?.reasoningEffort}
    value={config?.model ? `${config.model.providerId}/${config.model.modelId}` : ""}
    options={[...(project.models.some((model: Data) => !model.providerId) ? [{ value: "", label: "默认模型", efforts: project.models.find((model: Data) => !model.providerId)?.reasoningEffortOptions }] : []), ...project.models.filter((model: Data) => model.providerId).map(composerModelOption)]}
    onEffortChange={value => onConfigureModel({ parameters: { ...config?.parameters, reasoningEffort: value } })}
    onChange={value => {
      if (!value) { onConfigureModel({ model: null }); return; }
      const model = project.models.find((item: Data) => `${item.providerId}/${item.modelId}` === value);
      if (model) onConfigureModel({ model: { providerId: model.providerId, modelId: model.modelId } });
    }}
    onClose={() => editor.inputApiRef?.current?.focus()}
    onConfigure={onModelSettings}
  />} />;
}
