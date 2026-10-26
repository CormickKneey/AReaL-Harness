import { describe, expect, it } from "vite-plus/test";
import type { Data } from "./services.js";
import {
  activityRunLabel,
  activityRuns,
  statusTarget,
  toolPresentation,
} from "./conversationPresentation.js";

describe("statusTarget", () => {
  it("keeps a one-line command as is, with collapsed whitespace", () => {
    expect(statusTarget("pnpm   --dir clients/gui\ttypecheck")).toBe(
      "pnpm --dir clients/gui typecheck",
    );
  });

  it("stops a heredoc at its opening marker", () => {
    const command = "python3 - <<'PY'\nimport pathlib,json\nprint('INDEX')\nPY";
    expect(statusTarget(command)).toBe("python3 - <<'PY'");
    expect(statusTarget('cat <<-"EOF" > out.txt\nbody\nEOF')).toBe('cat <<-"EOF"');
    expect(statusTarget("bash <<EOS\necho hi\nEOS")).toBe("bash <<EOS");
  });

  it("marks a multi-line command that is not a heredoc as truncated", () => {
    expect(statusTarget("\n\ncd app &&\n  pnpm test\n")).toBe("cd app && …");
  });

  it("returns undefined for empty targets", () => {
    expect(statusTarget(undefined)).toBeUndefined();
    expect(statusTarget("  \n ")).toBeUndefined();
  });
});

const tool = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "dynamicToolCall",
  tool: name,
  status: "completed",
  success: true,
  arguments: {},
  contentItems: [],
  ...extra,
});
const read = (id: string, status = "completed") =>
  tool(id, "fs_read", {
    status,
    success: status === "completed" ? true : undefined,
    arguments: { path: `${id}.ts` },
  });

describe("activityRunLabel stage boundary", () => {
  it("stays in progress between calls while the segment is still open", () => {
    const run = { key: "探索", items: [read("a"), read("b")] };
    expect(activityRunLabel(run, true)).toBe("正在探索 · 2 个文件");
  });
  it("completes once later visible content closes the segment", () => {
    const run = { key: "探索", items: [read("a"), read("b")] };
    expect(activityRunLabel(run, false)).toBe("已探索 · 2 个文件");
  });
  it("still reports a running child even when not the open segment", () => {
    const run = { key: "探索", items: [read("a"), read("b", "inProgress")] };
    expect(activityRunLabel(run, false)).toBe("正在探索 · 1 个文件");
  });
});

describe("activityRuns stages", () => {
  const shape = (runs: { key: string | null; items: Data[] }[]) =>
    runs.map((run) => [run.key, run.items.map((item) => item.id)]);
  it("merges reads, searches, listings and skill reads into one exploration", () => {
    const rows = [
      read("r1"),
      tool("s1", "search_files", { arguments: { pattern: "login" } }),
      tool("l1", "fs_list", { arguments: { path: "." } }),
      tool("k1", "skill_read", { arguments: { skill: { id: "review", revision: "1" } } }),
      tool("c1", "run_command", { arguments: { command: "ls" } }),
      tool("e1", "fs_write", { arguments: { path: "a.ts" } }),
    ];
    expect(shape(activityRuns(rows))).toEqual([
      ["探索", ["r1", "s1", "l1", "k1"]],
      ["运行命令", ["c1"]],
      ["修改文件", ["e1"]],
    ]);
  });
  it("keeps unknown tools merged only by the same name", () => {
    const rows = [
      tool("x1", "lookup_ticket"),
      tool("x2", "lookup_ticket"),
      tool("y1", "post_comment"),
    ];
    expect(shape(activityRuns(rows))).toEqual([
      ["调用 lookup_ticket", ["x1", "x2"]],
      ["调用 post_comment", ["y1"]],
    ]);
  });
});

describe("activityRunLabel counts", () => {
  it("counts completed exploration by type", () => {
    const run = {
      key: "探索",
      items: [
        read("a"),
        read("b"),
        tool("s", "search_files", { arguments: { query: "x" } }),
        tool("l", "fs_list"),
      ],
    };
    expect(activityRunLabel(run)).toBe("已探索 · 2 个文件，1 次搜索，1 个目录");
  });
  it("counts commands and states failures in the same title", () => {
    const failed = tool("c3", "run_command", { success: false, execution: { exitCode: 1 } });
    const run = {
      key: "运行命令",
      items: [tool("c1", "run_command"), tool("c2", "run_command"), failed],
    };
    expect(activityRunLabel(run)).toBe("已运行 2 条命令 · 1 个失败");
  });
  it("counts distinct edited files", () => {
    const edit = (id: string, path: string) => tool(id, "fs_write", { arguments: { path } });
    const run = {
      key: "修改文件",
      items: [edit("e1", "a.ts"), edit("e2", "a.ts"), edit("e3", "b.ts")],
    };
    expect(activityRunLabel(run)).toBe("已修改 2 个文件");
  });
  it("omits counts when nothing has completed", () => {
    const run = {
      key: "运行命令",
      items: [tool("c1", "run_command", { status: "inProgress", success: undefined })],
    };
    expect(activityRunLabel(run)).toBe("正在运行命令");
  });
});

describe("toolPresentation targets", () => {
  it("never falls back to the internal tool name", () => {
    expect(toolPresentation(tool("l", "fs_list")).detail).toBe("");
    expect(toolPresentation(tool("l", "fs_list")).label).toBe("列出目录");
    expect(toolPresentation(tool("p", "plan_read")).detail).toBe("");
    expect(toolPresentation(tool("x", "lookup_ticket")).detail).toBe("");
  });
  it("names the skill a skill read opened", () => {
    const skill = tool("k", "skill_read", {
      arguments: { skill: { id: "review", revision: "3" }, resource: "SKILL.md" },
    });
    expect(toolPresentation(skill).detail).toBe("review · SKILL.md");
  });
  it("exposes the exit code of a failed command", () => {
    const failed = tool("c", "run_command", { success: false, execution: { exitCode: 2 } });
    expect(toolPresentation(failed)).toMatchObject({ failed: true, exitCode: 2 });
  });
});
