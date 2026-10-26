import type { Snapshot } from "../services.js";

export function projectExecutionBlocked(
  lifecycle: Snapshot["lifecycle"],
  projectId: string,
): boolean {
  return (
    lifecycle?.operations.some(
      (operation) =>
        operation.phase !== "completed" &&
        operation.phase !== "blocked" &&
        operation.targets.some(
          (target) =>
            target.projectId === projectId &&
            target.phase !== "completed" &&
            target.phase !== "blocked",
        ),
    ) ?? false
  );
}
