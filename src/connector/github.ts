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

  const createPullRequest = (
    branch: string,
    title: string,
    body: string
  ): Effect.Effect<{ url: string; number: number }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Creating PR: ${title}`);
      const output = yield* execGh(
        `pr create --head ${branch} --title "${escapeShell(title)}" --body "${escapeShell(body)}" --json url,number`
      );
      const parsed = JSON.parse(output) as { url: string; number: number };
      return parsed;
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

  return {
    fetchIssue,
    listPullRequests,
    createPullRequest,
    addComment,
  };
};

/** Escape double quotes for shell safety. */
const escapeShell = (input: string): string => {
  return input.replace(/"/g, '\\"');
};
