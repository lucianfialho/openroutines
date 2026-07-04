/**
 * PR review poller (F4 #157, D24).
 *
 * Ran by the pr-review-poll cron tick (every 30min, daytime — intercepted by
 * routineId in app.ts's queueHandler like night-run): for each open pr_link,
 * read the PR's review snapshot via gh. A transition INTO CHANGES_REQUESTED
 * moves the card Review -> Working and marks the link eligible for the next
 * night's rework admission (it never dispatches rework immediately).
 *
 * Idempotency: the previous review_state is checked BEFORE acting — a link
 * already 'changes_requested' (or 'rework-exhausted', which would otherwise
 * un-block a capped card) is never re-acted on. There is no execution here,
 * so no action_ledger: the persisted review_state IS the dedupe key.
 *
 * MERGED/CLOSED detection is deliberately minimal (F5 owns the general merge
 * flow): it only closes the link so rework never runs on a dead PR.
 */
import { Effect } from "effect";
import { makeGitHubConnector } from "../connector/github.js";
import { resolveRepo } from "../repo-registry/registry.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { PrLink, PrLinkRepository, PrFeedbackRepository } from "../persistence/types.js";
import type { TaskSource } from "../task-source/types.js";

export interface PrReviewPollDeps {
  prLinks: PrLinkRepository;
  registry: RepoRegistry;
  githubToken: string;
  taskSourceFor: (sourceId: string) => TaskSource | undefined;
  /** Injectable seam for tests — defaults to the real connector. */
  makeGithub?: (cfg: { token: string; repo: string }) => Pick<ReturnType<typeof makeGitHubConnector>, "listPullRequestReviews" | "listReviewComments">;
  /**
   * F5 #165 write-path: when wired, a merged OpenRoutines PR is mined into
   * pr_feedback (human delta + review comments). Absent -> merge only closes the
   * link, as before.
   */
  prFeedback?: PrFeedbackRepository;
  /**
   * Seam computing the "human delta" — what a human changed on the branch between
   * the agent's last push (`link.lastAgentCommitSha`) and the merge. The correct
   * `git diff` is merge-strategy-dependent (true merge vs squash), so F6 wires the
   * repo-appropriate, argv-safe implementation; absent here means human-delta is
   * simply not mined (review comments still are).
   */
  computeHumanDelta?: (link: PrLink) => Promise<string>;
}

export interface PrReviewPollSummary {
  checked: number;
  changesRequested: number;
  closed: number;
}

/**
 * The single "admit this PR to next night's rework queue" transition (D24),
 * shared by this poller (on a GitHub CHANGES_REQUESTED) and async human
 * steering (F5 #169, a 🧭 on a Review card): move the card Review -> Working,
 * comment why, and flip review_state so the night coordinator's EXISTING
 * admitReworkCards picks it up — there is deliberately no second rework path.
 * External actions first (moveTo is idempotent by construction), persisted
 * review_state last — a crash in between re-runs both on the next tick.
 */
export const transitionToRework = async (
  prLinks: PrLinkRepository,
  ts: TaskSource | undefined,
  link: { sourceId: string; taskId: string; branch: string },
  reason: string
): Promise<void> => {
  if (ts) {
    await Effect.runPromise(ts.moveTo(link.taskId, "working"));
    await Effect.runPromise(ts.comment(link.taskId, reason));
  }
  await prLinks.update({ sourceId: link.sourceId, taskId: link.taskId, branch: link.branch }, { reviewState: "changes_requested" });
};

/**
 * Mine a merged OpenRoutines PR into pr_feedback (F5 #165 write-path, D27):
 *   (a) the "human delta" — what a human changed on the branch between the
 *       agent's last push and the merge — via the injected computeHumanDelta
 *       seam (F6 wires the real, merge-strategy-correct `git diff`; absent means
 *       human-delta is not mined this run);
 *   (b) the human's inline review comments, via the existing gh connector.
 * The 🧭 steering source (c) is NOT written here — it already lives in
 * card_steering (#169); the weekly calibration consumes it from there.
 *
 * Every pr_link tracks an OpenRoutines PR by construction, so every merge
 * qualifies. Idempotent: the presence of ANY pr_feedback row for this
 * (repo, prNumber) is the dedupe key, so a re-mine (e.g. a crash between mining
 * and the status flip) persists nothing. Returns the number of rows persisted.
 */
export const mineMergedPr = async (
  link: PrLink,
  deps: Pick<PrReviewPollDeps, "prFeedback" | "computeHumanDelta" | "registry" | "githubToken" | "makeGithub">
): Promise<number> => {
  const feedback = deps.prFeedback;
  if (!feedback || !link.prNumber) return 0;

  const already = await feedback.findByRepo(link.repo);
  if (already.some((f) => f.prNumber === link.prNumber)) return 0;

  const base = { repo: link.repo, prNumber: link.prNumber, sourceId: link.sourceId, taskId: link.taskId };
  let persisted = 0;

  // (a) human delta — only when we know the agent's last commit AND a delta seam is wired.
  if (link.lastAgentCommitSha && deps.computeHumanDelta) {
    const delta = (await deps.computeHumanDelta(link)).trim();
    if (delta.length > 0) {
      await feedback.save({ ...base, kind: "human-delta", content: delta });
      persisted++;
    }
  }

  // (b) inline review comments the human left on the PR.
  const repoConfig = resolveRepo(deps.registry, link.repo);
  if (repoConfig) {
    const github = (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo: repoConfig.githubRepo });
    const comments = await Effect.runPromise(github.listReviewComments(link.prNumber));
    for (const c of comments) {
      const body = c.body.trim();
      if (body.length === 0) continue;
      const loc = c.line != null ? `${c.file}:${c.line}` : c.file;
      await feedback.save({ ...base, kind: "review-comment", content: `${loc} — ${body}` });
      persisted++;
    }
  }

  return persisted;
};

export const runPrReviewPoll = async (deps: PrReviewPollDeps): Promise<PrReviewPollSummary> => {
  const summary: PrReviewPollSummary = { checked: 0, changesRequested: 0, closed: 0 };
  const links = await deps.prLinks.findOpen();

  for (const link of links) {
    if (!link.prNumber) continue; // legacy row without a PR number — nothing to poll
    const repoConfig = resolveRepo(deps.registry, link.repo);
    if (!repoConfig) continue;
    summary.checked++;

    let snapshot;
    try {
      const github = (deps.makeGithub ?? makeGitHubConnector)({ token: deps.githubToken, repo: repoConfig.githubRepo });
      snapshot = await Effect.runPromise(github.listPullRequestReviews(link.prNumber));
    } catch (err) {
      // One PR's gh failure never stops the sweep.
      console.error(`[PrReviewPoll] gh failed for ${link.repo}#${link.prNumber}:`, err instanceof Error ? err.message : err);
      continue;
    }

    const key = { sourceId: link.sourceId, taskId: link.taskId, branch: link.branch };

    if (snapshot.prState !== "OPEN") {
      // F5 #165 write-path: mine a merged PR into pr_feedback BEFORE closing the
      // link. A mining failure never blocks the status flip or the sweep
      // (mirrors the gh-failure handling above).
      if (snapshot.prState === "MERGED" && deps.prFeedback) {
        try {
          await mineMergedPr(link, deps);
        } catch (err) {
          console.error(`[PrReviewPoll] mining failed for ${link.repo}#${link.prNumber}:`, err instanceof Error ? err.message : err);
        }
      }
      await deps.prLinks.update(key, { status: snapshot.prState === "MERGED" ? "merged" : "closed" });
      summary.closed++;
      continue;
    }

    const alreadyActed = link.reviewState === "changes_requested" || link.reviewState === "rework-exhausted";
    // After a rework round re-requested review ('re-requested'), the old
    // CHANGES_REQUESTED verdict still shows in latestReviews until the human
    // actually re-reviews — while EVERY requesting reviewer still has a
    // pending re-request, the verdict is stale, not a new round trigger.
    const staleReRequest =
      link.reviewState === "re-requested" &&
      snapshot.changesRequestedBy.length > 0 &&
      snapshot.changesRequestedBy.every((login) => snapshot.pendingReviewRequests.includes(login));
    if (snapshot.reviewState === "CHANGES_REQUESTED" && !alreadyActed && !staleReRequest) {
      await transitionToRework(
        deps.prLinks,
        deps.taskSourceFor(link.sourceId),
        { sourceId: link.sourceId, taskId: link.taskId, branch: link.branch },
        `↩️ [Retrabalho] o PR #${link.prNumber} recebeu changes_requested — o card volta para Working e entra na fila de retrabalho da próxima noite.`
      );
      summary.changesRequested++;
    }
  }

  return summary;
};
