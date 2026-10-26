import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useRef, useState } from "react";
import { useI18n } from "../i18n/IntlProvider.js";
import { Button } from "../components/ui/button.js";
import type { Action } from "../services.js";

export function BrowserDataSettings({
  action,
  connected,
}: {
  action?: Action;
  connected: boolean;
}) {
  const { t } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const run = async (operation: "importChrome" | "clearCache" | "clearAll") => {
    if (!action || !connected || pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      if (operation === "importChrome") {
        const value = await action("browserData", { operation });
        if (!value.success) throw Error(value.error ?? "browser_data_failed");
        setMessage(
          t("settings.browserData.imported", {
            cookies: value.cookies.imported,
            origins: value.localStorage.originsImported,
            skipped: value.cookies.skipped + value.localStorage.originsSkipped,
            failed: value.cookies.failed + value.localStorage.originsFailed,
          }),
        );
        if (value.issues?.length) setError(value.issues.join(", "));
      } else {
        await action("browserData", { operation });
        setMessage(t("settings.browserData.cleared"));
      }
      setConfirmClear(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const disabled = !action || !connected || busy;
  return (
    <SettingsSection
      title={t("settings.browserData.title")}
      description={t("settings.browserData.sharedDescription")}
    >
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.browserData.import")}
          description={t("settings.browserData.importDescription")}
          control={
            <Button variant="outline" disabled={disabled} onClick={() => void run("importChrome")}>
              {t("settings.browserData.import")}
            </Button>
          }
        />
        <SettingsRow
          label={t("settings.browserData.clearCache")}
          description={t("settings.browserData.cacheDescription")}
          control={
            <Button variant="outline" disabled={disabled} onClick={() => void run("clearCache")}>
              {t("settings.browserData.clearCache")}
            </Button>
          }
        />
        <SettingsRow
          label={t("settings.browserData.clearAll")}
          description={
            confirmClear
              ? t("settings.browserData.confirmDescription")
              : t("settings.browserData.allDescription")
          }
          controlLayout="wide"
          control={
            confirmClear ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmClear(false)}>
                  {t("settings.browserData.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => void run("clearAll")}
                >
                  {t("settings.browserData.confirmClear")}
                </Button>
              </div>
            ) : (
              <Button variant="outline" disabled={disabled} onClick={() => setConfirmClear(true)}>
                {t("settings.browserData.clearAll")}
              </Button>
            )
          }
        />
      </SettingsGroupCard>
    </SettingsSection>
  );
}
