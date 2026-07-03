/**
 * Name Cache
 *
 * Generic TTL cache for name -> id resolution (e.g. a Trello list name -> its
 * list id). Knows nothing about Trello, REST, or any source: the caller
 * supplies a `load()` that fetches the full name->id map for a "kind" (e.g.
 * "list", "label"); this only decides when `load()` needs calling again.
 * Reused by the Trello bespoke adapter (issue #4) for its name resolution.
 */

import { Effect } from "effect";
import { TaskSourceError } from "./types.js";

export interface NameCache {
  resolve: (
    kind: string,
    name: string,
    load: () => Promise<Record<string, string>>
  ) => Effect.Effect<string, TaskSourceError>;
  /**
   * Returns the full cached name->id map for a kind (loading it if
   * absent/expired). Unlike `resolve`, an absent name is not an error — the
   * caller inverts/scans the map itself (e.g. deriving a canonical state from
   * an idList, where a board column outside the system's control may simply be
   * missing and must be skipped, not throw).
   */
  resolveMap: (
    kind: string,
    load: () => Promise<Record<string, string>>
  ) => Effect.Effect<Record<string, string>, TaskSourceError>;
  invalidate: (kind: string) => void;
}

interface CacheEntry {
  map: Record<string, string>;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export const createNameCache = (ttlMs: number = DEFAULT_TTL_MS): NameCache => {
  const cache = new Map<string, CacheEntry>();

  const resolveMap = (
    kind: string,
    load: () => Promise<Record<string, string>>
  ): Effect.Effect<Record<string, string>, TaskSourceError> =>
    Effect.gen(function* () {
      const cached = cache.get(kind);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.map;
      }
      const map = yield* Effect.tryPromise({
        try: load,
        catch: (cause) => new TaskSourceError(`Failed to load names for "${kind}"`, undefined, cause),
      });
      cache.set(kind, { map, expiresAt: Date.now() + ttlMs });
      return map;
    });

  const resolve = (
    kind: string,
    name: string,
    load: () => Promise<Record<string, string>>
  ): Effect.Effect<string, TaskSourceError> =>
    Effect.gen(function* () {
      const map = yield* resolveMap(kind, load);
      const id = map[name];
      if (id === undefined) {
        return yield* Effect.fail(new TaskSourceError(`Unknown ${kind} name "${name}"`));
      }
      return id;
    });

  const invalidate = (kind: string): void => {
    cache.delete(kind);
  };

  return { resolve, resolveMap, invalidate };
};
