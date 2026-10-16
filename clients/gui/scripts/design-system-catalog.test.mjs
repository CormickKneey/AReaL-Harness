import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDesignCatalog } from "./design-system-catalog.mjs";

const gui = fileURLToPath(new URL("../", import.meta.url));
// 只复制目录检查所需文件；变异和生成均在临时目录，不写入产品工作树。
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "areal-design-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(gui, "design-system"), join(root, "design-system"), { recursive: true });
  const registry = JSON.parse(await readFile(join(root, "design-system/registry.json"), "utf8"));
  const sources = [...registry.tokenSources, ...registry.components.map(item => item.source), ...registry.patterns.map(item => item.reference), "renderer/src/design-system/catalog.ts"];
  for (const name of await readdir(join(root, "design-system/surfaces"))) {
    const item = JSON.parse(await readFile(join(root, "design-system/surfaces", name), "utf8"));
    sources.push(item.target);
    if (item.reference.kind === "existing-code") sources.push(item.reference.path);
  }
  for (const source of new Set(sources)) {
    await mkdir(dirname(join(root, source)), { recursive: true });
    await cp(join(gui, source), join(root, source));
  }
  const pattern = registry.patterns.find(item => item.id === "P-CONVERSATION");
  pattern.ruleSource = "design-system/patterns.md";
  pattern.rules = ["CONV-READ-01"];
  pattern.states = ["ready", "busy", "failed", "unknown", "reading-history"];
  const surface = {
    schemaVersion: 1, id: "conversation-contract-check", intent: "检查对话规则引用，不验收UI",
    pattern: "P-CONVERSATION", target: "renderer/src/design-system/ConversationTimelinePreview.tsx", runtime: "component-preview",
    reference: { kind: "existing-code", path: "renderer/src/Messages.tsx", visualTarget: null },
    rules: ["CONV-READ-01"],
    slots: { timeline: ["Messages", "TurnExecution", "ToolEvent"], composer: ["ConversationComposer"], context: ["ToolEvent"] },
    states: ["ready", "busy", "failed", "unknown", "reading-history"].map(id => ({ id, condition: "固定输入", expected: "按规则核对" })),
    conditions: { themes: ["dark"], fontSizes: [14], widthModes: ["wide"], reducedMotion: [true] },
    invariants: ["目录检查不证明运行行为"], evidence: { status: "pending", artifacts: [], gaps: ["未运行组件"] },
  };
  // 避免已有同模式页面因测试替换必需规则产生无关失败。
  for (const name of await readdir(join(root, "design-system/surfaces"))) {
    const p = join(root, "design-system/surfaces", name);
    if (JSON.parse(await readFile(p, "utf8")).pattern === "P-CONVERSATION") await rm(p);
  }
  const save = async () => {
    await writeFile(join(root, "design-system/registry.json"), JSON.stringify(registry));
    await writeFile(join(root, "design-system/surfaces/conversation-contract-check.json"), JSON.stringify(surface));
  };
  return { root, registry, pattern, surface, save };
}

test("规则引用合法且旧设置合同无需补字段", async t => {
  const f = await fixture(t); await f.save();
  const result = await verifyDesignCatalog({ root: f.root, write: true });
  assert.ok(result.surfaces >= 4);
});
test("对话合同不能遗漏模式要求的规则", async t => {
  const f = await fixture(t); delete f.surface.rules; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /rules/);
});
test("对话合同不能发明规则ID", async t => {
  const f = await fixture(t); f.surface.rules.push("CONV-INVENTED-01"); await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /unknown rule CONV-INVENTED-01/);
});
test("目录规则必须指向唯一定义", async t => {
  const f = await fixture(t); f.pattern.rules = ["CONV-MISSING-01"]; f.surface.rules = ["CONV-MISSING-01"]; await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /CONV-MISSING-01.*definition/);
});
test("动态题不能遗漏历史阅读检查点", async t => {
  const f = await fixture(t); f.surface.states = f.surface.states.filter(item => item.id !== "reading-history"); await f.save();
  await assert.rejects(verifyDesignCatalog({ root: f.root, write: true }), /missing required state reading-history/);
});
