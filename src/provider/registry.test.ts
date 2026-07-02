import { describe, it, expect } from "vitest";
import { makeProviderRegistry } from "./registry.js";

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
