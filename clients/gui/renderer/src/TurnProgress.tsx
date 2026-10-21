import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ActivityIcon } from "./ActivityIcon.js";
import { TurnElapsed } from "./TurnElapsed.js";
import type { Data } from "./services.js";

/** Local disclosure only. The parent supplies ordered content; hidden children stay
 * mounted so inspecting history never resets command details or replays work. */
export function TurnProgress({ settled, summaryAvailable, failures, unfinished, children, label, turn, connected = false }: {
  settled: boolean; summaryAvailable: boolean; failures: number; unfinished: boolean; children: ReactNode; label?: string;
  turn?: Data; connected?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!settled);
  const manual = useRef(false);
  useEffect(() => { if (!manual.current) setOpen(!settled); }, [settled]);
  const id = useId();
  const expanded = !summaryAvailable || open;
  return <Collapsible.Root open={expanded} className="turn-progress">
    {summaryAvailable && (turn ? <TurnElapsed turn={turn} connected={connected} disclosure={{ expanded, controls: id, failures, unfinished, onToggle: () => { manual.current = true; setOpen(!open); } }} /> : <div className="turn-progress-heading"><div className="turn-progress-label"><button className="turn-progress-summary" type="button" aria-label={t("chat.progress.accessibleLabel", { label: label ?? t("chat.progress.defaultLabel") })} aria-expanded={expanded} aria-controls={id} onClick={() => { manual.current = true; setOpen(!open); }}>
      <span>{t("chat.progress.title")}</span><span>{label ?? t("chat.progress.defaultLabel")}</span>{!!failures && <span className="execution-failures">{t("chat.progress.toolFailures", { count: failures })}</span>}{unfinished && <span>{t("chat.progress.unconfirmed")}</span>}<span className="conversation-disclosure-action" aria-hidden="true">{expanded ? t("chat.progress.collapse") : t("chat.progress.expand")}</span><ActivityIcon kind="chevron" size={14} className={expanded ? "open" : ""} />
    </button></div><div className="turn-progress-divider" /></div>)}
    <Collapsible.Panel keepMounted id={id} className="turn-progress-body conversation-disclosure">{children}</Collapsible.Panel>
  </Collapsible.Root>;
}
