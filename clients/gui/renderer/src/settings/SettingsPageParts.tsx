import type { ComponentProps } from "react";
import { SettingsValueAction as Value } from "@areal/ui/experimental";
import { SettingsSelect as Select } from "@areal/ui/compositions";
import { useI18n } from "../i18n/IntlProvider.js";
import "@areal/ui/settings.css";
export { SettingsLockedValue, SettingsBadge, SettingsSwitch } from "@areal/ui/experimental";
export function SettingsValueAction(props: ComponentProps<typeof Value>) {
  const { t } = useI18n();
  return <Value actionLabel={t("settings.settingsPageParts.change")} {...props} />;
}
export function SettingsSelect(props: ComponentProps<typeof Select>) {
  const { t } = useI18n();
  return (
    <Select
      placeholder={t("settings.settingsPageParts.selectAnOption")}
      emptyLabel={t("settings.settingsPageParts.noOptionsAvailable")}
      {...props}
    />
  );
}
