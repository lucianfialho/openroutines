/**
 * Architecture-judge composite provider (F4 #185, D9)
 *
 * The `gate_plano` state's provider: Opus judges the plan adversarially
 * (architecture A/B/C, raizes-architecture-principles, scope vs. card) and
 * returns {verdict, corrections[], escalate}. Unlike security-judge
 * (independent verification + divergence check), this is a SEQUENTIAL
 * HANDOFF: escalate:true triggers exactly one Fable call with the SAME
 * original request — Fable never sees Opus's verdict (isolation by
 * construction: the second call is built from the untouched incoming
 * `request`, not from Opus's response) — and Fable's response becomes the
 * final one. escalate is meant for an ambiguous/high-risk/unprecedented
 * decision, never as a way to avoid judging (prompt-level contract, not
 * enforced here).
 *
 * Anti-bypass: same as security-judge — the response's reported `model` must
 * match the model actually requested, or the call is rejected (no silently
 * downgraded verdict ever governs the architecture gate).
 */
import { Effect } from "effect";
import type { CompletionRequest, CompletionResponse } from "./types.js";
import type { ProviderAdapter } from "./registry.js";
import { makeClaudeProvider } from "./claude.js";
import { extractOutput } from "../engine/output.js";
import { validate, type JsonSchema } from "../engine/schema-validate.js";

export interface ArchitectureVerdict {
  verdict: "aprovado" | "refutado";
  corrections: string[];
  escalate: boolean;
}

export const DEFAULT_JUDGE_MODEL = "claude-opus-4-8";
export const DEFAULT_SECOND_JUDGE_MODEL = "claude-fable-5";

export interface ArchitectureJudgeConfig {
  claudeApi: { apiKey: string; baseURL?: string };
  /** Primary judge model (from the state's `model:`); default claude-opus-4-8. */
  model?: string;
  /** Escalation judge model; default claude-fable-5. */
  secondJudgeModel?: string;
  /** Test seam — builds the per-model inner adapter (default: makeClaudeProvider). */
  makeInnerProvider?: (config: { apiKey: string; baseURL?: string; model: string }) => ProviderAdapter;
}

const VERDICT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["verdict", "corrections", "escalate"],
  properties: {
    verdict: { enum: ["aprovado", "refutado"] },
    corrections: { type: "array", items: { type: "string" } },
    escalate: { type: "boolean" },
  },
};

export const makeArchitectureJudgeProvider = (config: ArchitectureJudgeConfig): ProviderAdapter => {
  const model = config.model ?? DEFAULT_JUDGE_MODEL;
  const secondModel = config.secondJudgeModel ?? DEFAULT_SECOND_JUDGE_MODEL;
  const makeInner = config.makeInnerProvider ?? makeClaudeProvider;
  const primary = makeInner({ ...config.claudeApi, model });
  const second = makeInner({ ...config.claudeApi, model: secondModel });

  /**
   * One judge call with the anti-bypass check: the response's reported model
   * must be EXACTLY the requested one — no fallback model ever judges
   * architecture.
   */
  const completeChecked = (
    adapter: ProviderAdapter,
    expectedModel: string,
    request: CompletionRequest
  ): Effect.Effect<CompletionResponse, Error> =>
    adapter.complete(request).pipe(
      Effect.flatMap((resp) =>
        resp.model === expectedModel
          ? Effect.succeed(resp)
          : Effect.fail(
              new Error(
                `architecture-judge: model mismatch — requested "${expectedModel}" but "${resp.model}" answered; verdict rejected (no fallback model is accepted for the architecture gate)`
              )
            )
      )
    );

  const complete = (request: CompletionRequest): Effect.Effect<CompletionResponse, Error> =>
    Effect.gen(function* () {
      const opusResponse = yield* completeChecked(primary, model, request);

      // Parsed only to read `escalate` — the runner independently validates
      // whichever response (Opus or Fable) ends up as the final output
      // against gate-plano.schema.json. A verdict that fails to parse/validate
      // here must still fail loudly, never silently default to "no escalation".
      const verdict = yield* Effect.try({
        try: (): ArchitectureVerdict => {
          const parsed = extractOutput(opusResponse.content);
          validate(parsed, VERDICT_SCHEMA);
          return parsed as ArchitectureVerdict;
        },
        catch: (err) =>
          new Error(`architecture-judge: invalid opus verdict — ${err instanceof Error ? err.message : String(err)}`),
      });

      if (!verdict.escalate) return opusResponse;

      // Fable receives the ORIGINAL request untouched (same plano+card) — it
      // never sees Opus's verdict; isolation by construction, not prompting.
      return yield* completeChecked(second, secondModel, request);
    });

  return { complete };
};
