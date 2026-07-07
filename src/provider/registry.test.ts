import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeProviderRegistry, withFallback, type ProviderAdapter } from "./registry.js";

const resp = (content: string) => ({ content, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: "m", finishReason: "stop" });
const okProvider = (content: string, onCall?: () => void): ProviderAdapter => ({
  complete: () => Effect.sync(() => { onCall?.(); return resp(content); }),
});
const failProvider = (msg: string): ProviderAdapter => ({ complete: () => Effect.fail(new Error(msg)) });

describe("makeProviderRegistry", () => {
  it("caches instances per (name, model): same reference on repeat", () => {
    const registry = makeProviderRegistry({ kimiCli: { model: "k2" } });
    const a = registry.resolve("kimi-cli", "k2");
    const b = registry.resolve("kimi-cli", "k2");
    expect(a).toBe(b);
  });

  it("returns distinct instances for different models", () => {
    const registry = makeProviderRegistry({ kimiCli: {} });
    const a = registry.resolve("kimi-cli", "modelA");
    const b = registry.resolve("kimi-cli", "modelB");
    expect(a).not.toBe(b);
  });

  it("treats absent model as its own cache key distinct from a named model", () => {
    const registry = makeProviderRegistry({ kimiCli: {} });
    const def = registry.resolve("kimi-cli");
    const named = registry.resolve("kimi-cli", "modelA");
    expect(def).not.toBe(named);
    expect(registry.resolve("kimi-cli")).toBe(def);
  });

  it("builds claude-api when apiKey is configured", () => {
    const registry = makeProviderRegistry({ claudeApi: { apiKey: "sk-test" } });
    const provider = registry.resolve("claude-api", "claude-opus-4-8");
    expect(typeof provider.complete).toBe("function");
  });

  it("fails fast with a clear message when claude-api has no apiKey", () => {
    const registry = makeProviderRegistry({ kimiCli: {} });
    expect(() => registry.resolve("claude-api")).toThrowError(/claude-api.*apiKey|ANTHROPIC_API_KEY/);
  });

  it("throws on an unknown provider name", () => {
    const registry = makeProviderRegistry({});
    expect(() => registry.resolve("bogus" as never)).toThrowError(/Unknown provider/);
  });
});

describe("withFallback", () => {
  it("returns the primary result and never touches the fallback when the primary succeeds", async () => {
    let fallbackCalled = false;
    const p = withFallback("t", okProvider("primary"), okProvider("secondary", () => { fallbackCalled = true; }));
    const res = await Effect.runPromise(p.complete({ prompt: "x" } as never));
    expect(res.content).toBe("primary");
    expect(fallbackCalled).toBe(false);
  });

  it("falls back to the secondary when the primary fails for any reason (e.g. quota/crash)", async () => {
    const p = withFallback("kimi-cli", failProvider("403 no quota"), okProvider("rescued-by-claude"));
    const res = await Effect.runPromise(p.complete({ prompt: "x" } as never));
    expect(res.content).toBe("rescued-by-claude");
  });
});
