import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { makeClaudeProvider, ClaudeError } from "./claude.js";

/** Minimal fetch Response stand-in — only what claude.ts reads. */
const fakeResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const successBody = (model: string) => ({
  content: [{ type: "text", text: "OK" }],
  usage: { input_tokens: 1, output_tokens: 1 },
  model,
  stop_reason: "stop",
});

const errorBody = (message: string) => ({ error: { message } });

describe("makeClaudeProvider", () => {
  const config = { apiKey: "test-key" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends `system` as a top-level body field, not embedded in messages", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, successBody("claude-opus-4-8")));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeClaudeProvider(config);
    await Effect.runPromise(provider.complete({ system: "abc", prompt: "hi" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(init.body as string);

    expect(body.system).toBe("abc");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    // No synthesized "System: abc" text anywhere in messages.
    for (const m of body.messages) {
      expect(String(m.content)).not.toContain("System: abc");
    }
  });

  it("retries on 429 and succeeds once the API recovers", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429, errorBody("Rate limited")))
      .mockResolvedValueOnce(fakeResponse(429, errorBody("Rate limited")))
      .mockResolvedValueOnce(fakeResponse(200, successBody("claude-opus-4-8")));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeClaudeProvider(config);
    const result = await Effect.runPromise(provider.complete({ prompt: "hi" }));

    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(result.content).toBe("OK");
  }, 10000);

  it("fails as ClaudeError with status 429 after exhausting retries", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(fakeResponse(429, errorBody("Rate limited")));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeClaudeProvider({ ...config, retries: 2 });
    const err = await Effect.runPromise(Effect.flip(provider.complete({ prompt: "hi" })));

    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err.status).toBe(429);
  }, 10000);

  it("propagates the model reported by the response, not the requested one", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, successBody("claude-opus-4-8-20260101")));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeClaudeProvider({ ...config, model: "claude-opus-4-8" });
    const result = await Effect.runPromise(provider.complete({ prompt: "hi" }));

    expect(result.model).toBe("claude-opus-4-8-20260101");
  });
});
