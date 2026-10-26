import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TurnExecution } from "./TurnExecution.js";

vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));

const project = { state: { connected: true, threads: { thread: { executionConnected: true } } } };
const read = (id: string) => ({
  id,
  type: "dynamicToolCall",
  tool: "fs_read",
  status: "completed",
  success: true,
  arguments: { path: `${id}.ts` },
  contentItems: [],
});
const render = (live: boolean) =>
  renderToStaticMarkup(
    createElement(TurnExecution, {
      items: [read("a"), read("b")],
      live,
      turn: { id: "turn", status: "inProgress" },
      project,
      threadId: "thread",
      renderItem: (item) => createElement("span", null, item.id),
    }),
  );

describe("TurnExecution stage boundary", () => {
  it("keeps the open segment in progress while the model thinks between calls", () => {
    expect(render(true)).toContain("正在探索 · 2 个文件");
  });
  it("settles the segment once later visible content closed it", () => {
    expect(render(false)).toContain("已探索 · 2 个文件");
  });
});

describe("TurnExecution failures", () => {
  it("keeps a failed step in place instead of hiding it", () => {
    const failed = {
      id: "f",
      type: "dynamicToolCall",
      tool: "run_command",
      status: "completed",
      success: false,
      execution: { exitCode: 1 },
      arguments: { command: "pnpm test" },
      contentItems: [],
    };
    const markup = renderToStaticMarkup(
      createElement(TurnExecution, {
        items: [failed],
        turn: { id: "turn", status: "completed" },
        project,
        threadId: "thread",
        renderItem: (item) => createElement("span", null, `row:${item.id}`),
      }),
    );
    expect(markup).toContain("row:f");
  });
});
