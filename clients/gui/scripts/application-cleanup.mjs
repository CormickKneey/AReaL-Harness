import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

export async function assertApplicationStopped(binary, env, metadata) {
  const alive = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const deadline = Date.now() + 30000;
  let records;
  do {
    records = JSON.parse(execFileSync(binary, ["service", "list", "--json"], { env, encoding: "utf8", timeout: 20000 }));
    if (!alive(metadata?.pid) && records.every(record => record.state === "stopped"
      && !alive(record.hostPid) && !alive(record.corePid))) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail("Application quit left a live isolated adapter or Core generation");
}

// A failed quit must not leave the test runner held open until the CI job timeout.
// Only the exact child returned by this fixture's Electron launch may be killed.
export async function closeSmokeApplication(application, timeoutMs = 20000) {
  try {
    await withSmokeDeadline("Electron cleanup", () => application.close(), timeoutMs);
  } catch (error) {
    const child = application.process();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await withSmokeDeadline("owned Electron process exit", () => exited, 5000);
    }
    throw error;
  }
}
