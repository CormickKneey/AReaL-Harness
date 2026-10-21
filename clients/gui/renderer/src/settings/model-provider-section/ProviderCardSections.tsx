import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "../../lib/technicalInputAttributes.js";
import { useZCodeIntl } from "../../i18n/IntlProvider.js";
import { ApiKeyInput } from "./ApiKeyInput.js";
export function ProviderBaseUrlSection({ baseUrlValue, onBaseUrlChange, onBaseUrlBlur }: {
  baseUrlValue: string;
  onBaseUrlChange: (value: string) => void;
  onBaseUrlBlur: () => void;
}) {
  const { intl } = useZCodeIntl();
  return <div>
    <label className="mb-1 block text-ui-base text-foreground-subtle">{intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}</label>
    <Input {...TECHNICAL_INPUT_ATTRIBUTES} type="text" size="lg" aria-label="Base URL" data-testid="provider-base-url"
      value={baseUrlValue} placeholder={intl.formatMessage({ id: "settings.modelProvider.baseUrlPlaceholder" })}
      onChange={event => onBaseUrlChange(event.target.value)} onBlur={onBaseUrlBlur} />
  </div>;
}

export function ProviderApiKeySection({
  apiKeyValue,
  apiKeyVisible,
  readOnly,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  onApiKeyChange,
  onApiKeyBlur,
  onApiKeyKeyDown,
  onApiKeyCompositionStart,
  onApiKeyCompositionEnd,
  onToggleApiKeyVisibility,
}: {
  apiKeyValue: string;
  apiKeyVisible: boolean;
  readOnly?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyBlur: () => void;
  onApiKeyKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onApiKeyCompositionStart?: () => void;
  onApiKeyCompositionEnd?: () => void;
  onToggleApiKeyVisibility: () => void;
}) {
  const { t, intl } = useZCodeIntl();

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
        </label>
        {presetApiKeyUrl && onOpenPresetApiKey ? (
          <Button type="button" variant="ghost" onClick={onOpenPresetApiKey}>{t("settings.providerCardSections.getAPIKey")}</Button>
        ) : null}
      </div>
      <ApiKeyInput
        value={apiKeyValue}
        visible={apiKeyVisible}
        readOnly={readOnly}
        onChange={onApiKeyChange}
        onBlur={onApiKeyBlur}
        onKeyDown={onApiKeyKeyDown}
        onCompositionStart={onApiKeyCompositionStart}
        onCompositionEnd={onApiKeyCompositionEnd}
        onToggleVisibility={onToggleApiKeyVisibility}
      />
    </div>
  );
}
