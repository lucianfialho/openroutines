/**
 * Versioned operational policy (F5 #168, D32).
 *
 * `policy.yaml` at the repo root holds the operational knobs the weekly
 * calibration loop (D27) is allowed to propose changes to (PR cap, circuit
 * breaker threshold, per-tier call caps, backpressure) — never safety knobs.
 * Minimum blocking confidence, the dual-judge requirement on critical
 * security surface, and Opus owning the security gate (D14/D32) stay
 * hardcoded elsewhere, on purpose: PolicySchema is `.strict()` at every
 * level, so a stray safety-sounding key anywhere in the YAML (e.g.
 * `night.min_confidence`) fails `loadPolicy()` with a clear Zod error
 * instead of being silently ignored — or worse, silently honored.
 *
 * BOUNDS is compiled in TypeScript, not the YAML: that is what stops the
 * file from loosening its own ceiling. `loadPolicy()` throws (never applies
 * silently) when a value falls outside its bound — boot is supposed to fail
 * loud here, never fall back to a hardcoded default.
 */
import { readFileSync } from "fs";
import { parse } from "yaml";
import { z } from "zod";

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const PolicySchema = z
  .object({
    version: z.literal(1),
    night: z
      .object({
        max_prs_per_night: z.number(),
        circuit_breaker_failure_rate: z.number(),
        max_opus_calls_per_night: z.number(),
        budget_usd: z.number(),
      })
      .strict(),
    day: z
      .object({
        max_auto_proposed_cards_per_week: z.number(),
        budget_usd: z.number(),
      })
      .strict(),
    backpressure: z
      .object({
        max_open_prs_per_repo: z.number(),
      })
      .strict(),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

/**
 * Dot-path -> {min, max}, compiled here (never in policy.yaml). The single
 * source of truth for "how far the calibration loop is allowed to move a
 * knob" — e.g. the PR cap can never exceed 8, no matter what a proposal says.
 */
export const BOUNDS: Record<string, { min: number; max: number }> = {
  "night.max_prs_per_night": { min: 1, max: 8 },
  "night.circuit_breaker_failure_rate": { min: 0.3, max: 0.9 },
  "night.max_opus_calls_per_night": { min: 1, max: 30 },
  // Judgment call (like the bounds above): default is 30; the floor keeps a
  // minimally useful night and 2.5x default caps a runaway calibration proposal.
  "night.budget_usd": { min: 10, max: 75 },
  "day.max_auto_proposed_cards_per_week": { min: 1, max: 10 },
  // Daytime triage/research effort-unit ceiling per calendar day (sonnet=1,
  // see day-budget.ts). Floor 1 keeps a minimally useful day; 30 caps a
  // runaway calibration proposal (same judgment-call shape as night.budget_usd).
  "day.budget_usd": { min: 1, max: 30 },
  "backpressure.max_open_prs_per_repo": { min: 1, max: 6 },
};

/** Flattens a validated Policy into the same dot-paths BOUNDS keys on. */
const flatten = (policy: Policy): Record<string, number> => ({
  "night.max_prs_per_night": policy.night.max_prs_per_night,
  "night.circuit_breaker_failure_rate": policy.night.circuit_breaker_failure_rate,
  "night.max_opus_calls_per_night": policy.night.max_opus_calls_per_night,
  "night.budget_usd": policy.night.budget_usd,
  "day.max_auto_proposed_cards_per_week": policy.day.max_auto_proposed_cards_per_week,
  "day.budget_usd": policy.day.budget_usd,
  "backpressure.max_open_prs_per_repo": policy.backpressure.max_open_prs_per_repo,
});

/**
 * Parses + validates a policy.yaml STRING (no filesystem access — the seam
 * loadPolicy() and tests both go through). Throws PolicyError on a schema
 * violation (unknown/missing key, wrong type) or any value outside BOUNDS.
 */
export const parsePolicy = (yamlContent: string): Policy => {
  let raw: unknown;
  try {
    raw = parse(yamlContent);
  } catch (err) {
    // Malformed YAML syntax is just as much an "invalid policy.yaml" as a
    // schema violation — callers should only ever need to catch PolicyError,
    // never reach for the `yaml` package's own error class too.
    throw new PolicyError(`Invalid policy.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new PolicyError(`Invalid policy.yaml: ${issues}`);
  }
  for (const [path, value] of Object.entries(flatten(result.data))) {
    const bound = BOUNDS[path];
    if (bound && (value < bound.min || value > bound.max)) {
      throw new PolicyError(`policy.yaml: ${path}=${value} is outside its compiled bound [${bound.min}, ${bound.max}]`);
    }
  }
  return result.data;
};

/**
 * Reads + validates policy.yaml from `path`. Boot is meant to fail loud and
 * clear on a missing file (readFileSync's ENOENT propagates as-is) or an
 * invalid one (PolicyError) — never a silent fallback to a hardcoded default.
 */
export const loadPolicy = (path: string): Policy => parsePolicy(readFileSync(path, "utf-8"));

/**
 * Same bound check `loadPolicy()` applies internally, exposed standalone for
 * the weekly calibration loop (D27) to call BEFORE opening a PR that edits
 * policy.yaml: a proposed value outside its bound is rejected outright,
 * never turned into a diff. `path` unknown to BOUNDS is rejected too — the
 * calibration loop can only ever move a knob this file already declares.
 */
export const validateProposedChange = (path: string, value: number): { ok: boolean; reason?: string } => {
  const bound = BOUNDS[path];
  if (!bound) return { ok: false, reason: `unknown policy path: ${path}` };
  if (value < bound.min || value > bound.max) {
    return { ok: false, reason: `${path}=${value} is outside its compiled bound [${bound.min}, ${bound.max}]` };
  }
  return { ok: true };
};
