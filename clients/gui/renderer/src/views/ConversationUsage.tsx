import { useI18n } from "../i18n/IntlProvider.js";
import type { Data } from "../services.js";

export function ConversationUsage({ thread }: { thread: Data }) {
  const { intl, t } = useI18n();
  const turns = thread.turns ?? [];
  const known = turns.filter((turn: Data) => turn.usage);
  const sum = (key: string) =>
    known.every((turn: Data) => typeof turn.usage[key] === "number")
      ? known.reduce((total: number, turn: Data) => total + turn.usage[key], 0)
      : null;
  return (
    <div className="utility-content">
      <h2>{t("chat.usage.actual")}</h2>
      <p className="text-foreground-subtle">{t("chat.usage.confirmedNote")}</p>
      <div className="usage-grid">
        {(
          [
            ["inputTokens", "chat.usage.inputTokens"],
            ["cachedInputTokens", "chat.usage.cachedTokens"],
            ["outputTokens", "chat.usage.outputTokens"],
          ] as const
        ).map(([key, label]) => {
          const value = sum(key);
          return (
            <article key={key}>
              <small>{t(label)}</small>
              <strong>
                {!known.length
                  ? "—"
                  : value == null
                    ? t("chat.usage.unknown")
                    : intl.formatNumber(value)}
              </strong>
            </article>
          );
        })}
      </div>
      <p>{t("chat.usage.reportedTurns", { known: known.length, total: turns.length })}</p>
      {known.length < turns.length && (
        <p role="status">{t("chat.usage.unknownTurns", { count: turns.length - known.length })}</p>
      )}
      {turns.map((turn: Data, index: number) => (
        <div className="utility-actions" key={turn.id}>
          <span>{t("chat.usage.turnStatus", { number: index + 1, status: turn.status })}</span>
          <span>
            {turn.usage
              ? t("chat.usage.turnTokens", {
                  input:
                    turn.usage.inputTokens == null
                      ? t("chat.usage.unknown")
                      : intl.formatNumber(turn.usage.inputTokens),
                  output:
                    turn.usage.outputTokens == null
                      ? t("chat.usage.unknown")
                      : intl.formatNumber(turn.usage.outputTokens),
                })
              : t("chat.usage.unknownUsage")}
          </span>
        </div>
      ))}
    </div>
  );
}
