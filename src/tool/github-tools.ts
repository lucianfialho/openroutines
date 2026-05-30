/**
 * GitHub Tools
 *
 * Exposes the GitHub connector as LLM-callable tools.
 */

import type { Tool } from "./types.js";
import type { GitHubConfig } from "../connector/github.js";
import { makeGitHubConnector } from "../connector/github.js";
import { Effect } from "effect";

export const makeGitHubTools = (config: GitHubConfig): Tool[] => {
  const gh = makeGitHubConnector(config);

  const run = <E, A>(eff: Effect.Effect<A, E>): Promise<string> =>
    Effect.runPromise(eff).then(
      (result) => JSON.stringify(result),
      (err) => {
        throw err instanceof Error ? err : new Error(String(err));
      }
    );

  return [
    {
      definition: {
        name: "github_fetch_issue",
        description: "Fetch details of a GitHub issue by its number.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "integer",
              description: "The issue number",
            },
          },
          required: ["number"],
        },
      },
      handler: async (args) => run(gh.fetchIssue(Number(args.number))),
    },
    {
      definition: {
        name: "github_list_pull_requests",
        description: "List open pull requests in the repository.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
      handler: async () => run(gh.listPullRequests()),
    },
    {
      definition: {
        name: "github_get_pull_request",
        description: "Get details of a pull request including changed files.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "integer",
              description: "The PR number",
            },
          },
          required: ["number"],
        },
      },
      handler: async (args) => run(gh.getPullRequest(Number(args.number))),
    },
    {
      definition: {
        name: "github_create_pull_request",
        description: "Create a new pull request.",
        parameters: {
          type: "object",
          properties: {
            branch: {
              type: "string",
              description: "The branch name for the PR",
            },
            title: {
              type: "string",
              description: "PR title",
            },
            body: {
              type: "string",
              description: "PR description (markdown supported)",
            },
          },
          required: ["branch", "title", "body"],
        },
      },
      handler: async (args) =>
        run(
          gh.createPullRequest(
            String(args.branch),
            String(args.title),
            String(args.body)
          )
        ),
    },
    {
      definition: {
        name: "github_list_issues",
        description: "List open issues in the repository.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "Maximum number of issues to return (default 10)",
            },
          },
        },
      },
      handler: async (args) => run(gh.listIssues("open", Number(args.limit) || 10)),
    },
    {
      definition: {
        name: "github_add_comment",
        description: "Add a comment to an issue or PR.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "integer",
              description: "Issue or PR number",
            },
            body: {
              type: "string",
              description: "Comment body (markdown supported)",
            },
          },
          required: ["number", "body"],
        },
      },
      handler: async (args) =>
        run(gh.addComment(Number(args.number), String(args.body))),
    },
  ];
};
