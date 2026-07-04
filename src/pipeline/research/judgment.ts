/**
 * card-research / architecture_judgment (F5 #161)
 *
 * Opus 4.8 (src/provider/claude.ts) is the architecture owner. It judges the
 * survey against raizes-architecture-principles + an explicit security lens and
 * emits {verdict, corrections[], securityOpinion{...}, escalateReason?}.
 *
 * Reuses the composite-judge PATTERN from architecture-judge/security-judge —
 * sequential handoff + model-echo anti-bypass — with ONE deliberate difference:
 * on verdict "escalate", the second call (Fable 5) SEES the Opus parecer in its
 * prompt. F4's adversarial review hides the prior verdict on purpose; research
 * is judgment ESCALATION, not blind adjudication, so Fable resolves the
 * ambiguity WITH Opus's reasoning in hand. Fable's verdict is final.
 *
 * Anti-bypass: each response's reported model must be the requested one (or a
 * versioned alias, M1) — a silently downgraded model never governs the gate.
 */
import { readFileSync } from "fs";
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import type { CompletionResponse } from "../../provider/types.js";
import { renderTemplate } from "../../engine/template.js";
import { extractOutput } from "../../engine/output.js";
import { validate, type JsonSchema } from "../../engine/schema-validate.js";
import { resolveApiProvider, OPUS_MODEL, FABLE_MODEL, type ResearchDeps } from "./index.js";

const PROMPT_PATH = ".gates/skills/card-research/prompts/judgment.md";
const SCHEMA_PATH = ".gates/skills/card-research/schemas/judgment.schema.json";

export interface SecurityOpinion {
  exposesNewSurface: boolean;
  notes: string;
}

export interface JudgmentVerdict {
  verdict: "aprovado" | "refutado" | "escalate";
  corrections: string[];
  /** Always present, even when aprovado — the schema requires it. */
  securityOpinion: SecurityOpinion;
  escalateReason?: string;
}

/** M1 anti-bypass: accept the exact model or a versioned alias ("<model>-YYYYMMDD"); reject anything else. */
const assertModel = (resp: CompletionResponse, expected: string): void => {
  if (resp.model === expected || resp.model.startsWith(`${expected}-`)) return;
  throw new Error(
    `card-research judgment: model mismatch — requested "${expected}" but "${resp.model}" answered; ` +
      `verdict rejected (no fallback model judges research architecture)`
  );
};

const parseVerdict = (content: string): JudgmentVerdict => {
  const parsed = extractOutput(content);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchema;
  validate(parsed, schema); // throws on a missing securityOpinion etc.
  return parsed as JudgmentVerdict;
};

/** Fable's escalation prompt = the Opus base prompt + the Opus parecer, verbatim, delimited. */
export const buildEscalationPrompt = (basePrompt: string, opusParecer: string): string =>
  `${basePrompt}\n\n` +
  `--- PARECER DO JUIZ PRIMÁRIO (Opus 4.8) ---\n${opusParecer}\n--- FIM DO PARECER ---\n\n` +
  `O juiz primário marcou este caso como AMBÍGUO/ALTO RISCO e ESCALOU para você (Fable 5). ` +
  `Reavalie a proposta CONSIDERANDO o parecer acima e emita o veredito FINAL no MESMO formato JSON ` +
  `(resolva a ambiguidade com "aprovado" ou "refutado" — não escale de novo).`;

/**
 * Run the judgment: Opus, then — only on "escalate" — Fable seeing the Opus
 * parecer. Exported for direct testing (2 distinct calls, parecer in the 2nd
 * prompt) independent of the state machine.
 */
export const runPesquisaJudgment = async (deps: ResearchDeps, basePrompt: string): Promise<JudgmentVerdict> => {
  const opus = resolveApiProvider(deps, OPUS_MODEL);
  const opusResp = await Effect.runPromise(
    opus.complete({ messages: [{ role: "user", content: basePrompt }], temperature: 0.2, maxTokens: 4096 })
  );
  assertModel(opusResp, OPUS_MODEL);
  const opusVerdict = parseVerdict(opusResp.content);
  if (opusVerdict.verdict !== "escalate") return opusVerdict;

  const fable = resolveApiProvider(deps, FABLE_MODEL);
  const fableResp = await Effect.runPromise(
    fable.complete({
      messages: [{ role: "user", content: buildEscalationPrompt(basePrompt, opusResp.content) }],
      temperature: 0.2,
      maxTokens: 4096,
    })
  );
  assertModel(fableResp, FABLE_MODEL);
  return parseVerdict(fableResp.content);
};

export const makeJudgment = (deps: ResearchDeps): ScriptHandler => async (ctx) => {
  const basePrompt = renderTemplate(readFileSync(PROMPT_PATH, "utf-8"), {
    inputs: ctx.inputs,
    outputs: ctx.outputs,
  });
  const verdict = await runPesquisaJudgment(deps, basePrompt);
  return verdict as unknown as Record<string, unknown>;
};
