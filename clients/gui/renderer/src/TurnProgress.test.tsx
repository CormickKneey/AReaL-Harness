import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TurnProgress } from "./TurnProgress.js";

vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({
    t: (id: string, values?: { label?: string }) => values?.label ?? id,
  }),
}));

describe("TurnProgress heading", () => {
  it.each(["completed", "failed", "inProgress"])(
    "keeps only Working duration and disclosure for %s",
    (status) => {
      const facts = { failures: 2, unfinished: true };
      const markup = renderToStaticMarkup(
        createElement(TurnProgress, {
          ...facts,
          settled: status === "completed",
          summaryAvailable: true,
          connected: true,
          turn: {
            id: "turn",
            status,
            durationMs: 929000,
            startedAt: Math.floor(Date.now() / 1000) - 929,
          },
          children: "Activity content",
        }),
      );
      expect(markup).toContain("Working for 15m 29s");
      expect(markup).toContain("aria-expanded=");
      expect(markup).toContain("aria-controls=");
      expect(markup).not.toContain("turn-failure-indicator");
      expect(markup).not.toContain("circle-alert");
      expect(markup).not.toContain("chat.progress.unconfirmed");
    },
  );

  it("omits task status from continuation headings too", () => {
    const facts = { failures: 1, unfinished: true };
    const markup = renderToStaticMarkup(
      createElement(TurnProgress, {
        ...facts,
        settled: false,
        summaryAvailable: true,
        label: "Working",
        children: "Activity content",
      }),
    );
    expect(markup).toContain("Working");
    expect(markup).not.toContain("chat.progress.unconfirmed");
    expect(markup).not.toContain("turn-failure-indicator");
  });
});
