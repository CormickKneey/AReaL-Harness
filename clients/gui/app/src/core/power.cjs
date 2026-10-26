// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");

// The shared Electron service owns this OS resource, independently of GUI
// windows. Read Core's public status; never infer running work from future
// schedules (activeTasks includes them), persistent terminals or GUI visibility.
class SharedPowerMonitor {
  /** @param {InstanceType<typeof import("./backend.cjs").CoreBackend>} backend @param {typeof import("electron").powerSaveBlocker} powerSaveBlocker */
  constructor(backend, powerSaveBlocker) {
    this.backend = backend;
    this.native = powerSaveBlocker;
    /** @type {number|null} */ this.id = null;
    /** @type {Promise<void>|null} */ this.pending = null;
    /** @type {NodeJS.Timeout|undefined} */ this.timer = undefined;
    this.stopped = false;
  }
  start() {
    this.timer = setInterval(() => {
      void this.refresh();
    }, 2000);
    void this.refresh();
  }
  refresh() {
    if (this.stopped) return Promise.resolve();
    // A saved opt-out must release even while an earlier status read is pending.
    if (this.backend.library.value.settings.preventSleep === false) this.apply(false, null);
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async read() {
    let running = false,
      unknown = false;
    if (this.backend.library.value.settings.preventSleep !== false) {
      for (const project of this.backend.projects.values()) {
        if (this.stopped || Object.is(this.backend.library.value.settings.preventSleep, false))
          break;
        if (!project.client?.ready) {
          if (project.service) unknown = true;
          continue;
        }
        try {
          const status = await project.client.request(
            "areal/server/status",
            {},
            { timeoutMs: 5000, decode: runningStatus },
          );
          running ||= status;
        } catch {
          unknown = true;
        }
      }
    }
    if (!this.stopped)
      this.apply(
        running || unknown,
        unknown ? "部分任务状态暂不可用，暂时保留休眠保护；可关闭此选项。" : null,
      );
  }
  /** @param {boolean} wanted @param {string|null} error */
  apply(wanted, error) {
    const enabled = this.backend.library.value.settings.preventSleep !== false;
    if (!enabled) error = null;
    try {
      if (!this.stopped && enabled && wanted) {
        if (this.id === null) this.id = this.native.start("prevent-app-suspension");
      } else if (this.id !== null) {
        this.native.stop(this.id);
        this.id = null;
      }
    } catch {
      error = "系统休眠保护未能更新，请检查系统状态后重试。";
    }
    const state = { enabled, active: this.id !== null && this.native.isStarted(this.id), error };
    if (JSON.stringify(state) !== JSON.stringify(this.backend.power)) {
      this.backend.power = state;
      // Avoid reentering refresh before its in-flight promise is installed.
      queueMicrotask(() => {
        if (!this.stopped) this.backend.onChange();
      });
    }
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.apply(false, null);
  }
}
/** @param {unknown} value */
function runningStatus(value) {
  if (
    !modelRecord(value) ||
    !Array.isArray(value.activeTurns) ||
    !Array.isArray(value.activeGoals) ||
    !Array.isArray(value.compactions) ||
    !Array.isArray(value.workgroups) ||
    value.workgroups.some((group) => !modelRecord(group) || typeof group.status !== "string")
  )
    throw new Error("Core 工作状态无效");
  return (
    value.activeTurns.length > 0 ||
    value.activeGoals.length > 0 ||
    value.compactions.length > 0 ||
    value.workgroups.some((group) => group.status === "running")
  );
}
module.exports = { SharedPowerMonitor };
