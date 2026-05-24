import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import OpenAI from "openai";
import { makeKimiProvider, KimiError } from "./kimi.js";


vi.mock("openai", () => {
  return {
    default: vi.fn(),
  };
});

const createMockClient = (overrides?: {
  create?: (...args: unknown[]) => Promise<unknown>;
}) => {
  const mockCreate = vi.fn(overrides?.create);
  const MockedOpenAI = vi.mocked(OpenAI);
  MockedOpenAI.mockImplementation(
    () =>
      ({
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      }) as unknown as OpenAI
  );
  return { mockCreate, MockedOpenAI };
};

describe("makeKimiProvider", () => {
  const config = { apiKey: "test-key", model: "kimi-k2-6" };

  it("should authenticate and return a completion response", async () => {
    const { mockCreate } = createMockClient({
      create: async () => ({
        choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "kimi-k2-6",
      }),
    });

    const provider = makeKimiProvider(config);
    const result = await Effect.runPromise(
      provider.complete({ prompt: "Say hello" })
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "kimi-k2-6",
        messages: [{ role: "user", content: "Say hello" }],
        temperature: 0.2,
        max_tokens: 4096,
      })
    );
    expect(result.content).toBe("Hello world");
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.finishReason).toBe("stop");
  });

  it("should include system message when provided", async () => {
    const { mockCreate } = createMockClient({
      create: async () => ({
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "kimi-k2-6",
      }),
    });

    const provider = makeKimiProvider(config);
    await Effect.runPromise(
      provider.complete({ prompt: "Hi", system: "You are helpful" })
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hi" },
        ],
      })
    );
  });

  it("should retry on rate limit (429)", async () => {
    const { mockCreate } = createMockClient({
      create: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("Rate limited"), { status: 429 })
        )
        .mockResolvedValueOnce({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "kimi-k2-6",
        }),
    });

    const provider = makeKimiProvider(config);
    const result = await Effect.runPromise(
      provider.complete({ prompt: "Test" })
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("OK");
  });

  it(
    "should fail after max retries on persistent rate limit",
    async () => {
      const { mockCreate } = createMockClient({
        create: vi.fn().mockRejectedValue(
          Object.assign(new Error("Rate limited"), { status: 429 })
        ),
      });

      const provider = makeKimiProvider(config);
      const exit = await Effect.runPromiseExit(
        provider.complete({ prompt: "Test" })
      );

      expect(exit._tag).toBe("Failure");
      expect(mockCreate).toHaveBeenCalledTimes(4); // initial + 3 retries
    },
    10000
  );

  it("should fail on non-rate-limit errors without retry", async () => {
    const { mockCreate } = createMockClient({
      create: vi.fn().mockRejectedValue(
        Object.assign(new Error("Server error"), { status: 500 })
      ),
    });

    const provider = makeKimiProvider(config);
    const exit = await Effect.runPromiseExit(
      provider.complete({ prompt: "Test" })
    );

    expect(exit._tag).toBe("Failure");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("should fail when no choices are returned", async () => {
    createMockClient({
      create: async () => ({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
        model: "kimi-k2-6",
      }),
    });

    const provider = makeKimiProvider(config);
    const exit = await Effect.runPromiseExit(
      provider.complete({ prompt: "Test" })
    );

    expect(exit._tag).toBe("Failure");
  });

  it("should return a stream for streaming completions", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: " world" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
    ];

    async function* mockStream() {
      for (const chunk of chunks) yield chunk;
    }

    createMockClient({
      create: async () => mockStream(),
    });

    const provider = makeKimiProvider(config);
    const streamResult = await Effect.runPromise(
      provider.completeStream({ prompt: "Say hello" })
    );

    const results: Array<{ content: string; usage?: unknown }> = [];
    for await (const chunk of streamResult) {
      results.push(chunk);
    }

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("Hello");
    expect(results[1].content).toBe(" world");
    expect(results[1].usage).toEqual({
      promptTokens: 2,
      completionTokens: 2,
      totalTokens: 4,
    });
  });
});
