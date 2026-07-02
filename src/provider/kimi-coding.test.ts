import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { makeKimiCodingProvider, KimiCodingError } from "./kimi-coding.js";

/** Minimal fetch Response stand-in — only what kimi-coding.ts reads. */
const fakeResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const successBody = {
  content: [{ type: "text", text: "OK" }],
  usage: { input_tokens: 1, output_tokens: 1 },
  model: "kimi-coding/k2p5",
  stop_reason: "stop",
};

const errorBody = (message: string) => ({ error: { message } });

describe("makeKimiCodingProvider", () => {
  const config = { apiKey: "test-key" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should retry on 429 and succeed once the API recovers", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429, errorBody("Rate limited")))
      .mockResolvedValueOnce(fakeResponse(429, errorBody("Rate limited")))
      .mockResolvedValueOnce(fakeResponse(200, successBody));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeKimiCodingProvider(config);
    const result = await Effect.runPromise(
      provider.complete({ prompt: "hi" })
    );

    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(result.content).toBe("OK");
  }, 10000);

  it("should fail immediately on 401 without retrying", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(fakeResponse(401, errorBody("Unauthorized")));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeKimiCodingProvider(config);
    const err = await Effect.runPromise(
      Effect.flip(provider.complete({ prompt: "hi" }))
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(KimiCodingError);
    expect(err.status).toBe(401);
  });

  it("should fail as KimiCodingError with status 429 after exhausting retries", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(fakeResponse(429, errorBody("Rate limited")));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeKimiCodingProvider({ ...config, retries: 2 });
    const err = await Effect.runPromise(
      Effect.flip(provider.complete({ prompt: "hi" }))
    );

    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(err).toBeInstanceOf(KimiCodingError);
    expect(err.status).toBe(429);
  }, 10000);

  it("should retry on 529 (overloaded) same as 429", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(529, errorBody("Overloaded")))
      .mockResolvedValueOnce(fakeResponse(200, successBody));
    vi.stubGlobal("fetch", mockFetch);

    const provider = makeKimiCodingProvider(config);
    const result = await Effect.runPromise(
      provider.complete({ prompt: "hi" })
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("OK");
  }, 10000);
});
