import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { cleanupZombieProcesses, isProcessAlive } from "./process-cleanup.js";
import type { ExecutionProcess, ExecutionProcessRepository } from "../persistence/types.js";

/** Spawn and let a real process exit so its pid is guaranteed not alive. */
const getDeadPid = (): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn("true", []);
    const pid = child.pid!;
    child.on("close", () => resolve(pid));
  });

const makeFakeRepo = (rows: ExecutionProcess[]): ExecutionProcessRepository & { finishedIds: string[] } => {
  const finishedIds: string[] = [];
  return {
    save: async () => {},
    markFinished: async (id: string) => {
      finishedIds.push(id);
    },
    findRunning: async () => rows,
    finishedIds,
  };
};

describe("cleanupZombieProcesses", () => {
  it("marks a row with a dead pid as finished, without throwing", async () => {
    const deadPid = await getDeadPid();
    expect(isProcessAlive(deadPid)).toBe(false);

    const repo = makeFakeRepo([{ id: "proc-1", executionId: "exec-1", pid: deadPid }]);

    const result = await cleanupZombieProcesses(repo);

    expect(result).toEqual({ checked: 1, killed: 0, cleaned: 1 });
    expect(repo.finishedIds).toEqual(["proc-1"]);
  });

  it("kills a real running process and marks it finished", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid!;
    expect(isProcessAlive(pid)).toBe(true);

    const repo = makeFakeRepo([{ id: "proc-2", executionId: "exec-1", pid }]);

    const result = await cleanupZombieProcesses(repo);

    expect(result).toEqual({ checked: 1, killed: 1, cleaned: 1 });
    expect(repo.finishedIds).toEqual(["proc-2"]);

    // SIGKILL delivery is scheduled by the OS, not synchronous from JS — give
    // it a beat before asserting the pid is gone (mirrors claude-cli.test.ts).
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
