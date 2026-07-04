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
          { author: { login: "alice" }, state: "APPROVED", body: "lgtm" },
          { author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "fix the null check" },
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
        { path: "src/a.ts", line: 12, body: "rename this", user: { login: "bob" } },
        { path: "src/b.ts", line: null, original_line: 30, body: "off by one", user: { login: "carol" } },
      ]);

      const connector = makeGitHubConnector(config);
      const result = await Effect.runPromise(connector.listReviewComments(7));

      expect(result).toEqual([
        { file: "src/a.ts", line: 12, body: "rename this", author: "bob" },
        { file: "src/b.ts", line: 30, body: "off by one", author: "carol" },
      ]);
      expect(calls[0].args).toEqual(["api", "repos/{owner}/{repo}/pulls/7/comments"]);
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
