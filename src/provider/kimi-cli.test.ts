import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { Effect } from "effect";
import { makeKimiCliProvider } from "./kimi-cli.js";

let lastCall: { file: string; args: string[]; options: any };
vi.mock("child_process", () => ({
  spawn: vi.fn((file: string, args: string[], options: any) => {
    lastCall = { file, args, options };
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("close", 0));
    return child;
  }),
}));

describe("kimi-cli provider — argv + minimal env", () => {
  it("passes the prompt as a single argv element, never a shell string", async () => {
    const payload = '$(touch /tmp/pwned); rm -rf / `whoami`';
    const provider = makeKimiCliProvider({});
    await Effect.runPromise(provider.complete({ messages: [{ role: "user", content: payload }] } as any));
    expect(lastCall.file).toBe("kimi");
    const promptIdx = lastCall.args.indexOf("--prompt");
    expect(lastCall.args[promptIdx + 1]).toBe(`user: ${payload}`);
  });

  it("does not pass unrelated secrets to the kimi subprocess", async () => {
    process.env.DATABASE_URL = "postgres://secret";
    process.env.GITHUB_TOKEN = "ghp_x";
    process.env.KIMI_API_KEY = "kimi_key";
    try {
      const provider = makeKimiCliProvider({});
      await Effect.runPromise(provider.complete({ prompt: "hi" } as any));
      expect(lastCall.options.env.DATABASE_URL).toBeUndefined();
      expect(lastCall.options.env.GITHUB_TOKEN).toBeUndefined();
      expect(lastCall.options.env.KIMI_API_KEY).toBe("kimi_key");
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.GITHUB_TOKEN;
      delete process.env.KIMI_API_KEY;
    }
  });

  it("runs in the card's worktree (request.workdir) so the agent edits the checkout, not the orchestrator repo", async () => {
    const provider = makeKimiCliProvider({});
    await Effect.runPromise(provider.complete({ prompt: "hi", workdir: "/tmp/wt-card-1" } as any));
    expect(lastCall.options.cwd).toBe("/tmp/wt-card-1");
  });

  it("falls back to process.cwd() when no workdir is set", async () => {
    const provider = makeKimiCliProvider({});
    await Effect.runPromise(provider.complete({ prompt: "hi" } as any));
    expect(lastCall.options.cwd).toBe(process.cwd());
  });
});
