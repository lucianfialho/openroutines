/**
 * Repo resolution matching (label routing + typo suggestions).
 *
 * The card's "Repositório" field is the canonical target; labels are the
 * fallback for cards that omit it. Two collisions this module untangles:
 *  - the system flag label ("OpenRoutines", carried by EVERY card) name-
 *    collides with the same-named repo — excluded via `excludeLabels`.
 *  - a project label may be declared as a repo alias (RepoConfig.labels), so a
 *    label routes even when it isn't literally the registry key.
 */

import type { RepoRegistry } from "./schema.js";

/** Outcome of resolving a claimed card to a repo — feeds the Blocked feedback. */
export type RepoResolution =
  | { ok: true; repo: string }
  | { ok: false; reason: "field_unmatched"; field: string; suggestion?: string }
  | { ok: false; reason: "unresolved" };

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Resolve a repo from the card's labels, in order. For each label (skipping the
 * excluded flag labels) collect the repos it matches by registry KEY or by an
 * item of RepoConfig.labels (both case-insensitive/trim): exactly one repo →
 * that key wins; two or more (ambiguous) → skip the label and try the next; none
 * → next label. Nothing matched → undefined.
 */
export const matchRepoByLabels = (
  registry: RepoRegistry,
  labels: string[],
  excludeLabels: string[]
): string | undefined => {
  const excluded = new Set(excludeLabels.map(norm));
  for (const raw of labels) {
    const label = norm(raw);
    if (!label || excluded.has(label)) continue;
    const matches = new Set<string>();
    for (const [key, config] of Object.entries(registry.repos)) {
      if (norm(key) === label || config.labels?.some((a) => norm(a) === label)) matches.add(key);
    }
    if (matches.size === 1) return [...matches][0];
    // 0 matches → next label; 2+ matches (ambiguous) → next label
  }
  return undefined;
};

/** Levenshtein edit distance (two-row DP) — no new dependency for a ~15-line function. */
const levenshtein = (a: string, b: string): number => {
  const n = b.length;
  if (a.length === 0) return n;
  if (n === 0) return a.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
};

/**
 * Nearest registry KEY (via key OR alias) to `input` within edit distance 2,
 * case-insensitive. Ties break by smaller distance then alphabetical key.
 * Always returns the registry key, even when the closest match was an alias;
 * nothing within distance 2 → undefined.
 */
export const suggestRepoSlug = (registry: RepoRegistry, input: string): string | undefined => {
  const needle = norm(input);
  if (!needle) return undefined;
  let best: { dist: number; key: string } | undefined;
  const consider = (slug: string, key: string): void => {
    const dist = levenshtein(needle, slug);
    if (dist > 2) return;
    if (!best || dist < best.dist || (dist === best.dist && key < best.key)) best = { dist, key };
  };
  for (const [key, config] of Object.entries(registry.repos)) {
    consider(norm(key), key);
    for (const alias of config.labels ?? []) consider(norm(alias), key);
  }
  return best?.key;
};
