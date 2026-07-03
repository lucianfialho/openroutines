import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runVerifyCommands, splitCommand } from "./run-commands.js";

describe("splitCommand", () => {
  it("splits plain whitespace-separated commands into argv", () => {
    expect(splitCommand("npm run build")).toEqual(["npm", "run", "build"]);
    expect(splitCommand("npx tsc --noEmit")).toEqual(["npx", "tsc", "--noEmit"]);
  });

  it("keeps a double-quoted span as a single token", () => {
    expect(splitCommand('echo "sem testes"')).toEqual(["echo", "sem testes"]);
  });
});

describe("runVerifyCommands", () => {
  const withTempDir = (fn: (cwd: string) => Promise<void>) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "or-verify-run-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it(
    "marks a passing command as passed and captures its output as notes",
    withTempDir(async (cwd) => {
      const results = await runVerifyCommands(cwd, { build: 'echo "build ok"', test: "echo test-ok" });
      expect(results.build).toEqual({ passed: true, notes: expect.stringContaining("build ok") });
      expect(results.test?.passed).toBe(true);
      expect(results.typecheck).toBeUndefined(); // not configured for this repo
      expect(results.lint).toBeUndefined();
    })
  );

  it(
    "marks a failing command as failed (non-zero exit), without throwing",
    withTempDir(async (cwd) => {
      const results = await runVerifyCommands(cwd, { build: "false", test: "echo ok" });
      expect(results.build?.passed).toBe(false);
      expect(results.test?.passed).toBe(true);
    })
  );

  it(
    "runs every configured command independently — a build failure doesn't skip test",
    withTempDir(async (cwd) => {
      const results = await runVerifyCommands(cwd, {
        install: "echo installing", // setup step, not tracked in VerifyResults
        build: "false",
        test: "echo test-ok",
      });
      expect(results.build?.passed).toBe(false);
      expect(results.test?.passed).toBe(true);
    })
  );

  it(
    "truncates notes to the last ~2000 chars",
    withTempDir(async (cwd) => {
      const results = await runVerifyCommands(cwd, {
        build: "node -e console.log('x'.repeat(3000))",
        test: "echo ok",
      });
      expect(results.build?.passed).toBe(true);
      expect(results.build?.notes).toHaveLength(2000);
    })
  );

  it(
    "treats a blank command as a failure instead of crashing",
    withTempDir(async (cwd) => {
      const results = await runVerifyCommands(cwd, { build: "   ", test: "echo ok" });
      expect(results.build?.passed).toBe(false);
    })
  );
});
