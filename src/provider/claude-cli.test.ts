import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { Effect } from "effect";
import fs from "fs";
import os from "os";
import path from "path";
import { makeClaudeCliProvider, ClaudeCliError } from "./claude-cli.js";
import type { ExecutionProcessRepository, ExecutionProcess } from "../persistence/types.js";

// `spawn` is wrapped so most tests can inject a deterministic fake child
// (EventEmitter-based, like kimi-cli.test.ts), while the group-kill test at
// the bottom falls through to the *real* child_process.spawn — it needs an
// actual OS process tree to prove `process.kill(-pid, ...)` kills the group.
const state = vi.hoisted(() => ({
  lastCall: undefined as { file: string; args: string[]; options: any } | undefined,
  spawnImpl: null as ((file: string, args: string[], options: any) => any) | null,
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (file: string, args: string[], options: any) => {
      state.lastCall = { file, args, options };
      if (state.spawnImpl) return state.spawnImpl(file, args, options);
      return actual.spawn(file, args, options);
    },
  };
});

const fakeChild = (opts: { pid?: number; stdout?: string; stderr?: string; exitCode?: number }) => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = opts.pid ?? 4242;
  setImmediate(() => {
    if (opts.stdout !== undefined) child.stdout.emit("data", opts.stdout);
    if (opts.stderr !== undefined) child.stderr.emit("data", opts.stderr);
    child.emit("close", opts.exitCode ?? 0);
  });
  return child;
};

const successJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ result: "hi", total_cost_usd: 0.42, session_id: "sess-1", is_error: false, ...overrides });

beforeEach(() => {
  state.lastCall = undefined;
  state.spawnImpl = null;
});

describe("claude-cli provider — argv shape", () => {
  it("always includes -p <prompt>, safe headless flags, and never --bare / --max-budget-usd", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const provider = makeClaudeCliProvider({});

    await Effect.runPromise(provider.complete({ prompt: "x", maxBudgetUsd: 5 } as any));

    const args = state.lastCall!.args;
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("x");
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("dontAsk");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--max-budget-usd");
  });

  it("omits --fallback-model, --json-schema and --add-dir when not configured", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const provider = makeClaudeCliProvider({});

    await Effect.runPromise(provider.complete({ prompt: "x" }));

    expect(state.lastCall!.args).not.toContain("--fallback-model");
    expect(state.lastCall!.args).not.toContain("--json-schema");
    expect(state.lastCall!.args).not.toContain("--add-dir");
  });

  it("includes --fallback-model only when config.fallbackModel is set", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const provider = makeClaudeCliProvider({ fallbackModel: "claude-haiku" });

    await Effect.runPromise(provider.complete({ prompt: "x" }));

    const args = state.lastCall!.args;
    const idx = args.indexOf("--fallback-model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("claude-haiku");
  });

  it("includes --json-schema (stringified) only when request.jsonSchema is set", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const provider = makeClaudeCliProvider({});

    await Effect.runPromise(provider.complete({ prompt: "x", jsonSchema: { type: "object" } } as any));

    const args = state.lastCall!.args;
    const idx = args.indexOf("--json-schema");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(JSON.stringify({ type: "object" }));
  });

  it("includes --add-dir only when request.workdir is set", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const provider = makeClaudeCliProvider({});

    await Effect.runPromise(provider.complete({ prompt: "x", workdir: "/tmp/worktree-1" } as any));

    const args = state.lastCall!.args;
    const idx = args.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("/tmp/worktree-1");
  });

  it("passes the prompt as a single argv element, never a shell string", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const payload = '$(touch /tmp/pwned); rm -rf / `whoami`';
    const provider = makeClaudeCliProvider({});

    await Effect.runPromise(provider.complete({ prompt: payload } as any));

    expect(state.lastCall!.file).toBe("claude");
    expect(state.lastCall!.args[1]).toBe(payload);
  });
});

describe("claude-cli provider — env", () => {
  it("never forwards unrelated secrets like DATABASE_URL/GITHUB_TOKEN to the subprocess", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    process.env.DATABASE_URL = "postgres://secret";
    process.env.GITHUB_TOKEN = "ghp_x";
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
    try {
      const provider = makeClaudeCliProvider({});
      await Effect.runPromise(provider.complete({ prompt: "hi" } as any));
      expect(state.lastCall!.options.env.DATABASE_URL).toBeUndefined();
      expect(state.lastCall!.options.env.GITHUB_TOKEN).toBeUndefined();
      // Subscription provider: OAuth token forwarded, API key never (that is claude-api's, D3/#133).
      expect(state.lastCall!.options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(state.lastCall!.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.GITHUB_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });
});

describe("claude-cli provider — cwd", () => {
  it("spawns with cwd === request.workdir when set", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const provider = makeClaudeCliProvider({});

    await Effect.runPromise(provider.complete({ prompt: "x", workdir: "/tmp/worktree-1" } as any));

    expect(state.lastCall!.options.cwd).toBe("/tmp/worktree-1");
  });

  it("spawns with cwd === process.cwd() when request.workdir is absent", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const provider = makeClaudeCliProvider({});

    await Effect.runPromise(provider.complete({ prompt: "x" } as any));

    expect(state.lastCall!.options.cwd).toBe(process.cwd());
  });
});

describe("claude-cli provider — response parsing", () => {
  it("maps a successful single-JSON response to content/costUsd/sessionId", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson({ result: "the answer", total_cost_usd: 0.017, session_id: "sess-abc" }) });
    const provider = makeClaudeCliProvider({ model: "claude-opus-4-8" });

    const response = await Effect.runPromise(provider.complete({ prompt: "x" }));

    expect(response.content).toBe("the answer");
    expect(response.costUsd).toBe(0.017);
    expect(response.sessionId).toBe("sess-abc");
    expect(response.model).toBe("claude-opus-4-8");
    expect(response.finishReason).toBe("stop");
  });

  it("rejects with ClaudeCliError (stderr captured) on non-zero exit", async () => {
    state.spawnImpl = () => fakeChild({ stdout: "", stderr: "boom: bad config", exitCode: 1 });
    const provider = makeClaudeCliProvider({});

    const err = await Effect.runPromise(Effect.flip(provider.complete({ prompt: "x" })));

    expect(err).toBeInstanceOf(ClaudeCliError);
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toContain("boom: bad config");
  });

  it("rejects with ClaudeCliError (stderr captured) when is_error:true even on exit 0", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson({ is_error: true, result: "refused" }), stderr: "warning: refused", exitCode: 0 });
    const provider = makeClaudeCliProvider({});

    const err = await Effect.runPromise(Effect.flip(provider.complete({ prompt: "x" })));

    expect(err).toBeInstanceOf(ClaudeCliError);
    expect(err.stderr).toContain("warning: refused");
  });

  it("rejects with ClaudeCliError when stdout is not valid JSON", async () => {
    state.spawnImpl = () => fakeChild({ stdout: "not json at all", exitCode: 0 });
    const provider = makeClaudeCliProvider({});

    const err = await Effect.runPromise(Effect.flip(provider.complete({ prompt: "x" })));

    expect(err).toBeInstanceOf(ClaudeCliError);
  });
});

describe("claude-cli provider — process tracking (F1 #137)", () => {
  it("saves the pid on start and marks it finished on completion, best-effort", async () => {
    state.spawnImpl = () => fakeChild({ pid: 9999, stdout: successJson() });
    const saved: ExecutionProcess[] = [];
    const finished: string[] = [];
    const repo: ExecutionProcessRepository = {
      save: async (p) => { saved.push(p); },
      markFinished: async (id) => { finished.push(id); },
      findRunning: async () => [],
    };
    const provider = makeClaudeCliProvider({ processRepository: repo });

    await Effect.runPromise(provider.complete({ prompt: "x", executionId: "exec-1", workdir: "/tmp/wt" } as any));

    expect(saved).toHaveLength(1);
    expect(saved[0].pid).toBe(9999);
    expect(saved[0].executionId).toBe("exec-1");
    expect(saved[0].worktree).toBe("/tmp/wt");
    expect(finished).toEqual([saved[0].id]);
  });

  it("does not track when there is no executionId on the request", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const save = vi.fn(async () => {});
    const repo: ExecutionProcessRepository = { save, markFinished: vi.fn(async () => {}), findRunning: async () => [] };
    const provider = makeClaudeCliProvider({ processRepository: repo });

    await Effect.runPromise(provider.complete({ prompt: "x" } as any));

    expect(save).not.toHaveBeenCalled();
  });

  it("a repository save failure never fails the completion call", async () => {
    state.spawnImpl = () => fakeChild({ stdout: successJson() });
    const repo: ExecutionProcessRepository = {
      save: async () => { throw new Error("db down"); },
      markFinished: async () => { throw new Error("db down"); },
      findRunning: async () => [],
    };
    const provider = makeClaudeCliProvider({ processRepository: repo });

    const response = await Effect.runPromise(provider.complete({ prompt: "x", executionId: "exec-1" } as any));

    expect(response.content).toBe("hi");
  });
});

describe("claude-cli provider — timeout kills the whole process group", () => {
  let scriptPath: string;

  beforeEach(() => {
    // A script that ignores its argv entirely and forks a background child
    // of its own — proves the group-kill (not just the direct child).
    scriptPath = path.join(os.tmpdir(), `claude-cli-group-kill-${Date.now()}.sh`);
    fs.writeFileSync(scriptPath, "#!/bin/sh\nsleep 30 &\nsleep 30\n");
    fs.chmodSync(scriptPath, 0o755);
  });

  afterEach(() => {
    fs.rmSync(scriptPath, { force: true });
  });

  it("SIGKILLs the process group on timeout, killing both parent and forked child", async () => {
    // spawnImpl left null: this test needs a real OS process tree.
    let capturedPid: number | undefined;
    const repo: ExecutionProcessRepository = {
      save: async (p) => { capturedPid = p.pid; },
      markFinished: async () => {},
      findRunning: async () => [],
    };
    const provider = makeClaudeCliProvider({ binPath: scriptPath, timeoutMs: 300, processRepository: repo });

    const err = await Effect.runPromise(Effect.flip(provider.complete({ prompt: "x", executionId: "exec-1" } as any)));

    expect(err).toBeInstanceOf(ClaudeCliError);
    expect(capturedPid).toBeDefined();

    // Give SIGKILL a beat to land, then confirm no member of the group survives:
    // kill(-pgid, 0) throws ESRCH only when the whole group is gone.
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(-(capturedPid as number), 0)).toThrow();
  }, 10_000);
});
