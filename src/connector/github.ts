/**
 * GitHub CLI Connector
 *
 * CLI-first integration with GitHub via `gh` command.
 * Falls back to REST API for operations not supported by CLI.
 */

import { Effect } from "effect";

export interface GitHubConfig {
  token: string;
  repo: string;
}

export const makeGitHubConnector = (config: GitHubConfig) => {
  return {
    fetchIssue: (number: number) =>
      Effect.gen(function* () {
        yield* Effect.log(`[GitHub] Fetching issue #${number}`);
        void config;
        // TODO: exec gh issue view ${number} --json ...
        return { number, title: "TODO", body: "TODO" };
      }),

    createPullRequest: (_branch: string, title: string, _body: string) =>
      Effect.gen(function* () {
        yield* Effect.log(`[GitHub] Creating PR: ${title}`);
        // TODO: exec gh pr create ...
        return { url: "TODO" };
      }),
  };
};
