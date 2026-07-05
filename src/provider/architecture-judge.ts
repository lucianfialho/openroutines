/**
 * Architecture-judge composite provider (F4 #185, D9)
 *
 * The `gate_plan` state's provider: Opus judges the plan adversarially
 * (architecture A/B/C, raizes-architecture-principles, scope vs. card) and
 * returns {verdict, corrections[], escalate}. Opus is the apex — its verdict is
 * FINAL. `escalate` is now an informational flag (the plan is ambiguous/high
 * risk), no longer a handoff to a stronger model.
 *
 * Anti-bypass: the response's reported `model` must match the model actually
 * requested, or the call is rejected (no silently downgraded verdict ever
 * governs the architecture gate).
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

export interface ArchitectureJudgeConfig {
  /** Billed API creds — OPTIONAL (Bloco 2): absent means the CLI-first inner runs. */
  claudeApi?: { apiKey?: string; baseURL?: string };
  /** Judge model (from the state's `model:`); default claude-opus-4-8. */
  model?: string;
  /** Builds the per-model inner adapter (registry injects CLI-first; default: makeClaudeProvider). */
  makeInnerProvider?: (config: { apiKey?: string; baseURL?: string; model: string }) => ProviderAdapter;
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
  const makeInner =
    config.makeInnerProvider ??
    ((c: { apiKey?: string; baseURL?: string; model: string }) => {
      if (!c.apiKey) throw new Error("architecture-judge: no makeInnerProvider and no claudeApi.apiKey");
      return makeClaudeProvider({ apiKey: c.apiKey, baseURL: c.baseURL, model: c.model });
    });
  const primary = makeInner({ ...config.claudeApi, model });

  /**
   * One judge call with the anti-bypass check: the response's reported model
   * must be the requested one — or a versioned alias of it (the API echoes
   * e.g. "claude-opus-4-8-20260101" for "claude-opus-4-8"). A DIFFERENT model
   * never judges architecture.
   */
  const completeChecked = (
    adapter: ProviderAdapter,
    expectedModel: string,
    request: CompletionRequest
  ): Effect.Effect<CompletionResponse, Error> =>
    adapter.complete(request).pipe(
      Effect.flatMap((resp) =>
        resp.model === expectedModel || resp.model.startsWith(`${expectedModel}-`)
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

      // Opus is the apex: its verdict is final (no escalation). Still parse +
      // validate here so a malformed verdict fails loudly instead of reaching
      // the runner as a silent pass.
      yield* Effect.try({
        try: (): ArchitectureVerdict => {
          const parsed = extractOutput(opusResponse.content);
          validate(parsed, VERDICT_SCHEMA);
          return parsed as ArchitectureVerdict;
        },
        catch: (err) =>
          new Error(`architecture-judge: invalid opus verdict — ${err instanceof Error ? err.message : String(err)}`),
      });

      return opusResponse;
    });

  return { complete };
};
