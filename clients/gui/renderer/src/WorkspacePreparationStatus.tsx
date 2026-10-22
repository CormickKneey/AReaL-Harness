import { useState } from "react";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

export type WorkspacePreparationState =
  | { kind: "preparing" }
  | { kind: "unavailable"; detail: string }
  | { kind: "ready" };

export function WorkspacePreparationStatus({ state, scope = "connection", onRetry }: {
  state: WorkspacePreparationState;
  scope?: "connection" | "workspace" | "info";
  onRetry?: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  if (state.kind === "ready") return null;
  const label = state.kind === "preparing" || retrying
    ? t(scope === "connection" ? "workspace.connecting" : scope === "info" ? "workspace.readingInfo" : "workspace.preparing")
    : t(scope === "connection" ? "workspace.connectionUnavailable" : scope === "info" ? "workspace.infoUnavailable" : "workspace.preparationUnavailable");
  if (state.kind === "preparing") return <span role="status" data-testid="workspace-preparation-status">{label}</span>;
  return <Popover>
    <PopoverTrigger render={<Button type="button" data-testid="workspace-preparation-status" variant="ghost" size="sm" className="h-auto min-w-0 px-1 py-0 text-ui-sm text-foreground-subtle" />}>
      {label}
    </PopoverTrigger>
    <PopoverContent align="start" data-testid="workspace-preparation-details">
      <PopoverTitle>{label}</PopoverTitle>
      <PopoverDescription>{t(scope === "info" ? "workspace.infoSupplemental" : "workspace.draftEditable")}</PopoverDescription>
      <SettingsDisclosure title={t("recovery.details")}>
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-ui-sm text-foreground-subtle [overflow-wrap:anywhere]">{state.detail}</pre>
      </SettingsDisclosure>
      {onRetry && <Button type="button" variant="ghost" size="sm" className="self-start" disabled={retrying} onClick={() => {
        setRetrying(true);
        void onRetry().catch(() => {}).finally(() => setRetrying(false));
      }}>{t(scope === "workspace" ? "recovery.retryPrepare" : "recovery.reconnectProject")}</Button>}
    </PopoverContent>
  </Popover>;
}
