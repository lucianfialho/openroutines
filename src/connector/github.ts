/**
 * GitHub CLI Connector
 *
 * CLI-first integration with GitHub via `gh`. Every invocation uses execFile
 * with an argv array (never a shell string), so issue/card text that reaches a
 * title/body/comment can never break out into the orchestrator's shell. Slugs
 * and numbers derived from untrusted input are validated before use.
 */

import { Effect } from "effect";
import { execFile } from "child_process";
import { promisify } from "util";
import { pickEnv, BASE_ENV_VARS } from "../util/env.js";
import { BRANCH_RE } from "../util/validate.js";

const execFileAsync = promisify(execFile);

export interface GitHubConfig {
  token: string;
  repo: string;
}

export class GitHubCliError extends Error {
  constructor(
    message: string,
    readonly command?: string,
    readonly stderr?: string
  ) {
    super(message);
    this.name = "GitHubCliError";
  }
}

interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
}

interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
}

const ensureBranch = (branch: string): Effect.Effect<void, GitHubCliError> =>
  BRANCH_RE.test(branch)
    ? Effect.succeed(undefined)
    : Effect.fail(new GitHubCliError(`Invalid branch ref (must match ${BRANCH_RE}): ${branch}`));

const ensureNumber = (n: number): Effect.Effect<void, GitHubCliError> =>
  Number.isInteger(n) && n > 0
    ? Effect.succeed(undefined)
    : Effect.fail(new GitHubCliError(`Invalid positive integer: ${n}`));

export const makeGitHubConnector = (config: GitHubConfig) => {
  // Minimal env: gh needs only its token/repo plus PATH/HOME — never the rest
  // of the orchestrator's secrets.
  const env = {
    ...pickEnv(BASE_ENV_VARS),
    GH_TOKEN: config.token,
    GH_REPO: config.repo,
  };

  const execGh = (args: string[]): Effect.Effect<string, GitHubCliError> =>
    Effect.tryPromise({
      try: async () => {
        const { stdout } = await execFileAsync("gh", args, { env });
        return stdout.trim();
      },
      catch: (err) => {
        const stderr = err instanceof Error && "stderr" in err
          ? String((err as { stderr?: string }).stderr)
          : undefined;
        return new GitHubCliError(
          `gh command failed: gh ${args.join(" ")}`,
          `gh ${args.join(" ")}`,
          stderr
        );
      },
    });

  const fetchIssue = (number: number): Effect.Effect<{ issue: Issue }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(number);
      yield* Effect.log(`[GitHub] Fetching issue #${number}`);
      const output = yield* execGh([
        "issue", "view", String(number),
        "--json", "number,title,body,state,labels",
      ]);
      const parsed = JSON.parse(output) as Issue;
      return { issue: parsed };
    });

  const listPullRequests = (): Effect.Effect<PullRequest[], GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Listing pull requests`);
      const output = yield* execGh([
        "pr", "list", "--json", "number,title,url,state,headRefName",
      ]);
      const parsed = JSON.parse(output) as PullRequest[];
      return parsed;
    });

  const getPullRequest = (
    number: number
  ): Effect.Effect<{ number: number; title: string; body: string; headRefName: string; files: string[] }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(number);
      yield* Effect.log(`[GitHub] Getting PR #${number}`);
      const prOutput = yield* execGh([
        "pr", "view", String(number), "--json", "number,title,body,headRefName",
      ]);
      const pr = JSON.parse(prOutput) as { number: number; title: string; body: string; headRefName: string };
      const filesOutput = yield* execGh([
        "pr", "view", String(number), "--json", "files",
      ]);
      const filesData = JSON.parse(filesOutput) as { files?: Array<{ path: string }> };
      const files = (filesData.files || []).map((f) => f.path);
      return { ...pr, files };
    });

  const createPullRequest = (
    branch: string,
    title: string,
    body: string
  ): Effect.Effect<{ pr: { url: string; number: number; branch: string } }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureBranch(branch);
      yield* Effect.log(`[GitHub] Creating PR: ${title}`);
      // gh pr create does not support --json; create then list to get details.
      // title/body are passed as distinct argv elements — no shell, no escaping.
      yield* execGh([
        "pr", "create", "--head", branch, "--title", title, "--body", body,
      ]);
      const output = yield* execGh([
        "pr", "list", "--head", branch, "--state", "open", "--json", "number,url",
      ]);
      const parsed = JSON.parse(output) as Array<{ url: string; number: number }>;
      if (parsed.length === 0) {
        return yield* Effect.fail(new GitHubCliError("PR created but not found in list"));
      }
      return {
        pr: {
          url: parsed[0].url,
          number: parsed[0].number,
          branch,
        }
      };
    });

  const addComment = (
    number: number,
    body: string
  ): Effect.Effect<void, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(number);
      yield* Effect.log(`[GitHub] Adding comment to #${number}`);
      yield* execGh(["issue", "comment", String(number), "--body", body]);
    });

  const listIssues = (
    state: "open" | "closed" | "all" = "open",
    limit: number = 30
  ): Effect.Effect<Issue[], GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(limit);
      yield* Effect.log(`[GitHub] Listing ${state} issues`);
      const output = yield* execGh([
        "issue", "list", "--state", state, "--limit", String(limit),
        "--json", "number,title,body,state,labels",
      ]);
      const parsed = JSON.parse(output) as Issue[];
      return parsed;
    });

  return {
    fetchIssue,
    listIssues,
    listPullRequests,
    getPullRequest,
    createPullRequest,
    addComment,
  };
};
