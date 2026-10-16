export type ProviderApiType = "chatCompletions" | "responses";
import { SettingsSelect } from "../SettingsPageParts.js";
import { useZCodeIntl } from "../../i18n/IntlProvider.js";

const PROVIDER_CONNECTION_API_FORMATS: readonly ProviderApiType[] = [
  "chatCompletions",
  "responses",
];

const PROVIDER_CONNECTION_API_FORMAT_PATHS: Record<ProviderApiType, string> = {
  "chatCompletions": "/chat/completions",
  "responses": "/responses",
};

const PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS: Record<ProviderApiType, string> = {
  "chatCompletions": "settings.modelProvider.apiFormat.title.chatCompletions",
  "responses": "settings.modelProvider.apiFormat.title.responses",
};

export function resolveProviderConnectionApiFormatOptions(): ProviderApiType[] {
  return [...PROVIDER_CONNECTION_API_FORMATS];
}

export function resolveProviderConnectionApiFormatDisplayLabel(
  intl: { formatMessage: (descriptor: { id: string }) => string },
  format: ProviderApiType,
): string {
  const title = intl.formatMessage({
    id: PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS[format],
  });
  return `${title} (${PROVIDER_CONNECTION_API_FORMAT_PATHS[format]})`;
}

export function ProviderApiFormatSelect({
  apiFormatOptions = PROVIDER_CONNECTION_API_FORMATS,
  triggerId,
  value,
  onChange,
}: {
  apiFormatOptions?: readonly ProviderApiType[];
  triggerId?: string;
  value: ProviderApiType;
  onChange: (value: ProviderApiType) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div id={triggerId}>
      <SettingsSelect aria-label="API 格式" value={value} onValueChange={next => onChange(next as ProviderApiType)}>
        {apiFormatOptions.map(format => <option key={format} value={format}>{intl.formatMessage({id: PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS[format]})}</option>)}
      </SettingsSelect>
    </div>
  );
}
