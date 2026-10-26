import assert from "node:assert/strict";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plan = JSON.parse(
  await readFile(new URL("fixtures/design-rules-experiment/plan.json", import.meta.url), "utf8"),
);
const mode = process.argv[2];
if (mode === "--plan") {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (mode === "--snapshot") {
  const target = resolve(process.argv[3]);
  await mkdir(target, { recursive: false });
  const inventory = JSON.parse(
    await readFile(resolve(root, "clients/gui/design-system/document-inventory.json"), "utf8"),
  );
  const records = (await readdir(resolve(root, "design/archive/d5")))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ path: "design/archive/d5/" + name }));
  const manifest = [];
  for (const item of [...inventory, ...records]) {
    const bytes = await readFile(resolve(root, item.path));
    await mkdir(dirname(resolve(target, item.path)), { recursive: true });
    await writeFile(resolve(target, item.path), bytes);
    manifest.push({
      path: item.path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(resolve(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(target);
  process.exit(0);
}
assert.equal(
  mode,
  "--run",
  "Use --plan, --snapshot <new-directory>, or --run <config.json>. Each run is serial and needs a free agent slot.",
);
const config = JSON.parse(await readFile(resolve(process.argv[3]), "utf8"));
assert.match(
  config.sourceRevision,
  /^[a-f0-9]{40}$/,
  "Freeze one exact common implementation commit",
);
assert.ok(
  config.before && config.after && config.output && config.tokenizer && config.tokenizerLabel,
  "Supply both documentation snapshots, a new output directory and a named tokenizer executable",
);
assert.ok(
  Array.isArray(config.setup) && Array.isArray(config.checks),
  "Supply identical setup and checks for both groups",
);
const output = resolve(config.output);
await mkdir(output, { recursive: false });
await writeFile(resolve(output, "config.json"), JSON.stringify(config, null, 2) + "\n");
await writeFile(resolve(output, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
const documents = new Set();
for (const group of plan.groups)
  for (const item of JSON.parse(await readFile(resolve(config[group], "manifest.json"), "utf8")))
    documents.add(item.path);
const codeFiles = [];

async function run(argv, cwd, prefix, input = "", environment = {}) {
  await writeFile(
    prefix + ".command.json",
    JSON.stringify({ argv, cwd, environment, startedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGTERM"), config.timeoutMs ?? 900000);
  const result = await new Promise((done) => {
    child.on("error", (error) => done({ code: null, signal: null, error: error.message }));
    child.on("close", (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer);
  await writeFile(prefix + ".stdout", Buffer.concat(stdout));
  await writeFile(prefix + ".stderr", Buffer.concat(stderr));
  await writeFile(
    prefix + ".result.json",
    JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  return result;
}

const listing = await run(
  ["git", "ls-tree", "-r", "--name-only", "-z", config.sourceRevision],
  root,
  resolve(output, "source-files"),
);
assert.equal(listing.code, 0, "Common commit must be available in this checkout");
for (const path of (await readFile(resolve(output, "source-files.stdout"), "utf8"))
  .split("\0")
  .filter(Boolean))
  if (
    !documents.has(path) &&
    ![
      "clients/gui/design-system/rule-registry.json",
      "clients/gui/design-system/document-inventory.json",
    ].includes(path)
  )
    codeFiles.push(path);
const trials = plan.tasks
  .flatMap((task, taskIndex) =>
    Array.from({ length: plan.repeats }, (_, index) =>
      ((taskIndex + index) % 2 ? [...plan.groups].reverse() : plan.groups).map((group) => ({
        task,
        repeat: index + 1,
        group,
      })),
    ),
  )
  .flat();
async function implementationDigest(workspace) {
  const digest = createHash("sha256");
  for (const path of codeFiles)
    digest.update(path).update(await readFile(resolve(workspace, path)));
  return digest.digest("hex");
}
let sourceDigest;
let preparedSourceDigest;
for (const [index, trial] of trials.entries()) {
  const id = `${String(index + 1).padStart(2, "0")}-${trial.task.id}-${trial.repeat}-${trial.group}`;
  const evidence = resolve(output, id);
  const workspace = resolve(evidence, "workspace");
  const snapshot = JSON.parse(
    await readFile(resolve(config[trial.group], "manifest.json"), "utf8"),
  );
  await mkdir(evidence);
  const clone = await run(
    ["git", "clone", "--shared", "--no-checkout", root, workspace],
    root,
    resolve(evidence, "clone"),
  );
  assert.equal(clone.code, 0, `Clone failed for ${id}`);
  assert.equal(
    (
      await run(
        ["git", "checkout", "--detach", config.sourceRevision],
        workspace,
        resolve(evidence, "checkout"),
      )
    ).code,
    0,
  );
  for (const path of documents) await rm(resolve(workspace, path), { force: true });
  for (const item of snapshot) {
    const target = resolve(workspace, item.path);
    assert.ok(!relative(workspace, target).startsWith(".."), "Document path escapes workspace");
    await mkdir(dirname(target), { recursive: true });
    const bytes = await readFile(resolve(config[trial.group], item.path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      item.sha256,
      `Documentation snapshot changed: ${item.path}`,
    );
    await cp(resolve(config[trial.group], item.path), target);
  }
  const catalog = JSON.parse(
    await readFile(resolve(workspace, "clients/gui/design-system/registry.json"), "utf8"),
  );
  const required = new Set(
    [...catalog.patterns, ...catalog.interactionFamilies].flatMap((item) => item.rules ?? []),
  );
  const metadataPath = resolve(workspace, "clients/gui/design-system/rule-registry.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const metadataChanges = [];
  for (const rule of metadata.rules.filter((item) => required.has(item.id))) {
    const owners = [];
    for (const item of snapshot) {
      if (item.path.includes("/archive/") || !item.path.startsWith("clients/gui/")) continue;
      const text = await readFile(resolve(workspace, item.path), "utf8");
      if (text.includes("`" + rule.id + "`：")) owners.push(item.path);
    }
    assert.equal(
      owners.length,
      1,
      `Expected one original definition of ${rule.id} in ${trial.group}`,
    );
    const owner = owners[0] + "#" + rule.owner.split("#")[1];
    metadataChanges.push({ id: rule.id, previousOwner: rule.owner, owner });
    rule.owner = owner;
  }
  if (trial.group === "before")
    metadata.rules = metadata.rules.filter((rule) => required.has(rule.id));
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
  const inventoryPath = resolve(workspace, "clients/gui/design-system/document-inventory.json");
  if (trial.group === "before") {
    const inventory = JSON.parse(
      await readFile(resolve(config.before, "manifest.json"), "utf8"),
    ).map(({ path }) => ({
      path,
      role: path.includes("/archive/")
        ? "process-evidence"
        : path.startsWith("design/")
          ? "cross-product"
          : path.includes("/design-system/")
            ? "maintainer"
            : "consumer",
      status: path.includes("/archive/")
        ? "archived"
        : path.includes("/src/generated/")
          ? "generated"
          : "active",
      ...(path.endsWith(".en.md") ? { translationOf: path.replace(".en.md", ".md") } : {}),
    }));
    await writeFile(inventoryPath, JSON.stringify(inventory, null, 2) + "\n");
  }
  await writeFile(
    resolve(evidence, "documentation-metadata.json"),
    JSON.stringify(
      {
        changes: metadataChanges,
        ruleRegistrySha256: createHash("sha256")
          .update(await readFile(metadataPath))
          .digest("hex"),
        inventorySha256: createHash("sha256")
          .update(await readFile(inventoryPath))
          .digest("hex"),
        beforeRegistryScope:
          trial.group === "before"
            ? "legacy catalog rules and before-snapshot document paths only; D5 baseline failures remain visible"
            : null,
      },
      null,
      2,
    ) + "\n",
  );
  const codeDigest = await implementationDigest(workspace);
  sourceDigest ??= codeDigest;
  assert.equal(codeDigest, sourceDigest, "Groups have different implementation source");
  const environment = {
    AREAL_GUI_TEST_ROOT: resolve(evidence, "gui-test"),
    AREAL_HOME: resolve(evidence, "areal-home"),
    AREAL_DESIGN_READ_LOG: resolve(workspace, ".d5-document-reads.jsonl"),
    AREAL_DESIGN_TOKENIZER: resolve(config.tokenizer),
    AREAL_DESIGN_TOKENIZER_LABEL: config.tokenizerLabel,
  };
  const setup = [];
  for (const [step, argv] of config.setup.entries())
    setup.push(
      await run(
        argv,
        resolve(workspace, "clients/gui"),
        resolve(evidence, `setup-${step}`),
        "",
        environment,
      ),
    );
  if (setup.some((item) => item.code !== 0)) {
    const result = {
      id,
      task: trial.task.id,
      repeat: trial.repeat,
      group: trial.group,
      sourceRevision: config.sourceRevision,
      codeDigest,
      status: "setup-failed",
      setup,
    };
    await writeFile(resolve(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
    await appendFile(resolve(output, "results.jsonl"), JSON.stringify(result) + "\n");
    continue;
  }
  for (const path of documents)
    if (!snapshot.some((item) => item.path === path))
      await rm(resolve(workspace, path), { force: true });
  const preparedCodeDigest = await implementationDigest(workspace);
  preparedSourceDigest ??= preparedCodeDigest;
  assert.equal(
    preparedCodeDigest,
    preparedSourceDigest,
    "Setup produced different implementation source between documentation groups",
  );
  const baseline = [];
  for (const [step, argv] of config.checks.entries())
    baseline.push(
      await run(
        argv,
        resolve(workspace, "clients/gui"),
        resolve(evidence, `before-${step}`),
        "",
        environment,
      ),
    );
  await run(["git", "diff", "--binary"], workspace, resolve(evidence, "documentation-baseline"));
  const prompt = `You are one fresh-context trial in a controlled documentation comparison. Do not spawn agents, browse, send messages, use service credentials, commit, or change design rules. Make only the requested preview change in this isolated workspace. Read every design Markdown document through node clients/gui/scripts/design-rules-read.mjs <repository-relative path>; do not use other tools to read design Markdown. Ordinary source reads are unrestricted. Start from clients/gui/packages/ui/README.md. Do not read the other trial group or prior trial results. Task: ${trial.task.request}\nAcceptance:\n${trial.task.acceptance.map((text) => "- " + text).join("\n")}\nFinish with changed files and any unresolved acceptance. The controller runs validation after you finish.\n`;
  await writeFile(resolve(evidence, "prompt.txt"), prompt);
  const argv = [
    config.codex ?? "codex",
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--cd",
    workspace,
    "--model",
    config.model ?? plan.fixedModel,
    "-c",
    `model_reasoning_effort="${config.reasoningEffort ?? plan.fixedReasoningEffort}"`,
    "-",
  ];
  const agent = await run(argv, workspace, resolve(evidence, "agent"), prompt, environment);
  const after = [];
  for (const [step, command] of config.checks.entries())
    after.push(
      await run(
        command,
        resolve(workspace, "clients/gui"),
        resolve(evidence, `after-${step}`),
        "",
        environment,
      ),
    );
  await run(["git", "diff", "--binary"], workspace, resolve(evidence, "final-patch"));
  await run(["git", "status", "--porcelain"], workspace, resolve(evidence, "final-status"));
  const readLog = await readFile(environment.AREAL_DESIGN_READ_LOG, "utf8").catch(() => "");
  await writeFile(resolve(evidence, "document-reads.jsonl"), readLog);
  const reads = readLog
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  await run(
    ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    workspace,
    resolve(evidence, "untracked-files"),
  );
  for (const path of (await readFile(resolve(evidence, "untracked-files.stdout"), "utf8"))
    .split("\0")
    .filter(Boolean)) {
    if (path === ".d5-document-reads.jsonl") continue;
    const target = resolve(evidence, "new-files", path);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(workspace, path), target);
  }
  const result = {
    id,
    task: trial.task.id,
    repeat: trial.repeat,
    group: trial.group,
    sourceRevision: config.sourceRevision,
    codeDigest,
    preparedCodeDigest,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    agent,
    baseline,
    after,
    newlyFailingChecks: after.flatMap((item, step) =>
      item.code !== 0 && baseline[step].code === 0 ? [step] : [],
    ),
    readDocuments: [...new Set(reads.map((item) => item.path))],
    documentReadCount: reads.length,
    designDocumentTokens:
      reads.length && reads.every((item) => item.tokens !== null)
        ? reads.reduce((total, item) => total + item.tokens, 0)
        : null,
    tokenizer: config.tokenizerLabel,
    independentReview: { status: "pending", violations: null, protocolDeviations: null },
    status: "awaiting-independent-review",
  };
  await writeFile(resolve(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await appendFile(resolve(output, "results.jsonl"), JSON.stringify(result) + "\n");
  console.log(id + " awaiting independent review");
}
