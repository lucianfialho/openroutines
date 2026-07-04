/**
 * card-to-pr / visual — visual validation phase (F5 #160)
 *
 * Fase 6 of the implementation pipeline, reached only when the adversarial
 * review approved AND the real diff is UI (`output.verify.isUI`). This handler
 * IS the orchestrator: it owns the sandbox lifetime (compose up/down), because
 * background processes started inside a `kimi -p`/`claude -p` die ~5s after the
 * agent returns — an agent can never be trusted to keep the app up across the
 * phase.
 *
 * Sequence (03-PIPELINE-EXECUCAO.md "Validação visual"):
 *  1. compose up (health-gated) — orchestrator.
 *  2. SSIM (deterministic, Playwright `toHaveScreenshot`) against the repo's
 *     golden routes. A regression here FAILS FAST with zero LLM spend.
 *  3. Kimi navigates agentically via Playwright MCP, capturing screenshots and
 *     console.error/warn + network failures, and judges EACH visual assertion
 *     item-by-item with a numeric confidence (never a holistic verdict — VLMs
 *     hallucinate 10-30% on a complex scene).
 *  4. Any assertion below the confidence threshold OR of kind "brand-fidelity"
 *     escalates to Sonnet vision (src/provider/claude.ts, real image blocks).
 *  5. On pass: screenshots attach to the card; the `pr` state fills the PR's
 *     "Visual" section from this output. On fail: back to implementacao (the
 *     skill.yaml edge caps it at one cycle).
 *
 * `down()` ALWAYS runs in `finally`, its error swallowed so it can never mask
 * the phase's own failure.
 */
import { Effect } from "effect";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { basename, join } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);
import type { ScriptHandler, ScriptContext } from "../../script/registry.js";
import type { ProviderAdapter } from "../../provider/registry.js";
import type { TaskSource } from "../../task-source/types.js";
import { extractOutput } from "../../engine/output.js";
import { up as composeUpDefault, down as composeDownDefault, DEFAULT_COMPOSE_FILE, DEFAULT_BASE_URL } from "../../orchestrator/compose-lifecycle.js";
import type { CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";

export interface VisualAssertionSpec {
  id: string;
  description: string;
  route?: string;
  /** "brand-fidelity" always escalates to Sonnet vision regardless of confidence. */
  kind?: string;
}

export interface SsimResult {
  route: string;
  score: number;
  regressed: boolean;
  baseline?: string;
}

export interface VisualAssertionResult {
  id: string;
  description: string;
  verdict: "pass" | "fail";
  confidence: number;
  judgedBy: "kimi" | "sonnet-vision";
  screenshot: string;
}

export interface VisualOutput {
  passed: boolean;
  assertions: VisualAssertionResult[];
  screenshots: string[];
  consoleErrors: string[];
  ssim: SsimResult[];
}

/** Untrusted Kimi agent JSON — every field defaulted so a sparse reply never throws. */
const KimiVisualResponse = z.object({
  assertions: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
        verdict: z.enum(["pass", "fail"]),
        confidence: z.number(),
        screenshot: z.string().optional(),
      })
    )
    .default([]),
  screenshots: z.array(z.string()).default([]),
  consoleErrors: z.array(z.string()).default([]),
  consoleWarnings: z.array(z.string()).default([]),
  networkFailures: z.array(z.string()).default([]),
});

/** Untrusted Sonnet-vision JSON. */
const VisionVerdict = z.object({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number(),
});

export interface VisualDeps {
  /** Kimi with Playwright MCP (the F1-registered "Kimi with MCP", not text-only). */
  agentProvider: ProviderAdapter;
  /** Sonnet vision (claude-api). Absent → escalation is skipped and the Kimi verdict stands (degraded). */
  visionProvider?: ProviderAdapter;
  composeUp?: typeof composeUpDefault;
  composeDown?: typeof composeDownDefault;
  /** Deterministic SSIM step; default shells out to `npx playwright test`. */
  runSsim?: (args: { worktreePath: string; baseUrl: string; goldenRoutes: string[] }) => Promise<SsimResult[]>;
  /** Reads the golden routes from the repo's docs/REPO-PROFILE.md; default parses the file. */
  readGoldenRoutes?: (worktreePath: string) => string[];
  /** Reads a screenshot to base64 for the vision call; default is an fs read. */
  readScreenshot?: (path: string) => string;
  /** Attaches screenshots to the card; default uploads each via the TaskSource. */
  attachScreenshots?: (taskId: string, screenshots: string[]) => Promise<void>;
  /** Confidence below this escalates to Sonnet vision (default 7). */
  confidenceThreshold?: number;
  composeFile?: string;
  baseUrl?: string;
}

// ---- Golden routes (docs/REPO-PROFILE.md "Rotas douradas" section, D6/D18) ----

/**
 * Extract route paths from the "Rotas douradas" section of a REPO-PROFILE.md.
 * Accepts markdown list items whose first `/…` or `` `/…` `` token is a route;
 * stops at the next `##` heading. Deliberately forgiving — a malformed profile
 * yields fewer routes, never an error (the phase still runs Kimi + assertions).
 */
export const parseGoldenRoutes = (markdown: string): string[] => {
  const lines = markdown.split("\n");
  const routes: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inSection = /rotas douradas/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const m = /(?:`|^|\s)(\/[A-Za-z0-9\-_/:.]*)/.exec(line.replace(/^[-*\d.\s]+/, " "));
    if (m) routes.push(m[1]);
  }
  return [...new Set(routes)];
};

const defaultReadGoldenRoutes = (worktreePath: string): string[] => {
  try {
    return parseGoldenRoutes(readFileSync(join(worktreePath, "docs/REPO-PROFILE.md"), "utf-8"));
  } catch {
    return []; // no profile yet (Mapping issue owns generating it) — SSIM simply checks nothing
  }
};

// ---- SSIM (Playwright toHaveScreenshot) ----

/** Playwright `--reporter=json` shape (only the fields we read). */
interface PwSuite {
  suites?: PwSuite[];
  specs?: Array<{ title: string; ok: boolean; tests?: Array<{ results?: Array<{ status?: string }> }> }>;
}

/**
 * Parse a Playwright JSON report into per-route SSIM results. A spec whose
 * title is the route and whose status is not "passed" is a visual regression.
 * Score is binary (Playwright's screenshot assertion is pass/fail, not a
 * continuous ratio) — 1.0 when it matched, 0.0 when it regressed.
 */
export const parseSsimReport = (report: unknown): SsimResult[] => {
  const results: SsimResult[] = [];
  const walk = (suite: PwSuite): void => {
    for (const spec of suite.specs ?? []) {
      const status = spec.tests?.[0]?.results?.[0]?.status;
      const regressed = spec.ok === false || (status !== undefined && status !== "passed");
      results.push({ route: spec.title, score: regressed ? 0 : 1, regressed });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  const root = report as { suites?: PwSuite[] };
  for (const suite of root.suites ?? []) walk(suite);
  return results;
};

/**
 * Default SSIM: template a spec that screenshots each golden route, run
 * `npx playwright test --reporter=json` in the worktree, parse the report.
 *
 * ponytail: this is real but CI-unrunnable glue — it depends on the target
 * repo's own playwright config (baseURL wiring) and on the baseline PNGs that
 * the Mapping pipeline (#162) writes under docs/visual/. Without a baseline,
 * `toHaveScreenshot` creates one and passes. Handler tests inject `runSsim`;
 * `parseSsimReport`/`parseGoldenRoutes` are unit-tested directly. Upgrade path:
 * derive the touched route from the diff and add it to the route list.
 */
const defaultRunSsim = async (args: { worktreePath: string; baseUrl: string; goldenRoutes: string[] }): Promise<SsimResult[]> => {
  if (args.goldenRoutes.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "or-ssim-"));
  const specPath = join(dir, "visual-regression.spec.ts");
  const spec =
    `import { test, expect } from "@playwright/test";\n` +
    args.goldenRoutes
      .map(
        (r) =>
          `test(${JSON.stringify(r)}, async ({ page }) => {\n` +
          `  await page.goto(${JSON.stringify(args.baseUrl + r)});\n` +
          `  await expect(page).toHaveScreenshot();\n});\n`
      )
      .join("");
  writeFileSync(specPath, spec);

  try {
    const { stdout } = await execFileAsync("npx", ["playwright", "test", "--reporter=json", specPath], {
      cwd: args.worktreePath,
      env: { ...process.env, PLAYWRIGHT_BASE_URL: args.baseUrl },
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseSsimReport(JSON.parse(stdout));
  } catch (err) {
    // Playwright exits non-zero when a screenshot mismatches — the JSON still
    // lands on stdout, so parse it rather than treating exit code as fatal.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) {
      try {
        return parseSsimReport(JSON.parse(stdout));
      } catch {
        /* fall through */
      }
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
};

// ---- Prompts ----

const buildKimiPrompt = (
  assertions: VisualAssertionSpec[],
  criteria: { title: string; description: string },
  baseUrl: string,
  shotDir: string
): string =>
  [
    `Você é um agente de validação visual. Abra a aplicação em ${baseUrl} via Playwright MCP.`,
    `Critérios de aceite do card: ${criteria.title}\n${criteria.description}`,
    ``,
    `Para CADA asserção visual abaixo: navegue até a rota relevante, capture um screenshot em`,
    `${shotDir}/<id>.png, e julgue individualmente (verdict "pass"|"fail") com um confidence`,
    `numérico de 0 a 10 (não emita um veredito holístico).`,
    ``,
    `Asserções:`,
    ...assertions.map((a) => `- id=${a.id}${a.route ? ` rota=${a.route}` : ""}: ${a.description}`),
    ``,
    `Capture também console.error, console.warn e falhas de rede durante a navegação.`,
    `Emita SÓ um JSON: {assertions:[{id,verdict,confidence,screenshot}], screenshots:[...],`,
    `consoleErrors:[...], consoleWarnings:[...], networkFailures:[...]}.`,
  ].join("\n");

const buildVisionPrompt = (assertion: VisualAssertionSpec, criteria: { title: string; description: string }): string =>
  [
    `Julgue esta única asserção visual olhando o screenshot anexado.`,
    `Card: ${criteria.title} — ${criteria.description}`,
    `Asserção (${assertion.id}): ${assertion.description}`,
    `Emita SÓ um JSON: {verdict:"pass"|"fail", confidence:<0-10>}.`,
  ].join("\n");

// ---- Handler ----

const readSpec = (ctx: ScriptContext): { preparacao: PreparacaoOutput; assertions: VisualAssertionSpec[] } => {
  // Rework flow (F4 #157) enters at rework_preparacao; both carry a
  // field-compatible worktree/repo, same as verify.ts / pr.ts read them.
  const preparacao = (ctx.outputs.preparacao ?? ctx.outputs.rework_preparacao) as PreparacaoOutput;
  const plano = ctx.outputs.plano as { visualAssertions?: VisualAssertionSpec[] } | undefined;
  return { preparacao, assertions: plano?.visualAssertions ?? [] };
};

export const makeVisual = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const visual = deps.visual;
  if (!visual) throw new Error("visual phase reached but deps.visual is not configured");

  const { preparacao, assertions } = readSpec(ctx);
  const worktreePath = preparacao.worktree!.path;
  const composeUp = visual.composeUp ?? composeUpDefault;
  const composeDown = visual.composeDown ?? composeDownDefault;
  const runSsim = visual.runSsim ?? defaultRunSsim;
  const readGoldenRoutes = visual.readGoldenRoutes ?? defaultReadGoldenRoutes;
  const readScreenshot = visual.readScreenshot ?? ((p: string) => readFileSync(p).toString("base64"));
  const threshold = visual.confidenceThreshold ?? 7;
  const composeFile = visual.composeFile ?? DEFAULT_COMPOSE_FILE;
  const baseUrl = visual.baseUrl ?? DEFAULT_BASE_URL;
  const criteria = { title: String(ctx.inputs.title ?? ""), description: String(ctx.inputs.description ?? "") };
  const shotDir = join(tmpdir(), "or-visual", ctx.executionId);

  let output: VisualOutput;
  try {
    const handle = await composeUp({ worktreePath, executionId: ctx.executionId, composeFile, baseUrl });

    // Step 2 — deterministic SSIM first. A regressed golden route fails the
    // whole phase WITHOUT touching any LLM provider (fail-fast).
    const ssim = await runSsim({ worktreePath, baseUrl: handle.baseUrl, goldenRoutes: readGoldenRoutes(worktreePath) });
    if (ssim.some((s) => s.regressed)) {
      output = { passed: false, assertions: [], screenshots: [], consoleErrors: [], ssim };
    } else {
      // Step 3 — Kimi navigates agentically and judges each assertion.
      const kimiRaw = await Effect.runPromise(
        visual.agentProvider.complete({
          prompt: buildKimiPrompt(assertions, criteria, handle.baseUrl, shotDir),
          workdir: worktreePath,
          executionId: ctx.executionId,
        })
      );
      const kimi = KimiVisualResponse.parse(extractOutput(kimiRaw.content));

      // Step 4 — escalate low-confidence / brand-fidelity assertions to Sonnet vision.
      const byId = new Map(assertions.map((a) => [a.id, a]));
      const results: VisualAssertionResult[] = [];
      for (const j of kimi.assertions) {
        const spec = byId.get(j.id);
        const screenshot = j.screenshot ?? `${shotDir}/${j.id}.png`;
        const needsVision = j.confidence < threshold || spec?.kind === "brand-fidelity";
        if (needsVision && visual.visionProvider) {
          const visionRaw = await Effect.runPromise(
            visual.visionProvider.complete({
              prompt: buildVisionPrompt(spec ?? { id: j.id, description: j.description ?? "" }, criteria),
              images: [{ base64: readScreenshot(screenshot), mediaType: "image/png" }],
            })
          );
          const v = VisionVerdict.parse(extractOutput(visionRaw.content));
          results.push({
            id: j.id,
            description: spec?.description ?? j.description ?? "",
            verdict: v.verdict,
            confidence: v.confidence,
            judgedBy: "sonnet-vision",
            screenshot,
          });
        } else {
          results.push({
            id: j.id,
            description: spec?.description ?? j.description ?? "",
            verdict: j.verdict,
            confidence: j.confidence,
            judgedBy: "kimi",
            screenshot,
          });
        }
      }

      // A page throwing console.error is not shippable UI — the PR evidence
      // line literally reads "0 console.error", so it gates `passed` alongside
      // every assertion passing. console.warn/network failures are surfaced as
      // evidence but do not gate.
      const passed = results.every((r) => r.verdict === "pass") && kimi.consoleErrors.length === 0;
      output = {
        passed,
        assertions: results,
        screenshots: kimi.screenshots,
        consoleErrors: kimi.consoleErrors,
        ssim,
      };
    }
  } finally {
    // down() ALWAYS runs; its error is swallowed so it never masks a phase
    // failure that is already propagating.
    await composeDown({ worktreePath, executionId: ctx.executionId, composeFile }).catch(() => undefined);
  }

  // On pass, attach the screenshots to the card (the PR's "Visual" section is
  // filled by the pr state from this output).
  if (output.passed && output.screenshots.length > 0) {
    const sourceId = String(ctx.inputs.source_id);
    const taskId = String(ctx.inputs.task_id);
    const ts = deps.taskSourceFor(sourceId);
    const attach = visual.attachScreenshots ?? defaultAttachScreenshots(ts, readScreenshot);
    await attach(taskId, output.screenshots);
  }

  return output as unknown as Record<string, unknown>;
};

/**
 * Default screenshot attach: upload each PNG to the card via the TaskSource's
 * attachArtifact (the F2 connector method).
 *
 * ponytail: TaskArtifact.content is a string and documents binary as out of
 * scope, so the bytes ride as a base64 body here — a faithful binary upload
 * needs a Buffer-capable TaskArtifact/connector method, which is out of scope
 * for #160 (it touches task-source/types.ts + trello.ts, owned elsewhere).
 * Tests inject `attachScreenshots` and never hit this.
 */
const defaultAttachScreenshots =
  (ts: TaskSource | undefined, readScreenshot: (path: string) => string) =>
  async (taskId: string, screenshots: string[]): Promise<void> => {
    if (!ts) return;
    for (const shot of screenshots) {
      await Effect.runPromise(
        ts.attachArtifact(taskId, { filename: basename(shot), content: readScreenshot(shot), mimeType: "image/png" })
      );
    }
  };
