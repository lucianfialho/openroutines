/**
 * card-to-pr complexity routing (F4 #185, D9)
 *
 * Resolves `provider:`/`model:` for the `plan`/`gate_plan`/`implementation`/
 * `rework` states from the card's Complexity + the `altaImpl` triage flag
 * ("Regra ALTA", 03-PIPELINE-EXECUCAO.md). `plan` and `gate_plan` are FIXED
 * — Sonnet always explores/proposes first, Opus always owns the architecture
 * gate (Opus is the apex — its verdict is final, no escalation) —
 * `implementation` and `rework` (F4 #157: the card's original
 * tier) actually route by tier. Reuses
 * circuit-breaker's `tierForComplexity` as the single source of truth for the
 * D9 table instead of a second copy of the same complexity->tier map.
 */
import { tierForComplexity, type Tier } from "../../engine/circuit-breaker.js";
import { nextTier } from "../../engine/retry-classifier.js";
import type { TaskComplexity } from "../../task-source/types.js";
import type { ProviderName } from "../../provider/registry.js";

export type CardToPrRoutedState = "plan" | "gate_plan" | "implementation" | "rework";

/** Same 3 buckets as the circuit breaker's Tier (D9: one ladder, one vocabulary). */
export type ImplementationTier = Tier;

export interface RouteInput {
  complexity?: TaskComplexity;
  altaImpl?: boolean;
}

export interface RouteResult {
  provider: ProviderName;
  model: string;
}

/**
 * `altaImpl` (D9 "regra ALTA": concurrency/security surface/non-trivial
 * migration/shared-contract refactor) overrides complexity and always routes
 * to Opus; otherwise the circuit breaker's D9 table decides. Complexity
 * "not_sure" and an absent complexity both land on sonnet (never Kimi by
 * default — an unclassified or ambiguous card never gets the cheap tier).
 */
export const resolveImplementationTier = (input: RouteInput): ImplementationTier =>
  input.altaImpl === true ? "opus" : tierForComplexity(input.complexity);

const IMPLEMENTATION_ROUTES: Record<ImplementationTier, RouteResult> = {
  kimi: { provider: "kimi-cli", model: "kimi-k2.6" },
  sonnet: { provider: "claude-cli", model: "claude-sonnet-5" },
  opus: { provider: "claude-cli", model: "claude-opus-4-8" },
};

export const resolveCardToPrProvider = (stateId: CardToPrRoutedState, input: RouteInput): RouteResult => {
  switch (stateId) {
    case "plan":
      return { provider: "claude-cli", model: "claude-sonnet-5" }; // fixed — doc 03 fase 1
    case "gate_plan":
      return { provider: "architecture-judge", model: "claude-opus-4-8" }; // Opus is the architecture apex (no escalation)
    case "implementation":
    // rework (F4 #157, D24) runs at the card's ORIGINAL tier — same D9 route
    // as implementation, from the same complexity/altaImpl inputs.
    case "rework":
      return IMPLEMENTATION_ROUTES[resolveImplementationTier(input)];
  }
};

/**
 * Tier-escalation ladder (F4 #159) applied to `implementation`'s dynamic
 * route: one tier up from `currentTier`, or undefined at the ceiling (opus)
 * — the runner then exhausts normally instead of granting a bogus attempt.
 */
export const resolveEscalatedProvider = (currentTier: ImplementationTier): RouteResult | undefined => {
  const escalated = nextTier(currentTier);
  return escalated ? IMPLEMENTATION_ROUTES[escalated] : undefined;
};
