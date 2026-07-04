import { describe, it, expect, vi } from "vitest";
import { up, down, composeProject } from "./compose-lifecycle.js";

const okRun = () => vi.fn(async () => ({ stdout: "", stderr: "" }));

describe("compose-lifecycle", () => {
  it("up() builds/starts the stack then returns baseUrl once the healthcheck answers 2xx", async () => {
    const run = okRun();
    // Not healthy on the first probe, healthy on the second — proves it polls.
    const probe = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(200);

    const handle = await up({
      worktreePath: "/wt",
      executionId: "exec1",
      baseUrl: "http://127.0.0.1:4000",
      run,
      probe,
      intervalMs: 1,
    });

    expect(handle.baseUrl).toBe("http://127.0.0.1:4000");
    expect(handle.project).toBe("or-exec1");
    expect(run).toHaveBeenCalledWith(
      ["compose", "-f", "docs/openroutines/compose.openroutines.yml", "-p", "or-exec1", "up", "-d", "--build"],
      "/wt"
    );
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenLastCalledWith("http://127.0.0.1:4000/");
  });

  it("up() throws on health timeout — but only AFTER the containers were started (so the caller's finally can tear them down)", async () => {
    const run = okRun();
    const probe = vi.fn(async () => 0); // never healthy

    await expect(
      up({ worktreePath: "/wt", executionId: "e", run, probe, timeoutMs: 0, intervalMs: 1 })
    ).rejects.toThrow(/did not become healthy/);
    // The stack was started; down() is the caller's job.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("up");
  });

  it("down() runs `down -v` against the same per-execution project", async () => {
    const run = okRun();
    await down({ worktreePath: "/wt", executionId: "exec1", run });
    expect(run).toHaveBeenCalledWith(
      ["compose", "-f", "docs/openroutines/compose.openroutines.yml", "-p", "or-exec1", "down", "-v"],
      "/wt"
    );
  });

  it("composeProject sanitizes to a valid docker compose project name", () => {
    expect(composeProject("Exec/AB.1")).toBe("or-exec-ab-1");
  });
});
