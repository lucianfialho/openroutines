import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import OpenAI from "openai";
import { makeKimiProvider } from "./kimi.js";

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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reject empty apiKey", () => {
    expect(() => makeKimiProvider({ apiKey: "" })).toThrow(
      "KimiConfig.apiKey is required"
    );
    expect(() => makeKimiProvider({ apiKey: "   " })).toThrow(
      "KimiConfig.apiKey is required"
    );
  });

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

  it("should pass custom temperature and maxTokens", async () => {
    const { mockCreate } = createMockClient({
      create: async () => ({
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: "kimi-k2-6",
      }),
    });

    const provider = makeKimiProvider(config);
    await Effect.runPromise(
      provider.complete({ prompt: "Hi", temperature: 0.9, maxTokens: 100 })
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.9,
        max_tokens: 100,
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

  it("should respect custom retry count", async () => {
    const { mockCreate } = createMockClient({
      create: vi.fn().mockRejectedValue(
        Object.assign(new Error("Rate limited"), { status: 429 })
      ),
    });

    const provider = makeKimiProvider({ ...config, retries: 1 });
    const exit = await Effect.runPromiseExit(
      provider.complete({ prompt: "Test" })
    );

    expect(exit._tag).toBe("Failure");
    expect(mockCreate).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

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

  it("should timeout on slow API responses", async () => {
    const { mockCreate } = createMockClient({
      create: () =>
        new Promise((resolve) => setTimeout(resolve, 1000, {
          choices: [{ message: { content: "Too late" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "kimi-k2-6",
        })),
    });

    const provider = makeKimiProvider({ ...config, timeoutMs: 100 });
    const exit = await Effect.runPromiseExit(
      provider.complete({ prompt: "Test" })
    );

    expect(exit._tag).toBe("Failure");
    expect(mockCreate).toHaveBeenCalledTimes(1);
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

    const results: Array<{ content: string; usage?: unknown; finishReason?: string }> = [];
    for await (const chunk of streamResult) {
      results.push(chunk);
    }

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("Hello");
    expect(results[0].finishReason).toBeUndefined();
    expect(results[1].content).toBe(" world");
    expect(results[1].finishReason).toBe("stop");
    expect(results[1].usage).toEqual({
      promptTokens: 2,
      completionTokens: 2,
      totalTokens: 4,
    });
  });

  it("should estimate stream tokens when usage is missing", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hi" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: " there" }, finish_reason: "stop" }], usage: null },
    ];

    async function* mockStream() {
      for (const chunk of chunks) yield chunk;
    }

    createMockClient({
      create: async () => mockStream(),
    });

    const provider = makeKimiProvider(config);
    const streamResult = await Effect.runPromise(
      provider.completeStream({ prompt: "Greet" })
    );

    const results: Array<{ content: string; usage?: unknown }> = [];
    for await (const chunk of streamResult) {
      results.push(chunk);
    }

    expect(results).toHaveLength(2);
    // "Hi" = 2 chars → ceil(2/4) = 1 token
    // " there" = 6 chars → ceil(6/4) = 2 tokens
    expect(results[1].usage).toEqual({
      promptTokens: 0,
      completionTokens: 3,
      totalTokens: 3,
    });
  });

  it("should fail stream on API error", async () => {
    createMockClient({
      create: vi.fn().mockRejectedValue(
        Object.assign(new Error("Stream broken"), { status: 500 })
      ),
    });

    const provider = makeKimiProvider(config);
    const exit = await Effect.runPromiseExit(
      provider.completeStream({ prompt: "Test" })
    );

    expect(exit._tag).toBe("Failure");
  });
});
