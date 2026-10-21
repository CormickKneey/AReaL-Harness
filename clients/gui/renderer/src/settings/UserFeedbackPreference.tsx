import { useI18n } from "../i18n/IntlProvider.js";
import { useState } from "react";
import type { Action } from "../services.js";
import { refreshFeedbackAvailability, useFeedbackAvailability } from "../user-feedback-status.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";

export function UserFeedbackPreference({
    action,
    connected,
}: {
    action: Action;
    connected: boolean;
}) {
  const { t } = useI18n();
    const value = useFeedbackAvailability(action, connected);
    const [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const change = async (enabled: boolean) => {
        if (!connected || busy || !value.supported) return;
        setBusy(true);
        setError("");
        try {
            await action("feedback", { operation: "preference", enabled });
            await refreshFeedbackAvailability(action);
        } catch (cause) {
            setError((cause as Error).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <SettingsSection title={t("settings.userFeedbackPreference.responseFeedback")} description={t("settings.userFeedbackPreference.optionallySubmitAThumbsUpOrThumbs")}>
            <SettingsGroupCard>
                <SettingsRow
                    label={t("settings.userFeedbackPreference.showThumbsUpAndThumbsDown")}
                    description={t("settings.userFeedbackPreference.shownBelowResponsesWhenDataFeedbackIs")}
                    control={
                        <Switch
                            aria-label={t("settings.userFeedbackPreference.showThumbsUpAndThumbsDown")}
                            checked={value.opted_in}
                            disabled={!connected || busy || !value.supported}
                            onCheckedChange={(enabled) => void change(enabled)}
                        />
                    }
                />
            </SettingsGroupCard>
            {connected && !value.supported && (
                <p role="status" className="settings-section-desc">
                    {t("settings.userFeedbackPreference.feedbackStatusIsUnavailableFromTheBackend")}</p>
            )}
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
        </SettingsSection>
    );
}
