import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeEngine } from "./engine.js";
import { EngineError } from "./types.js";
import type { Routine } from "../routine/types.js";
import type { ExecutionRepository } from "../persistence/types.js";
import type { CompletionResponse } from "../provider/types.js";

const mockProvider = (response: CompletionResponse) => ({
  complete: vi.fn(() => Effect.succeed(response)),
});

const mockFailingProvider = (error: Error) => ({
  complete: vi.fn(() => Effect.fail(error)),
});

const makeMockRepository = (): ExecutionRepository => {
  const store: Record<string, unknown> = {};
  return {
    save: vi.fn(async (record) => {
      store[record.id] = record;
    }),
    findById: vi.fn(async (id) => store[id] as ReturnType<ExecutionRepository["findById"]>),
    findByRoutine: vi.fn(async () => []),
  };
};

const makeTestRoutine = (id: string, skill: string, triggerType: string): Routine => ({
  id,
  triggers: triggerType === "github"
    ? [{ type: "github", events: ["pull_request.opened"] }]
    : [{ type: triggerType as "api" | "schedule", cron: triggerType === "schedule" ? "0 9 * * *" : undefined }],
  pipeline: { skill },
});

describe("makeEngine", () => {
  const skillsDir = ".gates/skills";

  it("should execute a routine end-to-end", async () => {
    const routine = makeTestRoutine("test-routine", "solve-issue", "api");
    const repo = makeMockRepository();
    const provider = mockProvider({
      content: "Implementation complete",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "kimi-k2-6",
      finishReason: "stop",
    });

    const engine = makeEngine({
      routines: [routine],
      skillsDir,
      provider: provider as unknown as ReturnType<typeof makeEngine>["provider"],
      repository: repo,
    });

    const result = await Effect.runPromise(
      engine.execute({ type: "api", payload: { repo: "test/repo", issue: 1 } })
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("Implementation complete");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledTimes(2); // running + completed
  });

  it("should fail when no routine matches trigger", async () => {
    const repo = makeMockRepository();
    const provider = mockProvider({
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "",
      finishReason: "stop",
    });

    const engine = makeEngine({
      routines: [],
      skillsDir,
      provider: provider as unknown as ReturnType<typeof makeEngine>["provider"],
      repository: repo,
    });

    const result = await Effect.runPromise(
      engine.execute({ type: "api", payload: {} })
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("No routine matches");
  });

  it("should fail when multiple routines match", async () => {
    const repo = makeMockRepository();
    const provider = mockProvider({
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "",
      finishReason: "stop",
    });

    const engine = makeEngine({
      routines: [
        makeTestRoutine("r1", "skill-a", "api"),
        makeTestRoutine("r2", "skill-b", "api"),
      ],
      skillsDir,
      provider: provider as unknown as ReturnType<typeof makeEngine>["provider"],
      repository: repo,
    });

    const result = await Effect.runPromise(
      engine.execute({ type: "api", payload: {} })
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Ambiguous trigger");
  });

  it("should fail when provider errors", async () => {
    const routine = makeTestRoutine("test-routine", "solve-issue", "api");
    const repo = makeMockRepository();
    const provider = mockFailingProvider(new Error("API down"));

    const engine = makeEngine({
      routines: [routine],
      skillsDir,
      provider: provider as unknown as ReturnType<typeof makeEngine>["provider"],
      repository: repo,
    });

    const result = await Effect.runPromise(
      engine.execute({ type: "api", payload: {} })
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Provider completion failed");
    expect(repo.save).toHaveBeenCalledTimes(1); // only running state
  });
});
