import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Cause } from "effect";
import { makeGitHubConnector, aggregateReviewState, GitHubCliError } from "./github.js";

let mockStdout = "";
let mockStderr = "";
let shouldFail = false;
let calls: Array<{ file: string; args: string[]; options: any }> = [];

// promisify(execFile) invokes execFile(file, args, options, callback).
vi.mock("child_process", () => ({
  execFile: vi.fn((file: string, args: string[], options: any, callback: any) => {
    calls.push({ file, args, options });
    if (shouldFail) {
      const err = new Error("Command failed");
      (err as unknown as { stderr: string }).stderr = mockStderr;
      callback(err, { stdout: "", stderr: mockStderr });
    } else {
      callback(null, { stdout: mockStdout, stderr: "" });
    }
    return {};
  }),
}));

const config = { token: "ghp_test", repo: "owner/repo" };

describe("makeGitHubConnector", () => {
  beforeEach(() => {
    mockStdout = "";
    mockStderr = "";
    shouldFail = false;
    calls = [];
    vi.clearAllMocks();
  });

  it("should fetch an issue via execFile argv", async () => {
    mockStdout = JSON.stringify({
      number: 42,
      title: "Bug fix",
      body: "Something is broken",
      state: "open",
      labels: ["bug"],
    });

    const connector = makeGitHubConnector(config);
    const result = await Effect.runPromise(connector.fetchIssue(42));

    expect(result.issue.number).toBe(42);
    expect(result.issue.labels).toContain("bug");
    // Command ran as gh with argv (no shell string).
    expect(calls[0].file).toBe("gh");
    expect(calls[0].args).toEqual(["issue", "view", "42", "--json", "number,title,body,state,labels"]);
  });

  it("should list pull requests", async () => {
    mockStdout = JSON.stringify([
      { number: 1, title: "Feature A", url: "https://github.com/owner/repo/pull/1", state: "open", headRefName: "feat/a" },
    ]);

    const connector = makeGitHubConnector(config);
    const result = await Effect.runPromise(connector.listPullRequests());

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("should create a pull request with a slashed feature branch", async () => {
    mockStdout = JSON.stringify([{ url: "https://github.com/owner/repo/pull/2", number: 2 }]);

    const connector = makeGitHubConnector(config);
    const result = await Effect.runPromise(
      connector.createPullRequest("feat/issue-42-add-endpoint", "Add feature B", "Description here")
    );

    expect(result.pr.number).toBe(2);
    const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(create?.args).toContain("--head");
    expect(create?.args).toContain("feat/issue-42-add-endpoint");
  });

  it("passes malicious issue text as a single argv element, never a shell string", async () => {
    mockStdout = JSON.stringify([{ url: "https://github.com/owner/repo/pull/3", number: 3 }]);
    const payload = '`$(touch /tmp/pwned)`; rm -rf / && echo "';

    const connector = makeGitHubConnector(config);
    await Effect.runPromise(connector.createPullRequest("feat-c", "Title", payload));

    const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create")!;
    // The payload arrives verbatim as one argv element after --body — it is not
    // concatenated into any command string and never reaches a shell.
    const bodyIdx = create.args.indexOf("--body");
    expect(create.args[bodyIdx + 1]).toBe(payload);
    expect(create.file).toBe("gh");
  });

  it("rejects a branch ref outside the allowlist before any gh call", async () => {
    const connector = makeGitHubConnector(config);
    const exit = await Effect.runPromiseExit(
      connector.createPullRequest("feat/issue-1; rm -rf /", "t", "b")
    );

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  it("rejects a leading-dash branch (argv flag confusion)", async () => {
    const connector = makeGitHubConnector(config);
    const exit = await Effect.runPromiseExit(connector.createPullRequest("-oProxyCommand", "t", "b"));
    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-positive / non-integer issue number before any gh call", async () => {
    const connector = makeGitHubConnector(config);
    const negative = await Effect.runPromiseExit(connector.fetchIssue(-1));
    const fractional = await Effect.runPromiseExit(connector.addComment(1.5, "x"));
    expect(negative._tag).toBe("Failure");
    expect(fractional._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  it("should add a comment", async () => {
    mockStdout = "https://github.com/owner/repo/issues/42#issuecomment-123\n";
    const connector = makeGitHubConnector(config);
    await Effect.runPromise(connector.addComment(42, "LGTM"));
    expect(calls[0].args).toEqual(["issue", "comment", "42", "--body", "LGTM"]);
  });

  it("passes a minimal env (token/repo, no unrelated secrets)", async () => {
    mockStdout = JSON.stringify({ number: 1, title: "", body: "", state: "open", labels: [] });
    process.env.DATABASE_URL = "postgres://secret";
    try {
      const connector = makeGitHubConnector(config);
      await Effect.runPromise(connector.fetchIssue(1));
      const env = calls[0].options.env;
      expect(env.GH_TOKEN).toBe("ghp_test");
      expect(env.GH_REPO).toBe("owner/repo");
      expect(env.DATABASE_URL).toBeUndefined();
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  describe("F4 #157: review polling / rework methods", () => {
    it("listPullRequestReviews aggregates latest reviews (CHANGES_REQUESTED wins) and returns pr state + pending re-requests", async () => {
      mockStdout = JSON.stringify({
        state: "OPEN",
        latestReviews: [
          { author: { login: "alice" }, state: "APPROVED", body: "lgtm", authorAssociation: "MEMBER" },
          { author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "fix the null check", authorAssociation: "COLLABORATOR" },
        ],
        reviewRequests: [{ login: "bob" }],
      });

      const connector = makeGitHubConnector(config);
      const result = await Effect.runPromise(connector.listPullRequestReviews(7));

      expect(result.prState).toBe("OPEN");
      expect(result.reviewState).toBe("CHANGES_REQUESTED");
      expect(result.changesRequestedBy).toEqual(["bob"]);
      expect(result.pendingReviewRequests).toEqual(["bob"]);
      expect(calls[0].file).toBe("gh");
      expect(calls[0].args).toEqual(["pr", "view", "7", "--json", "state,latestReviews,reviewRequests"]);
    });

    it("aggregateReviewState: APPROVED without CHANGES_REQUESTED; COMMENTED only; PENDING when empty", () => {
      expect(aggregateReviewState([{ state: "APPROVED" }, { state: "COMMENTED" }])).toBe("APPROVED");
      expect(aggregateReviewState([{ state: "COMMENTED" }])).toBe("COMMENTED");
      expect(aggregateReviewState([])).toBe("PENDING");
    });

    it("listReviewComments maps file/line/body/author from the REST endpoint (line falls back to original_line)", async () => {
      mockStdout = JSON.stringify([
        { path: "src/a.ts", line: 12, body: "rename this", user: { login: "bob" }, author_association: "MEMBER" },
        { path: "src/b.ts", line: null, original_line: 30, body: "off by one", user: { login: "carol" }, author_association: "OWNER" },
      ]);

      const connector = makeGitHubConnector(config);
      const result = await Effect.runPromise(connector.listReviewComments(7));

      expect(result).toEqual([
        { file: "src/a.ts", line: 12, body: "rename this", author: "bob" },
        { file: "src/b.ts", line: 30, body: "off by one", author: "carol" },
      ]);
      expect(calls[0].args).toEqual(["api", "repos/{owner}/{repo}/pulls/7/comments", "--paginate"]);
    });

    describe("M2/#157: only a trusted author_association can drive rework", () => {
      it("listPullRequestReviews drops a CHANGES_REQUESTED from a non-trusted association (CONTRIBUTOR) — never aggregated, never listed", async () => {
        mockStdout = JSON.stringify({
          state: "OPEN",
          latestReviews: [
            { author: { login: "stranger" }, state: "CHANGES_REQUESTED", body: "do it my way", authorAssociation: "CONTRIBUTOR" },
            { author: { login: "alice" }, state: "APPROVED", body: "lgtm", authorAssociation: "MEMBER" },
          ],
          reviewRequests: [],
        });

        const connector = makeGitHubConnector(config);
        const result = await Effect.runPromise(connector.listPullRequestReviews(7));

        expect(result.reviewState).toBe("APPROVED"); // the untrusted CHANGES_REQUESTED never counts
        expect(result.changesRequestedBy).toEqual([]);
        expect(result.latestReviews.map((r) => r.author)).toEqual(["alice"]);
      });

      it("listPullRequestReviews drops a review with no relationship to the repo (authorAssociation: NONE)", async () => {
        mockStdout = JSON.stringify({
          state: "OPEN",
          latestReviews: [{ author: { login: "randomguy" }, state: "CHANGES_REQUESTED", body: "x", authorAssociation: "NONE" }],
          reviewRequests: [],
        });

        const connector = makeGitHubConnector(config);
        const result = await Effect.runPromise(connector.listPullRequestReviews(7));

        expect(result.reviewState).toBe("PENDING");
        expect(result.latestReviews).toEqual([]);
      });

      it("listPullRequestReviews keeps a CHANGES_REQUESTED from OWNER/MEMBER/COLLABORATOR", async () => {
        mockStdout = JSON.stringify({
          state: "OPEN",
          latestReviews: [{ author: { login: "maintainer" }, state: "CHANGES_REQUESTED", body: "fix", authorAssociation: "COLLABORATOR" }],
          reviewRequests: [],
        });

        const connector = makeGitHubConnector(config);
        const result = await Effect.runPromise(connector.listPullRequestReviews(7));

        expect(result.reviewState).toBe("CHANGES_REQUESTED");
        expect(result.changesRequestedBy).toEqual(["maintainer"]);
      });

      it("listReviewComments drops a comment whose author_association is not trusted", async () => {
        mockStdout = JSON.stringify([
          { path: "src/a.ts", line: 12, body: "trust me, change this", user: { login: "stranger" }, author_association: "NONE" },
          { path: "src/b.ts", line: 3, body: "real feedback", user: { login: "bob" }, author_association: "MEMBER" },
        ]);

        const connector = makeGitHubConnector(config);
        const result = await Effect.runPromise(connector.listReviewComments(7));

        expect(result).toEqual([{ file: "src/b.ts", line: 3, body: "real feedback", author: "bob" }]);
      });

      it("listReviewComments drops a comment with a missing author_association (fail closed, not open)", async () => {
        mockStdout = JSON.stringify([{ path: "src/a.ts", line: 1, body: "x", user: { login: "stranger" } }]);

        const connector = makeGitHubConnector(config);
        const result = await Effect.runPromise(connector.listReviewComments(7));

        expect(result).toEqual([]);
      });
    });

    it("requestReview POSTs each reviewer as a distinct -f argv pair; empty list is a no-op", async () => {
      const connector = makeGitHubConnector(config);
      await Effect.runPromise(connector.requestReview(7, []));
      expect(calls).toHaveLength(0); // no gh call for an empty reviewer list

      await Effect.runPromise(connector.requestReview(7, ["bob", "carol"]));
      expect(calls[0].args).toEqual([
        "api", "repos/{owner}/{repo}/pulls/7/requested_reviewers",
        "-X", "POST",
        "-f", "reviewers[]=bob",
        "-f", "reviewers[]=carol",
      ]);
    });

    it("requestReview rejects a malformed login before any gh call", async () => {
      const connector = makeGitHubConnector(config);
      const exit = await Effect.runPromiseExit(connector.requestReview(7, ["bob; rm -rf /"]));
      expect(exit._tag).toBe("Failure");
      expect(calls).toHaveLength(0);
    });

    it("commentOnPullRequest uses gh pr comment with the body as one argv element", async () => {
      const connector = makeGitHubConnector(config);
      await Effect.runPromise(connector.commentOnPullRequest(7, "pergunta?"));
      expect(calls[0].args).toEqual(["pr", "comment", "7", "--body", "pergunta?"]);
    });
  });

  describe("F5 #161: createIssue / createMilestone", () => {
    it("createMilestone POSTs via gh api and returns {number, url} from html_url", async () => {
      mockStdout = JSON.stringify({ number: 5, html_url: "https://github.com/owner/repo/milestone/5", title: "Pesquisa: X" });
      const connector = makeGitHubConnector(config);
      const result = await Effect.runPromise(connector.createMilestone("Pesquisa: X", "resumo"));
      expect(result).toEqual({ number: 5, url: "https://github.com/owner/repo/milestone/5" });
      expect(calls[0].file).toBe("gh");
      expect(calls[0].args).toEqual([
        "api", "repos/{owner}/{repo}/milestones", "-X", "POST",
        "-f", "title=Pesquisa: X", "-f", "description=resumo",
      ]);
    });

    it("createMilestone omits description when not given", async () => {
      mockStdout = JSON.stringify({ number: 6, html_url: "https://github.com/owner/repo/milestone/6" });
      const connector = makeGitHubConnector(config);
      await Effect.runPromise(connector.createMilestone("Só título"));
      expect(calls[0].args).toEqual(["api", "repos/{owner}/{repo}/milestones", "-X", "POST", "-f", "title=Só título"]);
    });

    it("createIssue links a milestone by NUMBER via -F and returns html_url", async () => {
      mockStdout = JSON.stringify({ number: 12, html_url: "https://github.com/owner/repo/issues/12" });
      const connector = makeGitHubConnector(config);
      const result = await Effect.runPromise(connector.createIssue("Fase 1", "corpo", { milestone: 5 }));
      expect(result).toEqual({ number: 12, url: "https://github.com/owner/repo/issues/12" });
      expect(calls[0].args).toEqual([
        "api", "repos/{owner}/{repo}/issues", "-X", "POST",
        "-f", "title=Fase 1", "-f", "body=corpo", "-F", "milestone=5",
      ]);
    });

    it("createIssue without a milestone emits no -F milestone", async () => {
      mockStdout = JSON.stringify({ number: 13, html_url: "https://github.com/owner/repo/issues/13" });
      const connector = makeGitHubConnector(config);
      await Effect.runPromise(connector.createIssue("solta", "corpo"));
      expect(calls[0].args).toEqual([
        "api", "repos/{owner}/{repo}/issues", "-X", "POST", "-f", "title=solta", "-f", "body=corpo",
      ]);
    });

    it("createIssue rejects a non-integer milestone before any gh call", async () => {
      const connector = makeGitHubConnector(config);
      const exit = await Effect.runPromiseExit(connector.createIssue("t", "b", { milestone: 1.5 }));
      expect(exit._tag).toBe("Failure");
      expect(calls).toHaveLength(0);
    });

    it("passes malicious issue title as a single argv element, never a shell string", async () => {
      mockStdout = JSON.stringify({ number: 1, html_url: "https://github.com/owner/repo/issues/1" });
      const payload = '`$(touch /tmp/pwned)`; rm -rf / && echo "';
      const connector = makeGitHubConnector(config);
      await Effect.runPromise(connector.createIssue(payload, "b"));
      // The payload arrives verbatim inside one `-f title=<payload>` argv element.
      expect(calls[0].args).toContain(`title=${payload}`);
      expect(calls[0].file).toBe("gh");
    });
  });

  it("should fail when gh returns error", async () => {
    shouldFail = true;
    mockStderr = "GraphQL: Could not resolve to an Issue with the number of 99.";

    const connector = makeGitHubConnector(config);
    const exit = await Effect.runPromiseExit(connector.fetchIssue(99));

    expect(exit._tag).toBe("Failure");
  });

  it("should include stderr in error", async () => {
    shouldFail = true;
    mockStderr = "Authentication failed";

    const connector = makeGitHubConnector(config);
    const exit = await Effect.runPromiseExit(connector.fetchIssue(1));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const result = Cause.findError(exit.cause);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") {
        const err = result.success;
        expect(err).toBeInstanceOf(GitHubCliError);
        expect((err as GitHubCliError).stderr).toBe("Authentication failed");
      }
    }
  });
});
