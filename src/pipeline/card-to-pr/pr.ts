/**
 * card-to-pr / pr (F3 #146)
 *
 * Push, open the PR against the repo's integration branch, and hand the card
 * off to Review — 3 external effects, each idempotent BY CONSTRUCTION (not
 * only via the action ledger): a re-push of an already-pushed branch is a
 * git no-op, PR creation checks for an existing open PR by branch before
 * creating one, and the handoff's moveTo is itself idempotent.
 */
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import { runIdempotent } from "../../persistence/idempotent-action.js";
import { makeGitHubConnector } from "../../connector/github.js";
import { resolveRepo } from "../../repo-registry/registry.js";
import {
  calculateRiskScore,
  estimateReviewMinutes,
  isGreenLane,
  isSensitivePath,
  countLowConfidenceFindings,
  pickTopRiskyHunks,
  buildRiskSection,
  type RiskScoreInput,
  type RiskyHunk,
} from "../../report/risk-score.js";
import { defaultRunGit, type CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";
import type { ReworkPreparacaoOutput } from "./rework.js";
import type { VerifyOutput } from "./verify.js";
import type { ScriptContext } from "../../script/registry.js";

interface PlanoOutput {
  summary?: string;
  testStrategy?: string;
}

// The SAST issue (F4, parallel wave) will add these to VerifyOutput once it
// lands (03-PIPELINE-EXECUCAO.md "Verify" row:
// `{..., semgrepFindings[], dependencyAudit{new[],vulnerable[]}, dataChanges}`).
// Read loosely and default to 0/false until then — nothing here breaks if
// verify never emits them.
interface VerifyRiskExtras {
  dataChanges?: boolean;
  semgrepFindings?: Array<{ confidence?: number }>;
  dependencyAudit?: { new?: unknown[] };
}

const buildPrBody = (plano: PlanoOutput | undefined, verify: VerifyOutput | undefined, riskSection: string): string =>
  [
    riskSection,
    "",
    "<details>",
    "<summary>Ver evidência completa</summary>",
    "",
    "## Summary",
    plano?.summary ?? "(no plan summary available)",
    "",
    "## How to validate",
    plano?.testStrategy ?? "(no test strategy available)",
    "",
    "## Verify evidence",
    `known failures (pre-existing, not blocking): ${(verify?.knownFailures ?? []).join(", ") || "none"}`,
    "",
    "</details>",
  ].join("\n");

// ponytail: a regex pass over `git diff --unified=0`, not a full diff parser —
// good enough for the pilot's hunk-header shape. A rename whose old path
// happens to contain " b/" could misparse the file name (rare); upgrade to a
// real diff-parsing library if that ever bites.
const DIFF_GIT_HEADER_RE = /^diff --git a\/.+ b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Unified-diff hunks -> RiskyHunk[], using new-file line numbers (the PR branch's own sha — what the permalink points at). */
const parseRiskyHunks = (unifiedDiff: string): RiskyHunk[] => {
  const hunks: RiskyHunk[] = [];
  let file: string | undefined;
  for (const line of unifiedDiff.split("\n")) {
    const fileMatch = DIFF_GIT_HEADER_RE.exec(line);
    if (fileMatch) {
      file = fileMatch[1];
      continue;
    }
    if (!file) continue;
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (!hunkMatch) continue;
    const start = Number(hunkMatch[1]);
    const count = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
    const end = count > 0 ? start + count - 1 : start;
    hunks.push({
      file,
      startLine: start,
      endLine: end,
      reason: isSensitivePath(file) ? "toca caminho sensível (auth/payment/migration/webhook)" : `altera ${end - start + 1} linha(s)`,
    });
  }
  return hunks;
};

/** GREEN_LANE_ENABLED kill switch (env, default "true"): only the literal "false" disables it. */
const greenLaneEnabled = (): boolean => process.env.GREEN_LANE_ENABLED !== "false";

const alreadyLinked = async (
  deps: CardToPrDeps,
  sourceId: string,
  taskId: string,
  branch: string
): Promise<boolean> => {
  const links = await deps.prLinks.findByTask(sourceId, taskId);
  return links.some((l) => l.branch === branch && l.status === "open");
};

// ponytail: GitHub PR urls always end in the number (.../pull/123); parsing it
// back out avoids a second round-trip (github/prLinks) just to recover it on
// a ledger-skip resume. Upgrade to a prLinks re-query if a caller ever needs
// the exact number and the URL shape can no longer be trusted.
const prNumberFromUrl = (url: string): number | undefined => {
  const m = url.match(/(\d+)\/?$/);
  return m ? Number(m[1]) : undefined;
};

/**
 * Rework completion (F4 #157, D24): push the corrections to the SAME branch
 * (detached worktree HEAD -> refs/heads/<branch>, NEVER --force) and
 * re-request review — this path NEVER creates a PR. Completing a round
 * increments rework_count and stamps last_rework_night_id / the new
 * last_agent_commit_sha.
 *
 * M4: the ledger alone does NOT make this crash-safe — a true process crash
 * between the pr_links.update below and runIdempotent's own ledger.complete()
 * leaves the "pr:rework-complete" entry 'pending' forever (never 'done', never
 * 'failed'), so a resume re-invokes this same run() with the SAME newHeadSha
 * while pr_links already carries round 1's write. The reentrancy guard below
 * (lastAgentCommitSha === newHeadSha && reviewState === 're-requested') detects
 * exactly that "round 1 already wrote this" state and no-ops instead of
 * incrementing reworkCount a 2nd time.
 */
const prForRework = async (deps: CardToPrDeps, ctx: ScriptContext, reworkPrep: ReworkPreparacaoOutput) => {
  const worktree = reworkPrep.worktree!;
  const repo = reworkPrep.repo!;
  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);
  const branch = worktree.branch;
  const prNumber = reworkPrep.prNumber!;
  const nightId = typeof ctx.inputs.night_id === "string" && ctx.inputs.night_id ? ctx.inputs.night_id : undefined;

  const github = (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo: repo.githubRepo });
  const ts = deps.taskSourceFor(sourceId);
  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);

  await runIdempotent(deps.ledger, { executionId: ctx.executionId, stateId: "pr", actionKey: "git:push" }, async () => {
    // Fast-forward push of the detached rework HEAD onto the PR branch. No -u,
    // no --force (force-push is also denied in an earlier layer); an
    // already-pushed HEAD makes the re-push a git no-op.
    await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], worktree.path);
    return {};
  });

  const { stdout: headOut } = await runGit(["rev-parse", "HEAD"], worktree.path);
  const newHeadSha = headOut.trim();

  await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "pr", actionKey: "pr:rework-complete" },
    async () => {
      const link = (await deps.prLinks.findByTask(sourceId, taskId)).find((l) => l.branch === branch);
      // M4 reentrancy guard: round 1 already wrote this exact HEAD — a resume
      // after a crash here must not request review or increment again.
      if (link?.lastAgentCommitSha === newHeadSha && link.reviewState === "re-requested") {
        return {};
      }
      if ((reworkPrep.reviewers ?? []).length > 0) {
        await Effect.runPromise(github.requestReview(prNumber, reworkPrep.reviewers!));
      }
      await deps.prLinks.update(
        { sourceId, taskId, branch },
        {
          lastAgentCommitSha: newHeadSha,
          reviewState: "re-requested",
          reworkCount: (link?.reworkCount ?? 0) + 1,
          ...(nightId ? { lastReworkNightId: nightId } : {}),
        }
      );
      return {};
    }
  );

  const prUrl = `https://github.com/${repo.githubRepo}/pull/${prNumber}`;
  await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "pr", actionKey: "card:handoff" },
    async () => {
      if (ts) {
        await Effect.runPromise(ts.moveTo(taskId, "review"));
        await Effect.runPromise(ts.comment(taskId, `🔁 [Retrabalho] correções enviadas na mesma branch — review re-solicitado: ${prUrl}`));
      }
      return { externalRef: prUrl };
    }
  );

  return { prUrl, prNumber, rework: true };
};

export const makePr = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  // Rework flow (F4 #157): entered at rework_preparacao, so `preparacao` is
  // absent and `rework_preparacao` carries the worktree/repo — same branch
  // push + re-request review, never a new PR.
  const reworkPrep = ctx.outputs.rework_preparacao as ReworkPreparacaoOutput | undefined;
  if (reworkPrep) return prForRework(deps, ctx, reworkPrep);

  const preparacao = ctx.outputs.preparacao as PreparacaoOutput;
  const worktree = preparacao.worktree!;
  const repo = preparacao.repo!;
  // SECURITY: PR base is always the repo's configured integration branch,
  // never main/master (repo-registry/schema.ts already enforces this at
  // parse time — this is defense in depth, not the primary guarantee).
  if (repo.baseBranch === "main" || repo.baseBranch === "master") {
    throw new Error(`refusing to open a PR against '${repo.baseBranch}' — baseBranch must never be main/master`);
  }

  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);
  const title = String(ctx.inputs.title);
  const branch = worktree.branch;

  const github = (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo: repo.githubRepo });
  const ts = deps.taskSourceFor(sourceId);
  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);

  await runIdempotent(deps.ledger, { executionId: ctx.executionId, stateId: "pr", actionKey: "git:push" }, async () => {
    // An already-pushed branch makes this a git no-op — safe on resume even
    // without the ledger.
    await runGit(["push", "-u", "origin", branch], worktree.path);
    return {};
  });

  const plano = ctx.outputs.plano as PlanoOutput | undefined;
  const verify = ctx.outputs.verify as (VerifyOutput & VerifyRiskExtras) | undefined;

  // Risk radar (F4 #158, D29): computed once, right before the PR body is
  // assembled. The git calls below are read-only (diff/rev-parse) — safe to
  // redo on a crash-resume; only the pr_links write further down is guarded.
  const { stdout: changedOut } = await runGit(["diff", "--name-only", preparacao.baseSha!, "HEAD"], worktree.path);
  const changedFiles = changedOut.split("\n").filter(Boolean);
  const { stdout: unifiedDiff } = await runGit(["diff", "--unified=0", preparacao.baseSha!, "HEAD"], worktree.path);
  const { stdout: headShaOut } = await runGit(["rev-parse", "HEAD"], worktree.path);
  const headSha = headShaOut.trim();

  const riskInput: RiskScoreInput = {
    diffLoc: verify?.diffLoc ?? 0,
    dataChanges: Boolean(verify?.dataChanges),
    touchesAuthOrMoney: changedFiles.some(isSensitivePath),
    newDependencies: verify?.dependencyAudit?.new?.length ?? 0,
    lowConfidenceFindings: countLowConfidenceFindings(verify?.semgrepFindings),
    // H10: raw count, regardless of confidence — SemgrepFinding (sast.ts)
    // carries no `confidence` field, so lowConfidenceFindings above is always
    // 0 for semgrep and can never gate green lane on its own.
    semgrepFindingsCount: verify?.semgrepFindings?.length ?? 0,
    // No test-delta signal is wired anywhere yet (the red->green test-writer
    // phase between gate_plano/implementacao, 03-PIPELINE-EXECUCAO.md L187,
    // isn't in skill.yaml yet) — see openDecisions.
    testDelta: 0,
    // Fase 6 (validação visual) doesn't exist in skill.yaml yet — undefined
    // passes isGreenLane's gate, per the interface's own contract.
    visualConfidence: undefined,
    repoCritical: resolveRepo(deps.registry, repo.slug)?.critical ?? false,
  };
  const riskScoreValue = calculateRiskScore(riskInput);
  const greenLaneValue = isGreenLane(riskInput, { enabled: greenLaneEnabled() });
  const riskSection = buildRiskSection({
    repo: repo.githubRepo,
    sha: headSha,
    hunks: pickTopRiskyHunks(parseRiskyHunks(unifiedDiff)),
    minutes: estimateReviewMinutes(riskInput),
  });

  const prBody = buildPrBody(plano, verify, riskSection);

  const prResult = await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "pr", actionKey: "pr:create" },
    async () => {
      // Branch-scoped (server-side --head filter) so a busy repo's 30+ open PRs
      // can't hide this branch's PR and cause a duplicate create that gh rejects.
      const existing = await Effect.runPromise(github.getOpenPrByBranch(branch));
      const pr = existing ?? (await Effect.runPromise(github.createPullRequest(branch, title, prBody, repo.baseBranch))).pr;
      if (!(await alreadyLinked(deps, sourceId, taskId, branch))) {
        await deps.prLinks.create({
          sourceId,
          taskId,
          repo: repo.slug,
          prNumber: pr.number,
          branch,
          status: "open",
          // F4 #157: the rework human-commit guard diffs from the agent's last
          // pushed sha — record it from day one or round 1 can never run.
          lastAgentCommitSha: headSha,
          riskScore: riskScoreValue,
          greenLane: greenLaneValue,
        });
      }
      return { externalRef: pr.url };
    }
  );
  const prUrl = prResult.externalRef!;

  await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "pr", actionKey: "card:handoff" },
    async () => {
      if (ts) {
        await Effect.runPromise(ts.moveTo(taskId, "review"));
        // A duplicate comment on crash-resume is acceptable — the ledger is a
        // best-effort guard here, moveTo is the idempotent part.
        await Effect.runPromise(ts.comment(taskId, `👀 [Handoff] ${prUrl}`));
      }
      return { externalRef: prUrl };
    }
  );

  return { prUrl, prNumber: prNumberFromUrl(prUrl) };
};
