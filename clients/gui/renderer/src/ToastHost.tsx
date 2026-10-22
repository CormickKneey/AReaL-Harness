import { useEffect, useRef, useState } from "react";
import type { ToastMessage } from "./components/ui/toast.js";

type ActiveToast = ToastMessage & { id: number };

export function ToastHost() {
  const [active, setActive] = useState<ActiveToast | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      const value = typeof detail === "string" ? { message: detail, tone: "info" as const } : detail;
      if (!value || typeof value !== "object" || !("message" in value) || typeof value.message !== "string" || !value.message.trim()) return;
      const tone = "tone" in value && (value.tone === "warning" || value.tone === "error") ? value.tone : "info";
      clearTimeout(timer);
      setActive({ id: ++sequence.current, message: value.message, tone });
      timer = setTimeout(() => setActive(null), 5000);
    };
    document.addEventListener("areal:toast", show);
    return () => { document.removeEventListener("areal:toast", show); clearTimeout(timer); };
  }, []);
  return <div role="status" aria-live="polite" aria-atomic="true" data-testid={active ? "toast" : undefined} data-tone={active?.tone} className="pointer-events-none fixed left-1/2 z-50 -translate-x-1/2"
    style={{ top: "calc(var(--shell-bar-height, 44px) + 12px)", width: "max-content", maxWidth: "min(480px, calc(100vw - 32px))" }}>
    {active && <div key={active.id}
      className="rounded-xl border border-border bg-surface px-4 py-2 text-ui-sm text-foreground shadow-lg"
      style={{ overflowWrap: "anywhere" }}>{active.message}</div>}
  </div>;
}
