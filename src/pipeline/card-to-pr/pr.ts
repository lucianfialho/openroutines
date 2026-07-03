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
import { defaultRunGit, type CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";
import type { VerifyOutput } from "./verify.js";

interface PlanoOutput {
  summary?: string;
  testStrategy?: string;
}

const buildPrBody = (plano: PlanoOutput | undefined, verify: VerifyOutput | undefined): string =>
  [
    "## Summary",
    plano?.summary ?? "(no plan summary available)",
    "",
    "## How to validate",
    plano?.testStrategy ?? "(no test strategy available)",
    "",
    "## Verify evidence",
    `known failures (pre-existing, not blocking): ${(verify?.knownFailures ?? []).join(", ") || "none"}`,
  ].join("\n");

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

export const makePr = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
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
  const verify = ctx.outputs.verify as VerifyOutput | undefined;
  const prBody = buildPrBody(plano, verify);

  const prResult = await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "pr", actionKey: "pr:create" },
    async () => {
      // Branch-scoped (server-side --head filter) so a busy repo's 30+ open PRs
      // can't hide this branch's PR and cause a duplicate create that gh rejects.
      const existing = await Effect.runPromise(github.getOpenPrByBranch(branch));
      const pr = existing ?? (await Effect.runPromise(github.createPullRequest(branch, title, prBody, repo.baseBranch))).pr;
      if (!(await alreadyLinked(deps, sourceId, taskId, branch))) {
        await deps.prLinks.create({ sourceId, taskId, repo: repo.slug, prNumber: pr.number, branch, status: "open" });
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
