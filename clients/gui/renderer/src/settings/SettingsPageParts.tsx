import { useI18n } from "../i18n/IntlProvider.js";
import { Children, isValidElement, Fragment, type ReactNode, type ReactElement } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import "./SettingsPageParts.css";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("settings-section", className)}>
      {(title || action || description) && (
        <div className="settings-section-heading">
          <div className="min-w-0">
            {title && <h2 className="settings-section-title">{title}</h2>}
            {description && <p className="settings-section-desc">{description}</p>}
          </div>
          {action && <div className="settings-section-action">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  detail,
  controlLayout = "default",
  disabled = false,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  detail?: ReactNode;
  controlLayout?: "default" | "wide";
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("settings-field-row", className)} aria-disabled={disabled || undefined}>
      <div
        className={cn(
          "settings-field-layout",
          controlLayout === "wide" && "settings-field-layout-wide",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="settings-field-label">{label}</div>
          {description ? (
            <div className="settings-field-description">{description}</div>
          ) : null}
        </div>
        <div className="settings-field-control">
          {controlLayout === "wide" ? detail : null}
          {control}
        </div>
      </div>
      {detail && controlLayout !== "wide" ? <div className="mt-3">{detail}</div> : null}
    </div>
  );
}

export function SettingsGroupCard({
  children,
  className,
  density,
}: {
  children: ReactNode;
  className?: string;
  density?: "compact";
}) {
  return (
    <div data-density={density} className={cn("settings-group-card", className)}>
      <div data-slot="card-content" className="settings-group-content">{children}</div>
    </div>
  );
}

export function SettingsLockedValue({ label, value }: { label: string; value: string }) {
  return (
    <button type="button" className="settings-locked-value" aria-label={label} disabled>
      <span>{value}</span>
    </button>
  );
}

export function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-surface px-2.5 py-1 text-ui-base font-medium text-foreground-subtle">
      {children}
    </span>
  );
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
    />
  );
}

export function SettingsValueAction({
  value,
  actionLabel,
  onAction,
  disabled = false,
}: {
  value: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3">
      <span className="min-w-0 text-ui-sm text-foreground-subtle max-w-[280px] truncate">{value}</span>
      {onAction && (
        <Button type="button" variant="secondary" onClick={onAction} disabled={disabled}>
          {actionLabel ?? t("settings.settingsPageParts.change")}
        </Button>
      )}
    </div>
  );
}

/** Settings values use a segmented pair or the shared menu, never a native select. */
export function SettingsSelect({ children, value, onValueChange, disabled, className, "aria-label": label }: {
  children: ReactNode; value: string | number; onValueChange: (value: string) => void;
  disabled?: boolean; className?: string; "aria-label": string;
}) {
  const { t } = useI18n();
  const text = (nodes: ReactNode): string => Children.toArray(nodes).map(node =>
    isValidElement(node) ? text((node.props as {children?: ReactNode}).children) : String(node),
  ).join("");
  const options: {value: string; label: string; disabled?: boolean}[] = [];
  const collect = (nodes: ReactNode) => Children.forEach(nodes, node => {
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{value?: string | number; children?: ReactNode; disabled?: boolean}>;
    if (element.type === Fragment) collect(element.props.children);
    else if (element.type === "option") options.push({value: String(element.props.value ?? text(element.props.children)), label: text(element.props.children), disabled: element.props.disabled});
  });
  collect(children);
  if (options.length === 2) return <SettingsSegmentedTabs ariaLabel={label} activateOnFocus={false}
    disabled={disabled} value={String(value)} onValueChange={onValueChange} items={options} />;
  return <Select value={String(value)} items={options} onValueChange={next => { if (next !== null) onValueChange(next); }} disabled={disabled}>
    <SelectTrigger aria-label={label} variant="secondary" size="sm" className={className}><SelectValue placeholder={options.length ? t("settings.settingsPageParts.selectAnOption") : t("settings.settingsPageParts.noOptionsAvailable")} /></SelectTrigger>
    <SelectContent align="end">{options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
