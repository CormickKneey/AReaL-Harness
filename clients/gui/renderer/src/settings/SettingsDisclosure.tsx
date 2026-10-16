import { forwardRef, useId, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../components/lib/utils.js";
import "./SettingsWorkspace.css";

/** Native disclosure semantics with an explicit text action, never a triangle. */
export const SettingsDisclosure = forwardRef<HTMLDetailsElement, Omit<ComponentPropsWithoutRef<"details">, "title"> & { title: ReactNode }>(
  function SettingsDisclosure({ title, children, className, onToggle, open, ...props }, ref) {
    const [expanded, setExpanded] = useState(open === true);
    const id = useId();
    return <details {...props} ref={ref} open={open} className={cn("settings-disclosure", className)} onToggle={event => {
      setExpanded(event.currentTarget.open);
      onToggle?.(event);
    }}>
      <summary aria-expanded={expanded} aria-controls={id}>
        <span className="settings-disclosure-title">{title}</span>
        <span className="settings-disclosure-action">{expanded ? "收起" : "展开"}</span>
      </summary>
      <div id={id}>{children}</div>
    </details>;
  },
);
