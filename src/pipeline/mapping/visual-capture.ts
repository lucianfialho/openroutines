/**
 * card-mapping / visual_capture (F5 #162)
 *
 * Runs ONLY when scan detected a front-end framework. The handler IS the
 * orchestrator of the sandbox: it REUSES src/orchestrator/compose-lifecycle.ts
 * (never reimplements it) — `up()` boots the repo's compose.openroutines.yml
 * health-gated, `down()` ALWAYS runs in `finally` because background processes
 * started inside a `kimi -p` die ~5s after it returns, so the agent can never
 * be trusted to keep the app up or tear it down.
 *
 * Kimi navigates each golden route via Playwright MCP, writing
 * docs/visual/NN-<tela>.png + docs/visual/README.md (Write confined to
 * docs/**). Output: {screenshots[], readmeWritten}.
 */
import { readFileSync } from "fs";
import { Effect } from "effect";
import { z } from "zod";
import type { ScriptHandler } from "../../script/registry.js";
import { extractOutput } from "../../engine/output.js";
import {
  up as composeUpDefault,
  down as composeDownDefault,
  DEFAULT_COMPOSE_FILE,
  DEFAULT_BASE_URL,
} from "../../orchestrator/compose-lifecycle.js";
import type { MappingDeps } from "./index.js";
import type { MappingPreparationOutput } from "./preparation.js";
import type { ScanOutput } from "./scan.js";

const PROMPT_PATH = ".gates/skills/card-mapping/prompts/visual-capture.md";

export interface VisualCaptureOutput {
  screenshots: string[];
  readmeWritten: boolean;
}

/** Untrusted Kimi agent JSON — both fields defaulted so a sparse reply never throws. */
const CapturaResponse = z.object({
  screenshots: z.array(z.string()).default([]),
  readmeWritten: z.boolean().default(false),
});

/**
 * The capture prompt interpolates runtime values (baseUrl, routes, worktree)
 * that are neither inputs nor outputs, so it uses plain string replacement
 * rather than renderTemplate (which only resolves inputs./output(s). paths) —
 * same reason card-to-pr/visual.ts builds its Kimi prompt inline.
 */
export const buildCapturaPrompt = (baseUrl: string, goldenRoutes: string[], worktreePath: string): string =>
  readFileSync(PROMPT_PATH, "utf-8")
    .replaceAll("{{baseUrl}}", baseUrl)
    .replaceAll(
      "{{goldenRoutes}}",
      goldenRoutes.length > 0 ? goldenRoutes.join(", ") : "(nenhuma rota dourada declarada — capture a home)"
    )
    .replaceAll("{{worktreePath}}", worktreePath);

export const makeVisualCapture = (deps: MappingDeps): ScriptHandler => async (ctx) => {
  const visual = deps.visual;
  if (!visual) throw new Error("card-mapping visual_capture reached but deps.visual is not configured");

  const prep = ctx.outputs.preparation as MappingPreparationOutput;
  const scan = ctx.outputs.scan as ScanOutput;
  const worktreePath = prep.worktree.path;
  const goldenRoutes = scan.goldenRoutes ?? [];
  const composeUp = visual.composeUp ?? composeUpDefault;
  const composeDown = visual.composeDown ?? composeDownDefault;
  const composeFile = visual.composeFile ?? DEFAULT_COMPOSE_FILE;
  const baseUrl = visual.baseUrl ?? DEFAULT_BASE_URL;

  let output: VisualCaptureOutput = { screenshots: [], readmeWritten: false };
  try {
    const handle = await composeUp({ worktreePath, executionId: ctx.executionId, composeFile, baseUrl });
    const resp = await Effect.runPromise(
      visual.agentProvider.complete({
        prompt: buildCapturaPrompt(handle.baseUrl, goldenRoutes, worktreePath),
        workdir: worktreePath,
        executionId: ctx.executionId,
      })
    );
    const parsed = CapturaResponse.parse(extractOutput(resp.content));
    output = { screenshots: parsed.screenshots, readmeWritten: parsed.readmeWritten };
  } finally {
    // down() ALWAYS runs; its error is swallowed so it never masks a phase
    // failure already propagating (compose-lifecycle's documented contract).
    await composeDown({ worktreePath, executionId: ctx.executionId, composeFile }).catch(() => undefined);
  }

  return output as unknown as Record<string, unknown>;
};
