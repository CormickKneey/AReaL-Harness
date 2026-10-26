import assert from "node:assert/strict";
import { arch, cpus, platform, release, totalmem, loadavg } from "node:os";

export async function startupResources(application, page) {
  const main = await application.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid,
    rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
    memory: process.memoryUsage(),
    versions: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    },
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      memory: metric.memory,
      cpu: metric.cpu,
    })),
  }));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Performance.enable");
    const metrics = (await session.send("Performance.getMetrics")).metrics;
    const heap = Object.fromEntries(
      metrics
        .filter((metric) => ["JSHeapUsedSize", "JSHeapTotalSize"].includes(metric.name))
        .map((metric) => [metric.name, metric.value]),
    );
    assert.ok(
      heap.JSHeapUsedSize > 0 && heap.JSHeapTotalSize >= heap.JSHeapUsedSize,
      "Renderer must report actual heap bytes",
    );
    assert.ok(
      main.memory.rss > 0 && main.processes.length > 0,
      "Main and Electron process measurements must exist",
    );
    return {
      measuredAt: new Date().toISOString(),
      main,
      renderer: {
        pid: main.rendererPid,
        heapUsedBytes: heap.JSHeapUsedSize,
        heapTotalBytes: heap.JSHeapTotalSize,
      },
      units: {
        main: "bytes",
        renderer: "bytes",
        electronProcessMemory:
          "KiB as returned by Electron; shared working sets must not be summed as unique RSS",
      },
    };
  } finally {
    await session.send("Performance.disable");
    await session.detach();
  }
}

export function startupEnvironment() {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    loadAverage: loadavg(),
  };
}

export function summarizeStartup(samples) {
  const percentile = (values, fraction) => {
    assert.ok(
      values.length > 0 && values.every(Number.isFinite),
      "Startup samples must be finite actual measurements",
    );
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  };
  return [...new Set(samples.map((sample) => sample.label))].map((label) => {
    const group = samples.filter((sample) => sample.label === label);
    return {
      label,
      rounds: group.length,
      metrics: Object.fromEntries(
        [
          ["readyMs", group.map((sample) => sample.durationMs)],
          ["visibleMs", group.map((sample) => sample.visibleMs)],
          ["mainRssBytes", group.map((sample) => sample.resources.main.memory.rss)],
          ["mainHeapUsedBytes", group.map((sample) => sample.resources.main.memory.heapUsed)],
          ["rendererHeapUsedBytes", group.map((sample) => sample.resources.renderer.heapUsedBytes)],
        ].map(([name, values]) => [
          name,
          {
            p50: percentile(values, 0.5),
            p90: percentile(values, 0.9),
            min: Math.min(...values),
            max: Math.max(...values),
          },
        ]),
      ),
    };
  });
}
