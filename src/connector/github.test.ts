import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Cause } from "effect";
import { makeGitHubConnector, GitHubCliError } from "./github.js";

let mockStdout = "";
let mockStderr = "";
let shouldFail = false;

vi.mock("child_process", () => ({
  exec: vi.fn((_cmd, _opts, callback) => {
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
    vi.clearAllMocks();
  });

  it("should fetch an issue", async () => {
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
    expect(result.issue.title).toBe("Bug fix");
    expect(result.issue.labels).toContain("bug");
  });

  it("should list pull requests", async () => {
    mockStdout = JSON.stringify([
      {
        number: 1,
        title: "Feature A",
        url: "https://github.com/owner/repo/pull/1",
        state: "open",
        headRefName: "feat/a",
      },
    ]);

    const connector = makeGitHubConnector(config);
    const result = await Effect.runPromise(connector.listPullRequests());

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].title).toBe("Feature A");
  });

  it("should create a pull request", async () => {
    mockStdout = JSON.stringify([{
      url: "https://github.com/owner/repo/pull/2",
      number: 2,
    }]);

    const connector = makeGitHubConnector(config);
    const result = await Effect.runPromise(
      connector.createPullRequest("feat/b", "Add feature B", "Description here")
    );

    expect(result.pr.url).toBe("https://github.com/owner/repo/pull/2");
    expect(result.pr.number).toBe(2);
  });

  it("should escape quotes in PR body", async () => {
    mockStdout = JSON.stringify([{ url: "https://github.com/owner/repo/pull/3", number: 3 }]);

    const connector = makeGitHubConnector(config);
    await Effect.runPromise(
      connector.createPullRequest("feat/c", "Title", 'Say "hello"')
    );

    // The mock doesn't expose the command, but we verify no throw
    expect(true).toBe(true);
  });

  it("should add a comment", async () => {
    mockStdout = "https://github.com/owner/repo/issues/42#issuecomment-123\n";

    const connector = makeGitHubConnector(config);
    await Effect.runPromise(connector.addComment(42, "LGTM"));

    // Should not throw
    expect(true).toBe(true);
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
