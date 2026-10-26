import { Button } from "@areal/ui";
import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ActivityIcon } from "./ActivityIcon.js";
import { TurnElapsed } from "./TurnElapsed.js";
import type { Data } from "./services.js";

/** 过程组因回合完成而自动收起前派发的事件名；冒泡到消息列表。 */
export const progressAutoCollapse = "areal:progress-auto-collapse";

/** Local disclosure only. The parent supplies ordered content; children mount on
 * first expansion and stay mounted so collapsing never resets command details. */
export function TurnProgress({
  settled,
  summaryAvailable,
  children,
  label,
  turn,
  connected = false,
}: {
  settled: boolean;
  summaryAvailable: boolean;
  children: ReactNode;
  label?: string;
  turn?: Data;
  connected?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!settled);
  const manual = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (manual.current) return;
    // 完成时自动收起前先通知阅读宿主，由它决定是否以本标题为锚保持阅读位置（S-4）。
    if (settled)
      root.current?.dispatchEvent(new CustomEvent(progressAutoCollapse, { bubbles: true }));
    setOpen(!settled);
  }, [settled]);
  const id = useId();
  const expanded = !summaryAvailable || open;
  const [hasExpanded, setHasExpanded] = useState(expanded);
  useEffect(() => {
    if (expanded) setHasExpanded(true);
  }, [expanded]);
  return (
    <Collapsible.Root ref={root} open={expanded} className="turn-progress">
      {summaryAvailable &&
        (turn ? (
          <TurnElapsed
            turn={turn}
            connected={connected}
            disclosure={{
              expanded,
              controls: id,
              onToggle: () => {
                manual.current = true;
                setOpen(!open);
              },
            }}
          />
        ) : (
          <div className="turn-progress-heading">
            <div className="turn-progress-label">
              <Button
                unstyled
                data-slot={undefined}
                className="turn-progress-summary"
                type="button"
                aria-label={t("chat.progress.accessibleLabel", {
                  label: label ?? t("chat.progress.defaultLabel"),
                })}
                aria-expanded={expanded}
                aria-controls={id}
                onClick={() => {
                  manual.current = true;
                  setOpen(!open);
                }}
              >
                <span>{label ?? t("chat.progress.defaultLabel")}</span>
                <ActivityIcon kind="chevron" size={14} className={expanded ? "open" : ""} />
              </Button>
            </div>
            <div className="turn-progress-divider" />
          </div>
        ))}
      <Collapsible.Panel keepMounted id={id} className="turn-progress-body conversation-disclosure">
        {expanded || hasExpanded ? children : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
