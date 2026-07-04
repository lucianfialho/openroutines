/**
 * card-research / survey_proposal (F5 #161)
 *
 * The read-only survey: Sonnet 5 via claude-cli explores the worktree +
 * raizes-docs/ctx7 and produces {summary, currentState, options[2-3],
 * dataChanges[], filesAffected[], phases[]}.
 *
 * The phase's whole point is LEAST PRIVILEGE: the CLI runs with an allowlist
 * that grants Read/Glob/Grep and a handful of read-only Bash prefixes and
 * NOTHING else — no Write/Edit/write_file/edit_file, no `npm install`. The
 * allowlist is passed on the request (request.allowedTools -> claude-cli's
 * `--allowedTools`); the CLI enforces the denial. This runs as a script (not a
 * `type: agent` state) precisely because the runner only wires a per-phase
 * allowlist for `fanout` lenses, never for a plain agent state.
 */
import { readFileSync } from "fs";
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import { renderTemplate } from "../../engine/template.js";
import { extractOutput } from "../../engine/output.js";
import { validate, type JsonSchema } from "../../engine/schema-validate.js";
import { resolveCliProvider, SONNET_MODEL, type ResearchDeps } from "./index.js";
import type { PreparationOutput } from "./preparation.js";

const PROMPT_PATH = ".gates/skills/card-research/prompts/survey.md";
const SCHEMA_PATH = ".gates/skills/card-research/schemas/survey.schema.json";

/**
 * Least-privilege CLI allowlist for the survey. These strings are Claude Code
 * `--allowedTools` patterns: bare tool names plus command-scoped `Bash(<cmd>:*)`
 * prefixes (the colon-glob form the CLI enforces). Deliberately EXCLUDES
 * Write/Edit/write_file/edit_file and every mutating Bash prefix — a survey
 * never mutates the product. Tune the exact prefix strings to the CLI's
 * contract; the invariant the phase guarantees is "no write tool is granted".
 */
export const LEVANTAMENTO_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(raizes-docs:*)",
  "Bash(ctx7:*)",
];

export interface SurveyOption {
  name: string;
  tradeoffs: string;
  recommended: boolean;
}

export interface SurveyDoc {
  summary: string;
  currentState: string;
  options: SurveyOption[];
  dataChanges: string[];
  filesAffected: string[];
  phases: string[];
}

export const makeSurvey = (deps: ResearchDeps): ScriptHandler => async (ctx) => {
  const provider = resolveCliProvider(deps, SONNET_MODEL);
  const prep = ctx.outputs.preparation as PreparationOutput | undefined;
  const workdir = prep?.worktree?.path;

  let prompt = renderTemplate(readFileSync(PROMPT_PATH, "utf-8"), {
    inputs: ctx.inputs,
    outputs: ctx.outputs,
  });
  // Refutado re-run: fold the judge's prior corrections into the survey so the
  // second pass actually addresses them. Built here (not as a template
  // placeholder) so the first pass has no dangling {{...}} to render blind.
  const prior = ctx.outputs.architecture_judgment as { verdict?: string; corrections?: string[] } | undefined;
  if (prior?.verdict === "refutado" && prior.corrections && prior.corrections.length > 0) {
    prompt += `\n\n--- CORREÇÕES DO JUÍZO ANTERIOR (revise a proposta para atendê-las) ---\n- ${prior.corrections.join("\n- ")}`;
  }

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchema;
  const resp = await Effect.runPromise(
    provider.complete({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: 8192,
      executionId: ctx.executionId,
      allowedTools: LEVANTAMENTO_ALLOWED_TOOLS,
      jsonSchema: schema as unknown as Record<string, unknown>,
      ...(workdir ? { workdir } : {}),
    })
  );

  const doc = extractOutput(resp.content);
  // Fail loudly on a malformed survey — a downstream judge/delivery on garbage
  // is worse than a failed execution the night coordinator can surface.
  validate(doc, schema);
  return doc as unknown as Record<string, unknown>;
};
