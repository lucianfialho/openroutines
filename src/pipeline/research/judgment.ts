/**
 * card-research / architecture_judgment (F5 #161)
 *
 * Opus 4.8 via claude-cli (D3: subscription/OAuth auth, no API billing) is the
 * architecture owner and the apex: it judges the survey against
 * raizes-architecture-principles + an explicit security lens and emits
 * {verdict, corrections[], securityOpinion{...}, escalateReason?}. Opus's
 * verdict is FINAL — "escalate" stays only as an ambiguity signal (there is no
 * stronger judge to hand off to). CLI-first, same seam as survey.ts — no
 * claude-api fallback (none of this pipeline's phases has one).
 *
 * Anti-bypass: the response's reported model must be the requested one (or a
 * versioned alias, M1) — via claude-cli this is a plumbing check (the CLI
 * echoing what it ran), not an independent server verification.
 */
import { readFileSync } from "fs";
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import type { CompletionResponse } from "../../provider/types.js";
import { renderTemplate } from "../../engine/template.js";
import { extractOutput } from "../../engine/output.js";
import { validate, type JsonSchema } from "../../engine/schema-validate.js";
import { resolveCliProvider, OPUS_MODEL, type ResearchDeps } from "./index.js";

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

/**
 * Run the judgment on Opus — the apex, so its verdict is final. Exported for
 * direct testing independent of the state machine.
 */
export const runPesquisaJudgment = async (deps: ResearchDeps, basePrompt: string): Promise<JudgmentVerdict> => {
  const opus = resolveCliProvider(deps, OPUS_MODEL);
  const opusResp = await Effect.runPromise(
    opus.complete({ messages: [{ role: "user", content: basePrompt }], temperature: 0.2, maxTokens: 4096 })
  );
  assertModel(opusResp, OPUS_MODEL);
  // "escalate" included: no stronger judge to hand off to, so Opus's parecer stands.
  return parseVerdict(opusResp.content);
};

export const makeJudgment = (deps: ResearchDeps): ScriptHandler => async (ctx) => {
  const basePrompt = renderTemplate(readFileSync(PROMPT_PATH, "utf-8"), {
    inputs: ctx.inputs,
    outputs: ctx.outputs,
  });
  const verdict = await runPesquisaJudgment(deps, basePrompt);
  return verdict as unknown as Record<string, unknown>;
};
