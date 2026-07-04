/**
 * Tactical memory across nights (F5 #166) — the cross-night search + promotion.
 *
 *  - findSimilarMergedCards / makeSimilarCards: deterministic (no embeddings)
 *    precedent lookup — merged PRs of the same repo ranked by label + title
 *    keyword overlap, adapted into the engine's SimilarCardsFn for the plan
 *    phase prompt.
 *  - promoteRecurringLearnings: promotes recurrent facts (freq ≥ 3, unpromoted)
 *    to the repo's docs/REPO-PROFILE.md via ONE docs PR per fact, then marks
 *    them promoted so a re-run never re-promotes. The cron that calls it is F6;
 *    the git/PR mechanics are the injected `openProfilePr` seam (connector).
 */

import type {
  ExecutionRepository,
  PrLinkRepository,
  RepoLearningRepository,
  RunStateRepository,
  TaskRepository,
} from "../persistence/types.js";
import type { PrecedentCard, SimilarCardsFn } from "../engine/learnings.js";

export interface SimilarCardsDeps {
  executions: Pick<ExecutionRepository, "findAll">;
  prLinks: Pick<PrLinkRepository, "findByTask">;
  tasks: Pick<TaskRepository, "findByKey">;
  /** Optional: supplies each precedent's PLAN summary. Absent → precedents carry title + PR link only. */
  runStates?: Pick<RunStateRepository, "findByExecution">;
}

// Tiny stop-word set (pt/en) so title-keyword overlap keys off meaningful terms,
// not glue words or the conventional-commit prefix. Deliberately small — this is
// a heuristic, not NLP (issue: no embeddings/semantics by design).
const STOP = new Set([
  "the", "and", "for", "with", "que", "com", "para", "dos", "das", "uma", "add", "fix", "feat", "bug",
]);

const keywords = (title: string): Set<string> =>
  new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  );

/** Labels weigh more than title keywords in the overlap score. */
const LABEL_WEIGHT = 3;

/**
 * Up to `n` merged cards of `repo` most similar to `card`, ranked by
 * label-overlap * LABEL_WEIGHT + title-keyword overlap. Deterministic tie-break:
 * higher score, then more recent, then title A→Z. Only genuinely similar
 * precedents (score > 0) qualify; no history / nothing similar → []. Uses only
 * existing repo reads (no pr_links "by repo" query): a bounded scan of completed
 * executions, each resolved to its merged PR + task.
 */
export const findSimilarMergedCards = async (
  card: { title: string; labels?: string[]; sourceId?: string; taskId?: string },
  repo: string,
  deps: SimilarCardsDeps,
  n = 2
): Promise<PrecedentCard[]> => {
  // ponytail: bounded linear scan over completed executions; introduce an
  // indexed pr_links.findMergedByRepo only if this ever gets hot.
  const completed = await deps.executions.findAll({ status: "completed", limit: 500 });
  const cardLabels = new Set((card.labels ?? []).map((l) => l.toLowerCase()));
  const cardKw = keywords(card.title);

  const seen = new Set<string>();
  const scored: Array<{ card: PrecedentCard; score: number; at: number }> = [];

  for (const exec of completed) {
    if (!exec.sourceId || !exec.taskId) continue;
    const taskKey = `${exec.sourceId}|${exec.taskId}`;
    if (seen.has(taskKey)) continue; // one entry per card even across rework rounds
    // Never inject the current card as its own precedent.
    if (card.sourceId && card.taskId && exec.sourceId === card.sourceId && exec.taskId === card.taskId) {
      seen.add(taskKey);
      continue;
    }
    const links = await deps.prLinks.findByTask(exec.sourceId, exec.taskId);
    const merged = links.find((l) => l.repo === repo && l.status === "merged");
    if (!merged) continue;
    const task = await deps.tasks.findByKey(exec.sourceId, exec.taskId);
    const title = task?.title ?? "";
    if (!title) continue; // can't rank or inject a card without a title
    seen.add(taskKey);

    const labels = task?.labels ?? [];
    const labelOverlap = labels.filter((l) => cardLabels.has(l.toLowerCase())).length;
    const titleKw = keywords(title);
    const kwOverlap = [...titleKw].filter((w) => cardKw.has(w)).length;
    const score = labelOverlap * LABEL_WEIGHT + kwOverlap;
    if (score <= 0) continue; // only genuinely similar precedents

    const summary = deps.runStates ? await planSummary(deps.runStates, exec.id) : undefined;
    const prUrl = merged.prNumber ? `https://github.com/${repo}/pull/${merged.prNumber}` : "";
    scored.push({ card: { title, prUrl, summary }, score, at: exec.startedAt?.getTime() ?? 0 });
  }

  scored.sort((a, b) => b.score - a.score || b.at - a.at || a.card.title.localeCompare(b.card.title));
  return scored.slice(0, n).map((s) => s.card);
};

const planSummary = async (
  runStates: Pick<RunStateRepository, "findByExecution">,
  executionId: string
): Promise<string | undefined> => {
  try {
    const states = await runStates.findByExecution(executionId);
    const plano = states.find((s) => s.stateId === "plano");
    const summary = (plano?.output as { summary?: unknown } | undefined)?.summary;
    return typeof summary === "string" && summary.length > 0 ? summary : undefined;
  } catch {
    return undefined; // best-effort flavor; a precedent still carries title + link
  }
};

/**
 * Adapt findSimilarMergedCards into the engine's SimilarCardsFn: pull the
 * current card's own labels (for the overlap score) from the task snapshot via
 * the phase inputs' source_id/task_id.
 */
export const makeSimilarCards = (deps: SimilarCardsDeps): SimilarCardsFn => async (repo, inputs) => {
  const sourceId = typeof inputs.source_id === "string" ? inputs.source_id : undefined;
  const taskId = typeof inputs.task_id === "string" ? inputs.task_id : undefined;
  const title = typeof inputs.title === "string" ? inputs.title : "";
  let labels: string[] = [];
  if (sourceId && taskId) {
    const self = await deps.tasks.findByKey(sourceId, taskId);
    labels = self?.labels ?? [];
  }
  return findSimilarMergedCards({ title, labels, sourceId, taskId }, repo, deps, 2);
};

// ---- Promotion to the persistent Repo Profile ---------------------------------

export type ProfileSection = "Instruções para Agentes" | "Gotchas";

/** escopo → REPO-PROFILE.md section. "gotcha" → Gotchas; everything else (convenção/…) → Instruções para Agentes. */
export const mapEscopoToSection = (escopo?: string): ProfileSection => {
  const e = (escopo ?? "").trim().toLowerCase();
  return e === "gotcha" || e === "gotchas" ? "Gotchas" : "Instruções para Agentes";
};

export interface OpenProfilePrArgs {
  repo: string;
  section: ProfileSection;
  fato: string;
  evidencia?: string;
}

export interface PromoteDeps {
  repoLearnings: Pick<RepoLearningRepository, "findPromotable" | "markPromoted">;
  /**
   * Opens ONE docs PR that appends `fato` to `section` of the target repo's
   * docs/REPO-PROFILE.md — and touches ONLY that file. The git/clone/commit/PR
   * mechanics live in the connector wiring (F6 cron); here it's just a seam.
   */
  openProfilePr: (args: OpenProfilePrArgs) => Promise<{ url: string }>;
}

/**
 * Promote every recurrent fact (freq ≥ 3, not yet promoted) to its repo's
 * docs/REPO-PROFILE.md via one docs PR per fact, marking each promoted so a
 * later call never re-promotes it. Callable in isolation (the weekly cron is
 * F6). Returns the facts promoted per repo.
 */
export const promoteRecurringLearnings = async (
  deps: PromoteDeps
): Promise<Array<{ repo: string; promoted: string[] }>> => {
  const promotable = await deps.repoLearnings.findPromotable();
  const byRepo = new Map<string, string[]>();
  for (const learning of promotable) {
    if (!learning.id) continue;
    await deps.openProfilePr({
      repo: learning.repo,
      section: mapEscopoToSection(learning.escopo),
      fato: learning.fato,
      evidencia: learning.evidencia,
    });
    await deps.repoLearnings.markPromoted(learning.id);
    byRepo.set(learning.repo, [...(byRepo.get(learning.repo) ?? []), learning.fato]);
  }
  return [...byRepo.entries()].map(([repo, promoted]) => ({ repo, promoted }));
};
