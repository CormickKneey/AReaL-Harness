import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ActivityIcon } from "./ActivityIcon.js";
import { TurnElapsed } from "./TurnElapsed.js";
import type { Data } from "./services.js";

/** Local disclosure only. The parent supplies ordered content; hidden children stay
 * mounted so inspecting history never resets command details or replays work. */
export function TurnProgress({ settled, summaryAvailable, failures, unfinished, children, label = "本轮过程", turn, connected = false }: {
  settled: boolean; summaryAvailable: boolean; failures: number; unfinished: boolean; children: ReactNode; label?: string;
  turn?: Data; connected?: boolean;
}) {
  const [open, setOpen] = useState(!settled);
  const manual = useRef(false);
  useEffect(() => { if (!manual.current) setOpen(!settled); }, [settled]);
  const id = useId();
  const expanded = !summaryAvailable || open;
  return <Collapsible.Root open={expanded} className="turn-progress">
    {summaryAvailable && (turn ? <TurnElapsed turn={turn} connected={connected} disclosure={{ expanded, controls: id, failures, unfinished, onToggle: () => { manual.current = true; setOpen(!open); } }} /> : <div className="turn-progress-heading"><div className="turn-progress-label"><button className="turn-progress-summary" type="button" aria-label={`执行过程：${label}`} aria-expanded={expanded} aria-controls={id} onClick={() => { manual.current = true; setOpen(!open); }}>
      <span>执行过程</span><span>{label}</span>{!!failures && <span className="execution-failures">{failures} 次工具失败</span>}{unfinished && <span>结果待确认</span>}<span className="conversation-disclosure-action" aria-hidden="true">{expanded ? "收起" : "展开"}</span><ActivityIcon kind="chevron" size={14} className={expanded ? "open" : ""} />
    </button></div><div className="turn-progress-divider" /></div>)}
    <Collapsible.Panel keepMounted id={id} className="turn-progress-body conversation-disclosure">{children}</Collapsible.Panel>
  </Collapsible.Root>;
}
