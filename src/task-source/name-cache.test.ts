import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Cause } from "effect";
import { createNameCache } from "./name-cache.js";
import { TaskSourceError } from "./types.js";

// Scope fake timers to Date only: Effect's own runtime scheduling may rely on
// real setTimeout/setImmediate, and this cache only ever reads Date.now() —
// faking the full timer surface risks stalling Effect.runPromise for nothing.
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createNameCache", () => {
  it("calls load only once across two resolves within the TTL", async () => {
    const cache = createNameCache(5 * 60 * 1000);
    const load = vi.fn().mockResolvedValue({ Fila: "list-1" });

    const first = await Effect.runPromise(cache.resolve("list", "Fila", load));
    vi.setSystemTime(NOW + 1000);
    const second = await Effect.runPromise(cache.resolve("list", "Fila", load));

    expect(first).toBe("list-1");
    expect(second).toBe("list-1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("calls load again once the TTL has expired", async () => {
    const cache = createNameCache(1000);
    const load = vi.fn().mockResolvedValue({ Fila: "list-1" });

    await Effect.runPromise(cache.resolve("list", "Fila", load));
    vi.setSystemTime(NOW + 1001);
    await Effect.runPromise(cache.resolve("list", "Fila", load));

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fails with a TaskSourceError mentioning kind and name when absent even after reload", async () => {
    const cache = createNameCache();
    const load = vi.fn().mockResolvedValue({ Fila: "list-1" });

    const exit = await Effect.runPromiseExit(cache.resolve("list", "Unknown", load));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const result = Cause.findError(exit.cause);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.success).toBeInstanceOf(TaskSourceError);
        expect(result.success.message).toContain("list");
        expect(result.success.message).toContain("Unknown");
      }
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("wraps a load() rejection in a TaskSourceError instead of throwing", async () => {
    const cache = createNameCache();
    const load = vi.fn().mockRejectedValue(new Error("network down"));

    const exit = await Effect.runPromiseExit(cache.resolve("list", "Fila", load));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const result = Cause.findError(exit.cause);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        expect(result.success).toBeInstanceOf(TaskSourceError);
      }
    }
  });

  it("invalidate(kind) forces the next resolve to reload", async () => {
    const cache = createNameCache(5 * 60 * 1000);
    const load = vi.fn().mockResolvedValue({ Fila: "list-1" });

    await Effect.runPromise(cache.resolve("list", "Fila", load));
    cache.invalidate("list");
    await Effect.runPromise(cache.resolve("list", "Fila", load));

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("resolveMap returns the full map and shares the cache with resolve (one load)", async () => {
    const cache = createNameCache(5 * 60 * 1000);
    const load = vi.fn().mockResolvedValue({ Fila: "list-1", Done: "list-2" });

    const map = await Effect.runPromise(cache.resolveMap("list", load));
    const id = await Effect.runPromise(cache.resolve("list", "Done", load));

    expect(map).toEqual({ Fila: "list-1", Done: "list-2" });
    expect(id).toBe("list-2");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("resolveMap does not throw for a name absent from the map (caller scans it)", async () => {
    const cache = createNameCache();
    const load = vi.fn().mockResolvedValue({ Fila: "list-1" });

    const map = await Effect.runPromise(cache.resolveMap("list", load));

    expect(map.Blocked).toBeUndefined();
    expect(map.Fila).toBe("list-1");
  });

  it("caches each kind independently", async () => {
    const cache = createNameCache(5 * 60 * 1000);
    const loadList = vi.fn().mockResolvedValue({ Fila: "list-1" });
    const loadLabel = vi.fn().mockResolvedValue({ OpenRoutines: "label-1" });

    const list = await Effect.runPromise(cache.resolve("list", "Fila", loadList));
    const label = await Effect.runPromise(cache.resolve("label", "OpenRoutines", loadLabel));

    expect(list).toBe("list-1");
    expect(label).toBe("label-1");
    expect(loadList).toHaveBeenCalledTimes(1);
    expect(loadLabel).toHaveBeenCalledTimes(1);
  });
});
