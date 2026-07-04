import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { runPrReviewPoll, type PrReviewPollDeps } from "./pr-review-poller.js";
import { makeInMemoryPrLinkRepository } from "../persistence/pr-links-in-memory.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { TaskSource } from "../task-source/types.js";

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/acme-widgets",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
  },
};

const snapshot = (prState: string, reviewState: string, pendingReviewRequests: string[] = []) => ({
  prState,
  reviewState,
  changesRequestedBy: reviewState === "CHANGES_REQUESTED" ? ["bob"] : [],
  latestReviews: [],
  pendingReviewRequests,
});

const makeHarness = async (opts: {
  reviewState?: string;
  ghSnapshot?: { prState: string; reviewState: string; pendingReviewRequests?: string[] };
}) => {
  const prLinks = makeInMemoryPrLinkRepository();
  await prLinks.create({
    sourceId: "trello-main",
    taskId: "card1",
    repo: "acme-widgets",
    prNumber: 42,
    branch: "openroutines/card-card1",
    status: "open",
    ...(opts.reviewState ? { reviewState: opts.reviewState } : {}),
  });
  const gh = opts.ghSnapshot ?? { prState: "OPEN", reviewState: "CHANGES_REQUESTED" };
  const listPullRequestReviews = vi.fn(() => Effect.succeed(snapshot(gh.prState, gh.reviewState, gh.pendingReviewRequests ?? [])));
  const moveTo = vi.fn(() => Effect.succeed(undefined));
  const comment = vi.fn(() => Effect.succeed(undefined));
  const deps: PrReviewPollDeps = {
    prLinks,
    registry,
    githubToken: "gh_test",
    taskSourceFor: () => ({ moveTo, comment }) as unknown as TaskSource,
    makeGithub: (() => ({ listPullRequestReviews })) as unknown as PrReviewPollDeps["makeGithub"],
  };
  return { deps, prLinks, listPullRequestReviews, moveTo, comment };
};

describe("runPrReviewPoll (F4 #157, D24)", () => {
  it("AC: transition to CHANGES_REQUESTED updates review_state, moves the card Review->Working and comments — idempotent across 2 runs", async () => {
    const h = await makeHarness({});

    const s1 = await runPrReviewPoll(h.deps);
    const s2 = await runPrReviewPoll(h.deps); // GitHub still reports CHANGES_REQUESTED

    expect(s1).toEqual({ checked: 1, changesRequested: 1, closed: 0 });
    expect(s2).toEqual({ checked: 1, changesRequested: 0, closed: 0 }); // 2nd run re-acts on nothing
    // external actions fired exactly once
    expect(h.moveTo).toHaveBeenCalledTimes(1);
    expect(h.moveTo).toHaveBeenCalledWith("card1", "working");
    expect(h.comment).toHaveBeenCalledTimes(1);
    expect(h.comment).toHaveBeenCalledWith("card1", expect.stringContaining("Retrabalho"));
    const link = (await h.prLinks.findByTask("trello-main", "card1"))[0];
    expect(link.reviewState).toBe("changes_requested");
    expect(link.status).toBe("open");
  });

  it("after a re-request, the reviewer's STALE changes_requested (re-request still pending) never re-triggers a round", async () => {
    const h = await makeHarness({
      reviewState: "re-requested",
      // bob's old CHANGES_REQUESTED still shows in latestReviews, but his
      // re-request is still pending — he hasn't re-reviewed anything.
      ghSnapshot: { prState: "OPEN", reviewState: "CHANGES_REQUESTED", pendingReviewRequests: ["bob"] },
    });

    const s = await runPrReviewPoll(h.deps);

    expect(s.changesRequested).toBe(0);
    expect(h.moveTo).not.toHaveBeenCalled();
    expect((await h.prLinks.findByTask("trello-main", "card1"))[0].reviewState).toBe("re-requested");
  });

  it("acts again once the human actually re-reviews with changes (re-request no longer pending)", async () => {
    const h = await makeHarness({
      reviewState: "re-requested",
      ghSnapshot: { prState: "OPEN", reviewState: "CHANGES_REQUESTED", pendingReviewRequests: [] },
    });

    const s = await runPrReviewPoll(h.deps);

    expect(s.changesRequested).toBe(1);
    expect(h.moveTo).toHaveBeenCalledWith("card1", "working");
    expect((await h.prLinks.findByTask("trello-main", "card1"))[0].reviewState).toBe("changes_requested");
  });

  it("never re-opens a rework-exhausted card, even while GitHub still reports CHANGES_REQUESTED", async () => {
    const h = await makeHarness({ reviewState: "rework-exhausted" });

    const s = await runPrReviewPoll(h.deps);

    expect(s.changesRequested).toBe(0);
    expect(h.moveTo).not.toHaveBeenCalled();
    expect(h.comment).not.toHaveBeenCalled();
    expect((await h.prLinks.findByTask("trello-main", "card1"))[0].reviewState).toBe("rework-exhausted");
  });

  it("MERGED/CLOSED PR: closes the link (so rework never runs on it) and touches nothing else", async () => {
    const merged = await makeHarness({ ghSnapshot: { prState: "MERGED", reviewState: "APPROVED" } });
    const s = await runPrReviewPoll(merged.deps);
    expect(s).toEqual({ checked: 1, changesRequested: 0, closed: 1 });
    expect((await merged.prLinks.findByTask("trello-main", "card1"))[0].status).toBe("merged");
    expect(merged.moveTo).not.toHaveBeenCalled();

    const closed = await makeHarness({ ghSnapshot: { prState: "CLOSED", reviewState: "PENDING" } });
    await runPrReviewPoll(closed.deps);
    expect((await closed.prLinks.findByTask("trello-main", "card1"))[0].status).toBe("closed");
  });

  it("skips links without a prNumber or with an unresolvable repo; one PR's gh failure never stops the sweep", async () => {
    const prLinks = makeInMemoryPrLinkRepository();
    await prLinks.create({ sourceId: "s", taskId: "no-pr", repo: "acme-widgets", branch: "b1", status: "open" }); // no prNumber
    await prLinks.create({ sourceId: "s", taskId: "gone-repo", repo: "unknown-repo", prNumber: 1, branch: "b2", status: "open" });
    await prLinks.create({ sourceId: "s", taskId: "boom", repo: "acme-widgets", prNumber: 2, branch: "b3", status: "open" });
    await prLinks.create({ sourceId: "s", taskId: "ok", repo: "acme-widgets", prNumber: 3, branch: "b4", status: "open" });

    const moveTo = vi.fn(() => Effect.succeed(undefined));
    const comment = vi.fn(() => Effect.succeed(undefined));
    const listPullRequestReviews = vi.fn((n: number) =>
      n === 2 ? Effect.fail(new Error("gh exploded")) : Effect.succeed(snapshot("OPEN", "CHANGES_REQUESTED"))
    );
    const deps: PrReviewPollDeps = {
      prLinks,
      registry,
      githubToken: "gh_test",
      taskSourceFor: () => ({ moveTo, comment }) as unknown as TaskSource,
      makeGithub: (() => ({ listPullRequestReviews })) as unknown as PrReviewPollDeps["makeGithub"],
    };

    const s = await runPrReviewPoll(deps);

    expect(s.checked).toBe(2); // boom + ok (no-pr and gone-repo never reach gh)
    expect(s.changesRequested).toBe(1); // only "ok" — the gh failure was absorbed
    expect((await prLinks.findByTask("s", "ok"))[0].reviewState).toBe("changes_requested");
  });
});
