import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const scheduleScale = {
  projects: Number(process.env.AREAL_SCHEDULE_PROJECTS || 5),
  tasks: Number(process.env.AREAL_SCHEDULE_TASKS || 10),
  scheduled: Number(process.env.AREAL_SCHEDULE_SCHEDULED || 10),
  histories: [0, 16, 128],
};
assert.ok(
  Number.isSafeInteger(scheduleScale.projects) &&
    Number.isSafeInteger(scheduleScale.tasks) &&
    Number.isSafeInteger(scheduleScale.scheduled) &&
    scheduleScale.projects >= 1 &&
    scheduleScale.scheduled >= 1 &&
    scheduleScale.tasks >= scheduleScale.scheduled &&
    scheduleScale.tasks <= 1024,
);
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function expandScheduleFixture(home, owners) {
  const manifests = [];
  for (const [index, owner] of owners.entries()) {
    const directory = join(home, owner.projectId, "state", "desktop");
    const path = join(directory, "task-mode.json");
    const root = JSON.parse(await readFile(path, "utf8"));
    assert.ok(
      root.version === 5 || root.version === 6,
      "scale fixture derives from a stopped current immutable ledger",
    );
    const original = Object.values(root.tasks)[0];
    const template = JSON.parse(
      await readFile(join(directory, "task-ledger", original.body), "utf8"),
    );
    assert.equal(template.paused, true, "performance fixture has no enabled startup work");
    assert.equal(template.mode, "scheduled");
    const history = scheduleScale.histories[index % scheduleScale.histories.length];
    const entries = await Promise.all(
      Array.from({ length: scheduleScale.tasks }, async (_, taskIndex) => {
        const scheduled = taskIndex < scheduleScale.scheduled;
        const id = taskIndex === 0 ? template.id : randomUUID();
        const runs = scheduled
          ? Array.from({ length: history }, (_, runIndex) => ({
              id: randomUUID(),
              threadId: null,
              goalId: null,
              trigger: "schedule",
              startedAt: 1000 + runIndex,
              workers: [],
              status: "completed",
              reason: null,
              scheduledAt: 1000 + runIndex,
              completedAt: 1001 + runIndex,
              waitRequested: false,
              usage: {
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: 0,
                tokensUsed: 0,
                reservedTokens: 0,
                unknownRequests: 0,
                timeUsedSeconds: 0,
                turnsStarted: 0,
                accountingComplete: true,
              },
            }))
          : [];
        const task = {
          ...template,
          id,
          objective: `${scheduled ? "SCHEDULE" : "ORDINARY"}_${String(index).padStart(2, "0")}_${String(taskIndex).padStart(3, "0")}`,
          mode: scheduled ? "scheduled" : "background",
          runs,
          runCount: runs.length,
          archivedRunCount: 0,
          runsComplete: true,
          messages: [],
          channelSequence: 0,
          schedule: scheduled ? template.schedule : null,
          nextRunAt: scheduled ? template.nextRunAt : null,
        };
        if (!scheduled) delete task.scheduleV2;
        const bytes = Buffer.from(JSON.stringify(task));
        const body = digest(bytes);
        await writeFile(join(directory, "task-ledger", body), bytes);
        return [
          digest(id),
          {
            ...original,
            body,
            hot_bytes: bytes.length,
            history: null,
            history_segments: 0,
            archived_count: 0,
            settlement_limit: Math.max(original.settlement_limit, bytes.length),
          },
        ];
      }),
    );
    root.tasks = Object.fromEntries(entries);
    root.version = 5;
    delete root.schedules;
    await writeFile(path, JSON.stringify(root));
    manifests.push({
      ...owner,
      history,
      tasks: entries.length,
      scheduled: scheduleScale.scheduled,
      rootDigest: digest(await readFile(path)),
      leafDigests: entries.map(([, head]) => head.body),
    });
  }
  return manifests;
}

export async function saveScheduleEvidence(directory, name, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name + ".json"), JSON.stringify(value, null, 2));
}

export function sampleSummary(samples) {
  if (!samples.length) return { count: 0 };
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
    ...(sorted.length < 20 ? { caveat: "Small-sample p95 is the maximum for five samples." } : {}),
  };
}
