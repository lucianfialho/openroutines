/**
 * card-to-pr / rework_preparation + rework_question (F4 #157, D24)
 *
 * rework_preparation (script): recreate a worktree from the PR branch's REMOTE
 * head (detached, no new branch), guard against human commits since the
 * agent's last push (abort + ask for direction — NEVER overwrite), and build
 * the delimited fix-list from the PR's inline review comments.
 *
 * rework_question (script): when the rework agent flags the feedback as
 * ambiguous, the ORCHESTRATOR posts its question on the PR thread (D13: only
 * the orchestrator touches the remote) and the flow ends without counting a
 * rework round.
 */
import { existsSync } from "fs";
import { join } from "path";
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import { runIdempotent } from "../../persistence/idempotent-action.js";
import { makeGitHubConnector } from "../../connector/github.js";
import { resolveRepo, resolveRepoBySlug } from "../../repo-registry/registry.js";
import type { RepoConfig, RepoRegistry } from "../../repo-registry/schema.js";
import { getOrCreateBaseline } from "../../verify/baseline.js";
import type { VerifyResults } from "../../verify/run-commands.js";
import { ensureIgnoreScripts } from "../../security/supply-chain-guard.js";
import { buildFixList, type FixListComment } from "../../review/build-fix-list.js";
import { defaultRunGit, type CardToPrDeps } from "./index.js";
import type { PreparationOutput } from "./preparation.js";

/**
 * Default agent commit identity — the values git-worktree-tools' git_commit
 * flow configures in worktrees. A commit whose author name AND email both
 * fall outside this set is a human commit. Override via deps.agentGitAuthors.
 */
export const DEFAULT_AGENT_GIT_AUTHORS = ["OpenRoutines Bot", "openroutines@bot.local"];

/** Field-compatible with PreparationOutput where verify/pr read it (worktree/baseSha/baselineResults/repo). */
export interface ReworkPreparationOutput {
  aborted: boolean;
  abortReason?: "commit-humano" | "sem-last-agent-sha" | "pr-nao-aberto";
  prNumber?: number;
  /** Logins whose latest review is CHANGES_REQUESTED — pr.ts re-requests from them. */
  reviewers?: string[];
  fixList?: string;
  worktree?: { path: string; branch: string };
  baseSha?: string;
  baselineResults?: VerifyResults | null;
  repo?: PreparationOutput["repo"];
}

const slugifyTaskId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

const toRepoOutput = (repoConfig: RepoConfig, slug: string): PreparationOutput["repo"] => ({
  githubRepo: repoConfig.githubRepo,
  baseBranch: repoConfig.baseBranch,
  clonePath: repoConfig.clonePath,
  slug,
  verify: repoConfig.verify,
});

const findRegistrySlug = (registry: RepoRegistry, config: RepoConfig): string | undefined => {
  for (const [key, candidate] of Object.entries(registry.repos)) {
    if (candidate === config) return key;
  }
  return undefined;
};

/**
 * Parse `git log --format=%an%n%ae` output (name/email line pairs) and return
 * the authors that are NOT the agent — a commit is agent-authored when its
 * name OR email matches the configured identity (tolerates config drift on
 * one of the two without ever mistaking a human for the bot).
 */
export const findHumanAuthors = (gitLogOutput: string, agentAuthors: string[]): string[] => {
  const lines = gitLogOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  const humans: string[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const name = lines[i];
    const email = lines[i + 1] ?? "";
    if (!agentAuthors.includes(name) && !agentAuthors.includes(email)) {
      humans.push(`${name} <${email}>`);
    }
  }
  return humans;
};

export const makeReworkPreparation = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);
  const repoField = String(ctx.inputs.repo);
  const branch = String(ctx.inputs.branch);
  const prNumber = Number(ctx.inputs.prNumber);
  const nightId = typeof ctx.inputs.night_id === "string" && ctx.inputs.night_id ? ctx.inputs.night_id : undefined;

  const repoConfig = resolveRepoBySlug(deps.registry, repoField) ?? resolveRepo(deps.registry, repoField);
  if (!repoConfig) {
    // A pr_link's repo slug came from the registry at PR time — this only
    // happens if repos.yaml lost the entry since. Fail fast, don't guess.
    throw new Error(`rework: repo '${repoField}' not in repos.yaml`);
  }
  const slug = findRegistrySlug(deps.registry, repoConfig) ?? repoField;
  const repoOut = toRepoOutput(repoConfig, slug);

  const github = (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo: repoConfig.githubRepo });

  // The poller marked this PR changes_requested, but the human may have merged/
  // closed it since — never rework a PR that is no longer open.
  const snapshot = await Effect.runPromise(github.listPullRequestReviews(prNumber));
  if (snapshot.prState !== "OPEN") {
    await deps.prLinks.update(
      { sourceId, taskId, branch },
      { status: snapshot.prState === "MERGED" ? "merged" : "closed" }
    );
    return { aborted: true, abortReason: "pr-nao-aberto", prNumber } satisfies ReworkPreparationOutput;
  }

  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
  await runGit(["fetch"], repoConfig.clonePath);

  // Worktree of the PR's REMOTE head — detached (`origin/<branch>`, no -b), so
  // the local branch checked out in the original card worktree never conflicts.
  // executionId-suffixed: a crash-resume reuses it, a next-night round gets a
  // fresh one at the new remote head.
  // ponytail: old round dirs leak until a manual clean; `worktree prune` at
  // night start only clears deleted dirs. Max 2 rounds/card — acceptable.
  const worktreePath = join(deps.worktreeBase, `rework-${slugifyTaskId(taskId)}-${ctx.executionId.slice(0, 8)}`);
  if (!existsSync(worktreePath)) {
    await runGit(["worktree", "add", worktreePath, `origin/${branch}`], repoConfig.clonePath);
  } // else: crash-resume — reuse the worktree (and any local commits) already on disk.
  const agentAuthors = deps.agentGitAuthors ?? DEFAULT_AGENT_GIT_AUTHORS;
  // Same identity git-worktree-tools configures — keeps THIS round's commits
  // recognizable as agent commits by the NEXT round's guard.
  await runGit(["config", "user.name", agentAuthors[0]], worktreePath);
  await runGit(["config", "user.email", agentAuthors[1] ?? agentAuthors[0]], worktreePath);
  ensureIgnoreScripts({ worktree: worktreePath });

  // HUMAN-COMMIT GUARD (D24): any author since the agent's last pushed sha that
  // is not the agent aborts the phase — no rework_count increment, no code
  // touched, a pt-BR comment on the PR asking for direction.
  const links = await deps.prLinks.findByTask(sourceId, taskId);
  const link = links.find((l) => l.branch === branch);
  const lastAgentSha = link?.lastAgentCommitSha;

  const abortAskingForDirection = async (
    reason: "commit-humano" | "sem-last-agent-sha",
    detail: string
  ): Promise<Record<string, unknown>> => {
    await runIdempotent(
      deps.ledger,
      { executionId: ctx.executionId, stateId: ctx.stateId, actionKey: "pr:rework-abort-comment" },
      async () => {
        await Effect.runPromise(
          github.commentOnPullRequest(
            prNumber,
            `✋ [Retrabalho abortado] ${detail}\nPara não sobrescrever trabalho humano, o agente não tocou na branch. Como devo seguir? (responda aqui ou ajuste o PR e re-solicite o review)`
          )
        );
        return {};
      }
    );
    return { aborted: true, abortReason: reason, prNumber } satisfies ReworkPreparationOutput;
  };

  if (!lastAgentSha) {
    // Cannot prove which commits are the agent's — fail-safe: never touch the branch.
    return abortAskingForDirection("sem-last-agent-sha", "não há registro do último commit do agente neste PR.");
  }
  const { stdout: logOut } = await runGit(["log", `${lastAgentSha}..HEAD`, "--format=%an%n%ae"], worktreePath);
  const humans = findHumanAuthors(logOut, agentAuthors);
  if (humans.length > 0) {
    return abortAskingForDirection(
      "commit-humano",
      `há commit(s) humano(s) na branch desde o último push do agente (${humans.join(", ")}).`
    );
  }

  // Fix-list: review summaries (the CHANGES_REQUESTED bodies) first, then the
  // inline comments in the order GitHub returns them.
  const inline = await Effect.runPromise(github.listReviewComments(prNumber));
  const reviewBodies: FixListComment[] = snapshot.latestReviews
    .filter((r) => r.state === "CHANGES_REQUESTED" && r.body.trim() !== "")
    .map((r) => ({ file: "PR review", body: r.body, author: r.author }));
  const fixList = buildFixList([...reviewBodies, ...inline]);

  // Diff base for verify: the PR's merge-base with the integration branch, so
  // forbidden-path/isUI/dataChanges cover the WHOLE PR diff, not just this round.
  const { stdout: baseOut } = await runGit(["merge-base", "HEAD", `origin/${repoConfig.baseBranch}`], worktreePath);
  const baseSha = baseOut.trim();

  let baselineResults: VerifyResults | null = null;
  if (nightId && deps.pool) {
    const getBaseline = deps.getBaseline ?? getOrCreateBaseline;
    const baseline = await getBaseline({ pool: deps.pool }, { repo: slug, nightId, repoConfig });
    baselineResults = baseline.results;
  }

  return {
    aborted: false,
    prNumber,
    reviewers: snapshot.changesRequestedBy,
    fixList,
    worktree: { path: worktreePath, branch },
    baseSha,
    baselineResults,
    repo: repoOut,
  } satisfies ReworkPreparationOutput;
};

/** Ambiguous review feedback: the orchestrator posts the agent's question on the PR thread (D13). */
export const makeReworkQuestion = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const reworkPrep = ctx.outputs.rework_preparation as ReworkPreparationOutput;
  const rework = ctx.outputs.rework as { question?: string } | undefined;
  const question = rework?.question?.trim() || "o feedback do review não deu direção acionável — pode detalhar o que deve mudar?";

  const github = (deps.makeGithub ?? makeGitHubConnector)({
    token: deps.githubToken,
    repo: reworkPrep.repo!.githubRepo,
  });
  await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: ctx.stateId, actionKey: "pr:rework-question" },
    async () => {
      await Effect.runPromise(
        github.commentOnPullRequest(
          reworkPrep.prNumber!,
          `❓ [Retrabalho] ${question}\n\nO agente não alterou código nesta rodada; o card segue em Working e o retrabalho recomeça quando houver direção.`
        )
      );
      return {};
    }
  );
  // Deliberately NO rework_count increment — an asked question is not a spent round.
  return { asked: true, question };
};
