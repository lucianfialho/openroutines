/**
 * card-to-pr / risk-check (F5 #163).
 *
 * Deterministic gate decision sitting between `plan` and implementation: does
 * this card need the architecture gate? It reads the plan phase's own
 * self-assessment (`needsArchGate`) plus two HARD signals off the planned file
 * list — a sensitive path (auth/payment/migration/webhook) or any data-model
 * change forces the gate regardless of what the plan claimed about itself, so a
 * plan that under-rates its own risk can't skip review.
 *
 * The `risk_check` state's YAML lives in .gates/skills/card-to-pr/skill.yaml
 * (owned by another change). Contract: script "card-to-pr-risk-check", output
 * { needsArchGate: boolean, reasons: string[] }.
 */
import type { ScriptHandler } from "../../script/registry.js";
import { isSensitivePath } from "../../report/risk-score.js";

/** The slice of `outputs.plan` this gate reads — plan owns the rest. */
export interface PlanOutput {
  needsArchGate?: boolean;
  files?: string[];
  dataChanges?: unknown[];
}

export interface RiskCheckOutput {
  needsArchGate: boolean;
  reasons: string[];
}

export const makeRiskCheck = (): ScriptHandler => async (ctx) => {
  const plan = (ctx.outputs.plan ?? {}) as PlanOutput;
  const reasons: string[] = [];

  if (plan.needsArchGate === true) reasons.push("self-assessed");
  for (const file of plan.files ?? []) {
    if (isSensitivePath(file)) reasons.push(`sensitive path: ${file}`);
  }
  if ((plan.dataChanges?.length ?? 0) > 0) reasons.push("data changes");

  return { needsArchGate: reasons.length > 0, reasons } satisfies RiskCheckOutput;
};
