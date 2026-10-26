// @ts-check
"use strict";

// Startup activation has its own cause. Catalog consumers never call it.
class ScheduledOwnerActivation {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    this.stopped = false;
    /** @type {Promise<void>|null} */
    this.pending = null;
    /** @type {Map<string,string>} */
    this.errors = new Map();
  }
  /** @param {import('./project-index.cjs').SavedProject} owner */
  guard(owner) {
    if (this.stopped || this.backend.closing) throw new Error("应用正在退出");
    const saved = this.backend.saved.find(
      (saved) =>
        saved.id === owner.id &&
        saved.root === owner.root &&
        saved.logicalProjectId === owner.logicalProjectId,
    );
    if (!saved) throw new Error("安排执行工作区已移除");
    if (this.backend.lifecycleOperations.schedulingSuppressed(owner.id))
      throw new Error("安排执行工作区已由用户停止");
    this.backend.lifecycleOperations.assertProject(owner.id);
    this.backend.worktrees.assertAvailable(owner.id);
  }
  start() {
    if (this.pending) return this.pending;
    const queue = [...this.backend.saved];
    this.pending = Promise.all(
      Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (!this.stopped && !this.backend.closing && queue.length) {
          const owner = queue.shift();
          if (!owner) return;
          try {
            this.guard(owner);
            const catalog = await this.backend.ownerTasks.preview(owner, true);
            this.guard(owner);
            if (!catalog.data.some((task) => task.enabled)) continue;
            await this.backend.start(owner.id);
            this.guard(owner);
            this.errors.delete(owner.id);
          } catch (error) {
            if (!this.stopped && !this.backend.closing)
              this.errors.set(
                owner.id,
                this.backend.providers.redact(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }
        }
      }),
    )
      .then(() => {})
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  stop() {
    this.stopped = true;
  }
}
module.exports = { ScheduledOwnerActivation };
