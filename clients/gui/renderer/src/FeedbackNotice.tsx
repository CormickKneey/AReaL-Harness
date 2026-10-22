import type { ReactNode } from "react";
import { CircleAlert, Info, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
import { useI18n } from "./i18n/IntlProvider.js";

export function FeedbackNotice({ tone, message, detail, actions, onDismiss, id, requestId }: {
  tone: "info" | "warning" | "error";
  message: string;
  detail?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  id?: string;
  requestId?: string;
}) {
  const { t } = useI18n();
  const Icon = tone === "info" ? Info : CircleAlert;
  return <div id={id} data-testid="feedback-notice" data-tone={tone} data-recovery-request-id={requestId}
    className="pointer-events-auto mx-2 mb-2 min-w-0 shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption text-foreground">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-2" role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} aria-atomic="true">
        <Icon size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${tone === "error" ? "text-destructive" : "text-foreground-subtle"}`} />
        <span className="min-w-0 break-words">{message}</span>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1">{actions}</div>}
      {onDismiss && <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t("recovery.dismiss")} onClick={onDismiss}><X size={14} /></Button>}
    </div>
    {detail && <SettingsDisclosure className="mt-1 min-w-0" title={t("recovery.details")}>
      <div className="max-h-48 min-w-0 overflow-y-auto whitespace-pre-wrap text-foreground-subtle [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]">{detail}</div>
    </SettingsDisclosure>}
  </div>;
}
