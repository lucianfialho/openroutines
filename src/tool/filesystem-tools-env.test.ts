import { describe, it, expect, vi } from "vitest";
import { makeFilesystemTools } from "./filesystem-tools.js";

// Isolated from filesystem-tools.test.ts (which uses the real tsc) so we can
// mock exec and assert the env handed to run_shell.
let lastOptions: any;
vi.mock("child_process", () => ({
  exec: vi.fn((_cmd: string, options: any, cb: any) => {
    lastOptions = options;
    cb(null, { stdout: "ok", stderr: "" });
    return {};
  }),
}));

const runShell = makeFilesystemTools().find((t) => t.definition.name === "run_shell")!;

describe("run_shell — minimal env", () => {
  it("does not leak orchestrator secrets into the shell subprocess", async () => {
    process.env.DATABASE_URL = "postgres://secret";
    process.env.GITHUB_TOKEN = "ghp_x";
    try {
      await runShell.handler({ command: "echo hi" });
      expect(lastOptions.env.DATABASE_URL).toBeUndefined();
      expect(lastOptions.env.GITHUB_TOKEN).toBeUndefined();
      expect(lastOptions.env.PATH).toBeDefined();
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.GITHUB_TOKEN;
    }
  });
});
