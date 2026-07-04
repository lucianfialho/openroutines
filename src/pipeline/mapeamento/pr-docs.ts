/**
 * card-mapeamento / pr_docs (F5 #162)
 *
 * Deliver the profile as a DOCS-ONLY PR: stamp the header date, stage only
 * docs/, ENFORCE the docs-only invariant (abort on any staged/committed path
 * escaping docs/**), commit, push the `openroutines/mapeamento-<repo>-<data>`
 * branch, open the PR against the repo's integration branch (reusing the F3
 * GitHub connector), and move the card to Review.
 *
 * The docs-only guarantee (criterion 4) is enforced HERE, deterministically —
 * not by trusting varredura's Write allowlist. Each external effect is
 * idempotent via the action ledger (pr.ts's pattern): a crash + resume never
 * double-opens the PR (git push of an already-pushed branch is a no-op, PR
 * creation checks getOpenPrByBranch first, and the card move is idempotent).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import { runIdempotent } from "../../persistence/idempotent-action.js";
import { resolveGithub, defaultRunGit, type MapeamentoDeps } from "./index.js";
import { today } from "./preparacao.js";
import type { MapeamentoPreparacaoOutput } from "./preparacao.js";
import type { VarreduraOutput } from "./varredura.js";
import type { CapturaVisualOutput } from "./captura-visual.js";

export interface PrDocsOutput {
  prUrl: string;
  changedFiles: string[];
}

const PROFILE_PATH = "docs/REPO-PROFILE.md";

/**
 * Stamp the profile header with today's date (point 6). Replaces the
 * `> Compilado em …` line; no-op when the file is absent (nothing to stamp).
 * Deterministic — the date lives here, not in the LLM's hands.
 */
export const stampProfileHeader = (worktreePath: string, date: string): boolean => {
  const path = join(worktreePath, PROFILE_PATH);
  if (!existsSync(path)) return false;
  const src = readFileSync(path, "utf-8");
  const stamped = src.replace(
    /^> Compilado em .*$/m,
    `> Compilado em ${date} pelo OpenRoutines · revalidado a cada PR que move ponto de entrada`
  );
  if (stamped !== src) writeFileSync(path, stamped);
  return true;
};

const buildPrBody = (
  slug: string,
  date: string,
  varredura: VarreduraOutput,
  captura: CapturaVisualOutput | undefined
): string =>
  [
    `Repo Profile de \`${slug}\` compilado pelo OpenRoutines em ${date}.`,
    "",
    `- Núcleo auditável: ${varredura.coreSectionsComplete ? "completo" : "INCOMPLETO"}`,
    `- Exemplares (D31): ${varredura.exemplars.length} (${varredura.exemplars.map((e) => e.changeShape).join(", ") || "—"})`,
    `- Rotas douradas: ${varredura.goldenRoutes.length}`,
    captura
      ? `- Perfil visual: ${captura.screenshots.length} screenshot(s)${captura.readmeWritten ? " + README" : ""}`
      : `- Perfil visual: N/A (repo sem front-end)`,
    "",
    "_PR restrito a `docs/**` — cards de mapeamento nunca viram código de feature._",
  ].join("\n");

export const makePrDocs = (deps: MapeamentoDeps): ScriptHandler => async (ctx) => {
  const prep = ctx.outputs.preparacao as MapeamentoPreparacaoOutput;
  const varredura = ctx.outputs.varredura as VarreduraOutput;
  const captura = ctx.outputs.captura_visual as CapturaVisualOutput | undefined;
  const { repo, worktree, baseSha } = prep;
  const branch = worktree.branch;
  const date = today();

  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
  const github = resolveGithub(deps, repo.githubRepo);
  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);

  // Header stamp + stage ONLY docs/ (never `git add -A`).
  stampProfileHeader(worktree.path, date);
  await runGit(["add", "docs"], worktree.path);

  // Commit only if something is staged (a crash-resume re-enters with the work
  // already committed → nothing staged → skip, then push is a no-op).
  const { stdout: staged } = await runGit(["diff", "--cached", "--name-only"], worktree.path);
  if (staged.split("\n").filter(Boolean).length > 0) {
    await runGit(
      [
        "-c", "user.name=OpenRoutines Bot",
        "-c", "user.email=bot@openroutines.local",
        "commit", "-m", `docs: REPO-PROFILE ${repo.slug} (OpenRoutines mapeamento ${date})`,
      ],
      worktree.path
    );
  }

  // The committed docs diff (stable across resume, unlike --cached which empties
  // after commit). SCOPE INVARIANT: every changed path must live under docs/**.
  const { stdout: diff } = await runGit(["diff", "--name-only", baseSha, "HEAD"], worktree.path);
  const changedFiles = diff.split("\n").filter(Boolean);
  const outside = changedFiles.filter((f) => !f.startsWith("docs/"));
  if (outside.length > 0) {
    throw new Error(
      `card-mapeamento pr_docs: refusing to open a PR touching non-docs files: ${outside.join(", ")}`
    );
  }

  await runIdempotent(deps.ledger, { executionId: ctx.executionId, stateId: "pr_docs", actionKey: "git:push" }, async () => {
    // Already-pushed branch → git no-op, safe on resume even without the ledger.
    await runGit(["push", "-u", "origin", branch], worktree.path);
    return {};
  });

  const prResult = await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "pr_docs", actionKey: "pr:create" },
    async () => {
      const title = `docs: Repo Profile — ${repo.slug} (OpenRoutines mapeamento)`;
      const body = buildPrBody(repo.slug, date, varredura, captura);
      // Branch-scoped existing-PR check first, so a resume never double-creates.
      const existing = await Effect.runPromise(github.getOpenPrByBranch(branch));
      const url = existing
        ? existing.url
        : (await Effect.runPromise(github.createPullRequest(branch, title, body, repo.baseBranch))).pr.url;
      return { externalRef: url };
    }
  );
  const prUrl = prResult.externalRef ?? "";

  await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "pr_docs", actionKey: "card:handoff" },
    async () => {
      const ts = deps.taskSourceFor(sourceId);
      if (ts) {
        await Effect.runPromise(ts.moveTo(taskId, "review"));
        await Effect.runPromise(ts.comment(taskId, `📄 [Mapeamento] Repo Profile de ${repo.slug} — PR de docs: ${prUrl}`));
      }
      return { externalRef: prUrl };
    }
  );

  return { prUrl, changedFiles } satisfies PrDocsOutput as unknown as Record<string, unknown>;
};
