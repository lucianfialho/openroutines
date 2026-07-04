/**
 * card-mapeamento / varredura (F5 #162)
 *
 * The docs survey: Sonnet 5 via claude-cli explores the repo and WRITES
 * docs/REPO-PROFILE.md (Write/Edit confined to docs/** by the phase allowlist),
 * filling the 16 template sections and detecting golden routes by a
 * framework heuristic described IN THE PROMPT (never hardcoded here — a new
 * framework is a prompt edit, not a code change).
 *
 * Two signals are mined DETERMINISTICALLY by the handler (not trusted to the
 * LLM), so they are unit-testable and criterion-5 has a real check:
 *   - exemplars[]: one commit SHA per distinct change-shape, from the last 200
 *     commits (git log + a path-based change-shape heuristic). Fed into the
 *     prompt so the LLM copies them into the "Exemplares (D31)" section, and
 *     returned in the output for the orchestrator.
 *   - hasFrontend: a front-end framework present in package.json — the gate the
 *     skill.yaml uses to decide whether captura_visual runs.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import { renderTemplate } from "../../engine/template.js";
import { extractOutput } from "../../engine/output.js";
import { validate, type JsonSchema } from "../../engine/schema-validate.js";
import { resolveCliProvider, SONNET_MODEL, defaultRunGit, type MapeamentoDeps } from "./index.js";
import type { MapeamentoPreparacaoOutput } from "./preparacao.js";

const PROMPT_PATH = ".gates/skills/card-mapeamento/prompts/varredura.md";
const SCHEMA_PATH = ".gates/skills/card-mapeamento/schemas/varredura.schema.json";
const TEMPLATE_PATH = "docs/openroutines-templates/REPO-PROFILE.template.md";

/**
 * varredura's Write/Edit are CONFINED to docs/** — this card never produces
 * feature code (02-FLUXO-TRELLO.md). These are Claude Code `--allowedTools`
 * patterns (bare names, `Bash(<cmd>:*)` prefixes, and path-scoped
 * `Write(...)/Edit(...)`). The allowlist is the FIRST layer; the docs-only
 * guarantee that criterion 4 checks is enforced deterministically at pr_docs
 * (it stages only docs/ and aborts on any escaping path), so a leaky allowlist
 * can never ship a non-docs file.
 */
export const VARREDURA_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(ls:*)",
  "Bash(raizes-docs:*)",
  "Bash(ctx7:*)",
  "Write(docs/**)",
  "Edit(docs/**)",
];

// ---- change-shape mining (deterministic, unit-tested) ----

export type ChangeShape = "migration" | "agent-tool" | "route" | "service" | "ui-component" | "test";
export interface Exemplar {
  sha: string;
  changeShape: ChangeShape;
}

// Commit-level importance: when a commit touches several kinds of file, the
// most meaningful shape wins (a "new route + its test" commit is a route).
const IMPORTANCE: readonly ChangeShape[] = ["migration", "agent-tool", "route", "service", "ui-component", "test"];

/**
 * Single change-shape of ONE file by path. "test" is checked FIRST so a
 * `foo.test.tsx` is a test, not a ui-component; migration next, then the
 * framework-directory conventions (routes/, app/**‍/route|page, pages/,
 * services/, components/, and finally any front-end file extension).
 */
export const fileShape = (file: string): ChangeShape | undefined => {
  const f = file.toLowerCase();
  if (/\.(test|spec)\.[tj]sx?$/.test(f) || /(^|\/)(__tests__|tests?)\//.test(f)) return "test";
  if (/(^|\/)(prisma\/migrations|migrations|drizzle)\//.test(f) || /\.sql$/.test(f)) return "migration";
  if (/(^|\/)(tools?|agents?)\//.test(f)) return "agent-tool";
  if (/(^|\/)routes?\//.test(f) || /(^|\/)app\/.*(page|route)\.[tj]sx?$/.test(f) || /(^|\/)pages\//.test(f)) return "route";
  if (/(^|\/)services?\//.test(f) || /\.service\.[tj]sx?$/.test(f)) return "service";
  if (/(^|\/)components?\//.test(f) || /\.(tsx|jsx|vue|svelte)$/.test(f)) return "ui-component";
  return undefined;
};

/** Dominant change-shape of a whole commit = highest-importance shape among its files. */
export const commitShape = (files: string[]): ChangeShape | undefined => {
  const shapes = new Set<ChangeShape>();
  for (const f of files) {
    const s = fileShape(f);
    if (s) shapes.add(s);
  }
  return IMPORTANCE.find((s) => shapes.has(s));
};

/** Parse `git log --name-only --format=%H` into commits (newest first). */
export const parseGitLog = (out: string): Array<{ sha: string; files: string[] }> => {
  const commits: Array<{ sha: string; files: string[] }> = [];
  let current: { sha: string; files: string[] } | undefined;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (/^[0-9a-f]{40}$/.test(line)) {
      current = { sha: line, files: [] };
      commits.push(current);
    } else if (line && current) {
      current.files.push(line);
    }
  }
  return commits;
};

/** One exemplar per distinct change-shape (newest commit wins), D31 caps at ~8. */
export const mineExemplars = (commits: Array<{ sha: string; files: string[] }>, max = 8): Exemplar[] => {
  const seen = new Set<ChangeShape>();
  const out: Exemplar[] = [];
  for (const c of commits) {
    const shape = commitShape(c.files);
    if (!shape || seen.has(shape)) continue;
    seen.add(shape);
    out.push({ sha: c.sha, changeShape: shape });
    if (out.length >= max) break;
  }
  return out;
};

// ---- front-end detection (deterministic, unit-tested) ----

const FRONTEND_DEPS = [
  "next", "react", "react-dom", "react-native", "expo", "vue", "nuxt", "@angular/core",
  "svelte", "@sveltejs/kit", "astro", "@remix-run/react", "remix", "solid-js", "preact",
  "vite", "@vitejs/plugin-react",
];

/** A front-end framework declared in package.json deps/devDeps gates captura_visual. */
export const detectFrontend = (pkg: unknown): boolean => {
  if (!pkg || typeof pkg !== "object") return false;
  const p = pkg as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
  return FRONTEND_DEPS.some((d) => Object.prototype.hasOwnProperty.call(deps, d));
};

const readJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined; // missing/unparseable package.json → no front-end
  }
};

// ---- handler ----

export interface VarreduraOutput {
  profile: Record<string, string>;
  coreSectionsComplete: boolean;
  goldenRoutes: string[];
  exemplars: Exemplar[];
  hasFrontend: boolean;
}

export const makeVarredura = (deps: MapeamentoDeps): ScriptHandler => async (ctx) => {
  const prep = ctx.outputs.preparacao as MapeamentoPreparacaoOutput;
  const workdir = prep.worktree.path;
  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);

  // Deterministic signals — computed by the handler, never trusted to the LLM.
  const { stdout: log } = await runGit(["log", "-200", "--no-merges", "--name-only", "--format=%H"], workdir);
  const exemplars = mineExemplars(parseGitLog(log));
  const hasFrontend = detectFrontend(readJsonFile(join(workdir, "package.json")));

  // LLM fills the template and writes docs/REPO-PROFILE.md. The template and the
  // mined exemplars are APPENDED (not {{placeholders}}) so a first pass never
  // renders a dangling tag and the injected content is verbatim.
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  let prompt = renderTemplate(readFileSync(PROMPT_PATH, "utf-8"), { inputs: ctx.inputs, outputs: ctx.outputs });
  prompt += `\n\n--- TEMPLATE REPO-PROFILE (preencha todas as seções e escreva em docs/REPO-PROFILE.md) ---\n${template}`;
  prompt +=
    `\n\n--- EXEMPLARES MINERADOS (um por change-shape — copie na seção "Exemplares (D31)") ---\n` +
    (exemplars.length > 0 ? exemplars.map((e) => `- ${e.sha} — ${e.changeShape}`).join("\n") : "(histórico vazio)");
  // Reprovado re-run: fold validacao's prior gaps into the survey so the second
  // pass actually addresses them.
  const prior = ctx.outputs.validacao as { passed?: boolean; issues?: string[] } | undefined;
  if (prior && prior.passed === false && prior.issues && prior.issues.length > 0) {
    prompt += `\n\n--- GAPS DA VALIDAÇÃO ANTERIOR (corrija estes pontos) ---\n- ${prior.issues.join("\n- ")}`;
  }

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchema;
  const provider = resolveCliProvider(deps, SONNET_MODEL);
  const resp = await Effect.runPromise(
    provider.complete({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: 8192,
      executionId: ctx.executionId,
      allowedTools: VARREDURA_ALLOWED_TOOLS,
      jsonSchema: schema as unknown as Record<string, unknown>,
      workdir,
    })
  );

  const llmOut = extractOutput(resp.content);
  validate(llmOut, schema); // throws on a malformed profile — better than delivering garbage
  const { profile, coreSectionsComplete, goldenRoutes } = llmOut as {
    profile: Record<string, string>;
    coreSectionsComplete: boolean;
    goldenRoutes: string[];
  };

  return { profile, coreSectionsComplete, goldenRoutes, exemplars, hasFrontend } satisfies VarreduraOutput as unknown as Record<string, unknown>;
};
