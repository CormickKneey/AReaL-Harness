import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditDesignChanges, verifyStyleExceptions } from "./design-system-changes.mjs";

// 通过真实 Git 索引、提交和未跟踪文件验证增量范围，不伪造 diff 返回值。
async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), "areal-design-changes-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Design fixture");
  git("config", "user.email", "design@example.invalid");
  git("config", "commit.gpgsign", "false");
  const put = async (path, source) => {
    const target = join(repoRoot, "clients/gui/renderer/src", path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, source);
    return target;
  };
  await writeFile(join(repoRoot, ".gitignore"), "ignored/\n");
  await put("Legacy.tsx", '<button className="text-[13px] text-red-500">Old</button>');
  await put("Legacy.css", ".old { color: #fff; font-size: 13px; }");
  await put("styles.css", "");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture baseline");
  const base = git("rev-parse", "HEAD");
  const audit = (options = {}) => auditDesignChanges({ repoRoot, base, ...options });
  return { repoRoot, git, put, base, audit };
}

test("新文件不能绕过清单，未跟踪 JSX/CSS 与暂存内容均进入检查", async (t) => {
  const f = await fixture(t);
  await f.put("new folder/New.tsx", '<button className="text-[15px] bg-red-500">New</button>');
  await f.put("New.css", ".new { color: #123456; font-size: 15px; }");
  f.git("add", "clients/gui/renderer/src/New.css");
  const result = await f.audit();
  assert.equal(result.files.length, 2);
  assert.equal(result.violations.length, 6);
  assert.ok(
    result.violations.some(
      (item) => item.file.endsWith("New.tsx") && item.finding.includes("native control"),
    ),
  );
  assert.ok(
    result.violations.some(
      (item) => item.file.endsWith("New.css") && item.finding.includes("#123456"),
    ),
  );
});

test("存量不阻断内容编辑；增加同一违规次数或换一个裸值会失败", async (t) => {
  const f = await fixture(t);
  const old = '<button className="text-[13px] text-red-500">Renamed</button>';
  await f.put("Legacy.tsx", old);
  assert.deepEqual((await f.audit()).violations, []);
  await f.put("Legacy.tsx", `${old}\n<span className="text-[13px]" />`);
  assert.deepEqual(
    (await f.audit()).violations.map((item) => item.finding),
    ["literal typography class: text-[13px]"],
  );
  await f.put("Legacy.css", ".old { color: #ddd; font-size: 13px; }");
  assert.ok((await f.audit()).violations.some((item) => item.finding.includes("#ddd")));
});

test("显式基线覆盖已提交分支差异，缺失基线失败而非静默放行", async (t) => {
  const f = await fixture(t);
  await f.put("Committed.tsx", '<input style={{ color: "#abc" }} />');
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "new UI");
  assert.equal((await f.audit()).violations.length, 2);
  assert.deepEqual((await f.audit({ base: "HEAD" })).violations, []);
  await assert.rejects(f.audit({ base: "missing-base" }), /design audit base/);
});

test("工作树包含暂存后的继续修改，删除不产生新增问题", async (t) => {
  const f = await fixture(t);
  await f.put("Added.jsx", "<button>Send</button>");
  f.git("add", ".");
  await f.put("Added.jsx", '<button className="text-sm">Send</button>');
  assert.equal((await f.audit()).violations.length, 2);
  await rm(join(f.repoRoot, "clients/gui/renderer/src/Legacy.css"));
  assert.ok(!(await f.audit()).files.some((file) => file.endsWith("Legacy.css")));
});

test("Git 识别的重命名继承原文件基线，复制为新文件需遵守规则", async (t) => {
  const f = await fixture(t);
  const source = join(f.repoRoot, "clients/gui/renderer/src/Legacy.tsx");
  await rename(source, join(f.repoRoot, "clients/gui/renderer/src/Renamed.tsx"));
  f.git("add", ".");
  assert.deepEqual((await f.audit()).violations, []);
  await f.put("Copy.tsx", '<button className="text-[13px] text-red-500">Old</button>');
  assert.equal((await f.audit()).violations.length, 3);
});

test("共享语义与合法基础值放行；裸控件仅允许在公共基础控件所有者内新增", async (t) => {
  const f = await fixture(t);
  await f.put(
    "Good.tsx",
    '<Button className="text-ui-sm text-foreground" style={{ width: 280 }}>Send</Button>',
  );
  await f.put("components/ui/new-control.tsx", '<button className="text-ui-base">Send</button>');
  await f.put(
    "styles.css",
    ":root { --color-example: #123456; } .x { color: var(--color-foreground); padding: 12px; }",
  );
  assert.deepEqual((await f.audit()).violations, []);
  await f.put("components/ui/new-control.tsx", '<button className="text-red-500">Send</button>');
  assert.equal((await f.audit()).violations.length, 1);
});

test("排除开发预览与 Git 忽略文件，生产 .tsx/.jsx/.css 无需登记即纳入", async (t) => {
  const f = await fixture(t);
  await f.put("design-system/Fixture.tsx", '<button className="text-sm">Step</button>');
  await f.put("ignored/Hidden.tsx", '<button className="text-sm">Ignored</button>');
  const result = await f.audit();
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.violations, []);
});

test("新增CSS只能承载Token化布局，重命名不能隐藏外观规则", async (t) => {
  const f = await fixture(t);
  await f.put("panel.css", ".panel { display: grid; }");
  assert.ok(
    (await f.audit()).violations.some((item) =>
      item.finding.includes("new renderer CSS must use .layout.css"),
    ),
  );
  await rm(join(f.repoRoot, "clients/gui/renderer/src/panel.css"));
  await f.put("panel.layout.css", ".panel { display:grid;gap:var(--spacing-inline);width:100%; }");
  assert.deepEqual((await f.audit()).violations, []);
  await f.put("panel.layout.css", ".panel { color:var(--color-foreground);gap:6px; }");
  const invalid = await f.audit();
  assert.ok(invalid.violations.some((item) => item.finding.includes("appearance declaration")));
  assert.ok(
    invalid.violations.some((item) => item.finding.includes("layout dimension needs a token")),
  );
  await f.put("panel.layout.css", ".panel { gap:.05rem; }");
  assert.ok(
    (await f.audit()).violations.some((item) =>
      item.finding.includes("layout dimension needs a token"),
    ),
  );
  await rm(join(f.repoRoot, "clients/gui/renderer/src/panel.layout.css"));
  await rename(
    join(f.repoRoot, "clients/gui/renderer/src/Legacy.css"),
    join(f.repoRoot, "clients/gui/renderer/src/Legacy.layout.css"),
  );
  f.git("add", ".");
  assert.ok(
    (await f.audit()).violations.some((item) => item.finding.includes("appearance declaration")),
  );
});

test("域样式例外必须精确对应当前文件且包含退出条件", async (t) => {
  const f = await fixture(t);
  const root = join(f.repoRoot, "clients/gui");
  await mkdir(join(root, "design-system"));
  const path = join(root, "design-system/style-exceptions.json");
  const styles = ["Legacy.css", "styles.css"].map((file) => ({
    file: `renderer/src/${file}`,
    reason: "Existing domain surface",
    exitCondition: "Move when its real shared DOM owner exists",
    consumers: ["renderer/src/Legacy.tsx"],
  }));
  const save = (entries) => writeFile(path, JSON.stringify({ schemaVersion: 1, styles: entries }));
  await save(styles);
  assert.equal((await verifyStyleExceptions({ root })).retainedStyles, 2);
  await f.put("Unregistered.css", ".new{display:block}");
  await assert.rejects(verifyStyleExceptions({ root }), /exactly match/);
  await rm(join(root, "renderer/src/Unregistered.css"));
  await save([...styles, styles[0]]);
  await assert.rejects(verifyStyleExceptions({ root }), /duplicate/);
  await save(styles.map((item, index) => (index ? item : { ...item, exitCondition: "" })));
  await assert.rejects(verifyStyleExceptions({ root }), /exit condition/);
});
