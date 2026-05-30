/**
 * GitHub CLI Connector
 *
 * CLI-first integration with GitHub via `gh` command.
 * Falls back to REST API for operations not supported by CLI.
 */

import { Effect } from "effect";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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

export const makeGitHubConnector = (config: GitHubConfig) => {
  const env = {
    ...process.env,
    GH_TOKEN: config.token,
    GH_REPO: config.repo,
  };

  const execGh = (command: string): Effect.Effect<string, GitHubCliError> =>
    Effect.tryPromise({
      try: async () => {
        const { stdout } = await execAsync(`gh ${command}`, { env });
        return stdout.trim();
      },
      catch: (err) => {
        const stderr = err instanceof Error && "stderr" in err
          ? String((err as { stderr?: string }).stderr)
          : undefined;
        return new GitHubCliError(
          `gh command failed: ${command}`,
          command,
          stderr
        );
      },
    });

  const fetchIssue = (number: number): Effect.Effect<Issue, GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Fetching issue #${number}`);
      const output = yield* execGh(
        `issue view ${number} --json number,title,body,state,labels`
      );
      const parsed = JSON.parse(output) as Issue;
      return parsed;
    });

  const listPullRequests = (): Effect.Effect<PullRequest[], GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Listing pull requests`);
      const output = yield* execGh(
        `pr list --json number,title,url,state,headRefName`
      );
      const parsed = JSON.parse(output) as PullRequest[];
      return parsed;
    });

  const getPullRequest = (
    number: number
  ): Effect.Effect<{ number: number; title: string; body: string; headRefName: string; files: string[] }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Getting PR #${number}`);
      const prOutput = yield* execGh(
        `pr view ${number} --json number,title,body,headRefName`
      );
      const pr = JSON.parse(prOutput) as { number: number; title: string; body: string; headRefName: string };
      const filesOutput = yield* execGh(
        `pr view ${number} --json files`
      );
      const filesData = JSON.parse(filesOutput) as { files?: Array<{ path: string }> };
      const files = (filesData.files || []).map((f) => f.path);
      return { ...pr, files };
    });

  const createPullRequest = (
    branch: string,
    title: string,
    body: string
  ): Effect.Effect<{ url: string; number: number }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Creating PR: ${title}`);
      // gh pr create does not support --json; create then list to get details
      yield* execGh(
        `pr create --head ${branch} --title "${escapeShell(title)}" --body "${escapeShell(body)}"`
      );
      const output = yield* execGh(
        `pr list --head ${branch} --state open --json number,url`
      );
      const parsed = JSON.parse(output) as Array<{ url: string; number: number }>;
      if (parsed.length === 0) {
        return yield* Effect.fail(new GitHubCliError("PR created but not found in list"));
      }
      return parsed[0];
    });

  const addComment = (
    number: number,
    body: string
  ): Effect.Effect<void, GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Adding comment to #${number}`);
      yield* execGh(
        `issue comment ${number} --body "${escapeShell(body)}"`
      );
    });

  const listIssues = (
    state: "open" | "closed" | "all" = "open",
    limit: number = 30
  ): Effect.Effect<Issue[], GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Listing ${state} issues`);
      const output = yield* execGh(
        `issue list --state ${state} --limit ${limit} --json number,title,body,state,labels`
      );
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

/** Escape double quotes for shell safety. */
const escapeShell = (input: string): string => {
  return input.replace(/"/g, '\\"');
};
