import { useI18n } from "../i18n/IntlProvider.js";
import { useId, useState, type ReactNode } from "react";
import { NavigationBackIcon as ArrowLeft, NavigationForwardIcon as ArrowRight } from "../interfaceIcons.js";
import { useNavigationBusy } from "./UnsavedChanges.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { NavigationSidebar } from "../app-shell/WorkbenchShell.js";
import { cn } from "../components/lib/utils.js";
import "./SettingsWorkspace.css";

export type SettingsNavigationGroup = {
  id: string;
  label: string;
  items: readonly { id: string; label: string; icon?: ReactNode }[];
};

/** Presentation only. The host guards navigation and owns the active page. */
export function SettingsNavigation({ groups, activeId, onSelect, onBack, width, footer, rail }: {
  groups: readonly SettingsNavigationGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  onBack: () => void;
  width?: number;
  footer?: ReactNode;
  rail?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const navigationBusy = useNavigationBusy();
  const visibleGroups = groups
    .map(group => ({
      ...group,
      items: group.items.filter(item =>
        item.label.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))
      ),
    }))
    .filter(group => group.items.length);

  return (
    <NavigationSidebar className="settings-sidebar" width={width} rail={rail} footer={footer}
      chrome={<div className="workspace-navigation">
        <button type="button" className="icon-button settings-back" aria-label={t("settings.settingsWorkspace.backToApp")} title={t("settings.settingsWorkspace.backToApp")} disabled={navigationBusy} onClick={onBack}><ArrowLeft size={16} /></button>
        <button type="button" className="icon-button" aria-label={t("settings.settingsWorkspace.forward")} disabled><ArrowRight size={16} /></button>
      </div>}>
      <div className="settings-sidebar-header">
        <h1 className="settings-sidebar-title">{t("settings.settingsWorkspace.settings")}</h1>
        <SettingsSearchInput
          containerClassName="settings-navigation-search"
          aria-label={t("settings.settingsWorkspace.searchSettings")}
          placeholder={t("settings.settingsWorkspace.search")}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          clearLabel={t("settings.settingsWorkspace.clearSettingsSearch")}
        />
      </div>
      <nav className="settings-category-navigation" aria-label={t("settings.settingsWorkspace.settingsNavigation")}>
        {visibleGroups.map(group => (
          <section key={group.id} aria-label={group.label}>
            <div className="settings-group-label">{group.label}</div>
            {group.items.map(item => (
              <button
                key={item.id}
                type="button"
                className="settings-navigation-item"
                aria-current={activeId === item.id ? "page" : undefined}
                aria-pressed={activeId === item.id}
                disabled={navigationBusy}
                onClick={() => onSelect(item.id)}
                title={item.label}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </section>
        ))}
        {!visibleGroups.length && (
          <p className="settings-navigation-empty" role="status">
            {t("settings.settingsWorkspace.noMatchingSettings")}</p>
        )}
      </nav>
    </NavigationSidebar>
  );
}

/** One scroll owner and the shared centered settings column. */
export function SettingsPage({
  title,
  subtitle,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className="settings-workspace" tabIndex={0} aria-labelledby={title ? id : undefined}>
      <div className={cn("settings-page", className)}>
        {title && (
          <header className="settings-page-header">
            <h1 id={id} className="settings-page-title">
              {title}
            </h1>
            {subtitle && <p className="settings-page-subtitle">{subtitle}</p>}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}
