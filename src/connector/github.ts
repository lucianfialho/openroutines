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

/** Aggregated review state of a PR (F4 #157) — one value per PR, not per reviewer. */
export type ReviewAggregateState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";

export interface PullRequestReviewSnapshot {
  /** gh pr view state: OPEN | CLOSED | MERGED. */
  prState: string;
  reviewState: ReviewAggregateState;
  /** Logins whose LATEST review is CHANGES_REQUESTED — the re-request targets. */
  changesRequestedBy: string[];
  /** Latest review per reviewer, as gh reports it (body carries the review summary). */
  latestReviews: Array<{ author: string; state: string; body: string }>;
  /**
   * Logins with a review request currently PENDING. After a re-request, the
   * reviewer stays here (and their stale CHANGES_REQUESTED still shows in
   * latestReviews) until they actually re-review — the poller uses this to
   * tell a stale verdict from a fresh one (F4 #157).
   */
  pendingReviewRequests: string[];
}

export interface PullRequestReviewComment {
  file: string;
  line?: number;
  body: string;
  author: string;
}

/**
 * Latest-review-per-reviewer -> one aggregate: any CHANGES_REQUESTED wins,
 * else any APPROVED, else any review at all is COMMENTED, else PENDING.
 */
export const aggregateReviewState = (
  latestReviews: Array<{ state: string }>
): ReviewAggregateState => {
  if (latestReviews.some((r) => r.state === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (latestReviews.some((r) => r.state === "APPROVED")) return "APPROVED";
  return latestReviews.length > 0 ? "COMMENTED" : "PENDING";
};

// GitHub logins: alphanumeric + inner hyphens, max 39 chars — validated before
// reaching argv (defense in depth; the value is embedded after `reviewers[]=`).
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * M2/#157: on a public repo, ANY GitHub account can review a PR or leave an
 * inline comment — but a CHANGES_REQUESTED (and its body) drives a rework
 * round straight into an agent with edit/write/run_shell/git_commit. Only
 * these author_association values are trusted enough to steer that (griefing
 * / prompt-injection otherwise); an absent association (missing field) fails
 * closed, never trusted.
 */
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

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

  // Branch-scoped lookup for idempotent PR creation: --head filters server-side
  // so the 30-item / open-only default of `pr list` can never hide THIS branch's
  // open PR (which would otherwise cause a duplicate create that gh rejects).
  const getOpenPrByBranch = (
    branch: string
  ): Effect.Effect<{ url: string; number: number } | undefined, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureBranch(branch);
      const output = yield* execGh([
        "pr", "list", "--head", branch, "--state", "open", "--json", "number,url",
      ]);
      const parsed = JSON.parse(output) as Array<{ url: string; number: number }>;
      return parsed[0];
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
    body: string,
    base?: string
  ): Effect.Effect<{ pr: { url: string; number: number; branch: string } }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureBranch(branch);
      // When a base is given it is validated as a branch ref too, and passed as
      // --base so the PR targets an integration branch (development), NEVER the
      // repo's default (which may be main — the invariant "no transition touches
      // main"). Omitted → gh's default base (kept for solve-issue's dogfooding).
      if (base !== undefined) yield* ensureBranch(base);
      yield* Effect.log(`[GitHub] Creating PR: ${title}${base ? ` -> ${base}` : ""}`);
      // gh pr create does not support --json; create then list to get details.
      // title/body are passed as distinct argv elements — no shell, no escaping.
      const createArgs = ["pr", "create", "--head", branch, "--title", title, "--body", body];
      if (base) createArgs.push("--base", base);
      yield* execGh(createArgs);
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

  /** PR conversation comment (F4 #157) — `gh issue comment` rejects PR numbers, so this uses `gh pr comment`. */
  const commentOnPullRequest = (
    number: number,
    body: string
  ): Effect.Effect<void, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(number);
      yield* Effect.log(`[GitHub] Commenting on PR #${number}`);
      yield* execGh(["pr", "comment", String(number), "--body", body]);
    });

  /**
   * Review-state snapshot of a PR (F4 #157, D24): one gh call returns the PR's
   * open/closed/merged state AND gh's latest-review-per-reviewer list, which
   * this aggregates to APPROVED|CHANGES_REQUESTED|COMMENTED|PENDING.
   */
  const listPullRequestReviews = (
    number: number
  ): Effect.Effect<PullRequestReviewSnapshot, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(number);
      yield* Effect.log(`[GitHub] Listing reviews for PR #${number}`);
      const output = yield* execGh(["pr", "view", String(number), "--json", "state,latestReviews,reviewRequests"]);
      const parsed = JSON.parse(output) as {
        state?: string;
        latestReviews?: Array<{ author?: { login?: string }; state?: string; body?: string; authorAssociation?: string }>;
        reviewRequests?: Array<{ login?: string; slug?: string }>;
      };
      // M2/#157: drop untrusted reviewers BEFORE aggregating/listing — gh
      // already returns authorAssociation on every review, it was just never
      // read.
      const latestReviews = (parsed.latestReviews ?? [])
        .filter((r) => TRUSTED_AUTHOR_ASSOCIATIONS.has(r.authorAssociation ?? ""))
        .map((r) => ({
          author: r.author?.login ?? "unknown",
          state: r.state ?? "",
          body: r.body ?? "",
        }));
      return {
        prState: parsed.state ?? "OPEN",
        reviewState: aggregateReviewState(latestReviews),
        changesRequestedBy: latestReviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author),
        latestReviews,
        pendingReviewRequests: (parsed.reviewRequests ?? [])
          .map((r) => r.login ?? r.slug ?? "")
          .filter(Boolean),
      };
    });

  /** Inline review comments of a PR (file/line/body/author) via the REST endpoint (F4 #157). */
  const listReviewComments = (
    number: number
  ): Effect.Effect<PullRequestReviewComment[], GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(number);
      yield* Effect.log(`[GitHub] Listing review comments for PR #${number}`);
      // {owner}/{repo} placeholders resolve from GH_REPO (set in this connector's env).
      // --paginate (M9/#157): gh's default page is 30, oldest-first — a
      // heavily-commented PR would silently drop exactly the newest round's
      // feedback. Verified against the real REST endpoint (single JSON array
      // response) that --paginate concatenates every page into one array, so
      // the JSON.parse below is unaffected.
      // ACCEPTED FOLLOW-UP (M9, second half): comments from already-resolved
      // review threads are still returned and re-enter the rework fix-list,
      // so an agent can burn a rework round re-addressing settled feedback.
      // The REST endpoint has no isResolved; filtering needs the GraphQL
      // reviewThreads API (or a created_at > last agent push cutoff).
      const output = yield* execGh(["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate"]);
      const parsed = JSON.parse(output) as Array<{
        path?: string;
        line?: number | null;
        original_line?: number | null;
        body?: string;
        user?: { login?: string };
        author_association?: string;
      }>;
      // M2/#157: same trust filter as listPullRequestReviews — an inline
      // comment from an untrusted association must never reach the fix-list.
      return parsed
        .filter((c) => TRUSTED_AUTHOR_ASSOCIATIONS.has(c.author_association ?? ""))
        .map((c) => ({
          file: c.path ?? "",
          line: c.line ?? c.original_line ?? undefined,
          body: c.body ?? "",
          author: c.user?.login ?? "unknown",
        }));
    });

  /** Re-request review from `reviewers` (F4 #157) — used after a rework push, never to open a new PR. */
  const requestReview = (
    number: number,
    reviewers: string[]
  ): Effect.Effect<void, GitHubCliError> =>
    Effect.gen(function* () {
      yield* ensureNumber(number);
      if (reviewers.length === 0) return;
      for (const login of reviewers) {
        if (!LOGIN_RE.test(login)) {
          return yield* Effect.fail(new GitHubCliError(`Invalid GitHub login: ${login}`));
        }
      }
      yield* Effect.log(`[GitHub] Re-requesting review on PR #${number} from ${reviewers.join(", ")}`);
      yield* execGh([
        "api", `repos/{owner}/{repo}/pulls/${number}/requested_reviewers`,
        "-X", "POST",
        ...reviewers.flatMap((login) => ["-f", `reviewers[]=${login}`]),
      ]);
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

  // createIssue/createMilestone (F5 #161): the research pipeline's delivery
  // needs to MINT issues/milestones, not just read them. Both go through
  // `gh api` (not `gh issue create`) so the milestone is linked by NUMBER
  // (-F milestone=N) rather than gh's fragile title match, and both return the
  // REST html_url directly in one call — same argv-only discipline as
  // requestReview's `gh api ... -f 'reviewers[]=...'`. The {owner}/{repo}
  // placeholders resolve from GH_REPO in this connector's env; title/body/labels
  // are distinct argv elements, so card-derived text never reaches a shell.
  const createMilestone = (
    title: string,
    description?: string
  ): Effect.Effect<{ number: number; url: string }, GitHubCliError> =>
    Effect.gen(function* () {
      yield* Effect.log(`[GitHub] Creating milestone: ${title}`);
      const args = ["api", "repos/{owner}/{repo}/milestones", "-X", "POST", "-f", `title=${title}`];
      if (description !== undefined) args.push("-f", `description=${description}`);
      const output = yield* execGh(args);
      const parsed = JSON.parse(output) as { number: number; html_url: string };
      return { number: parsed.number, url: parsed.html_url };
    });

  const createIssue = (
    title: string,
    body: string,
    opts?: { milestone?: number; labels?: string[] }
  ): Effect.Effect<{ number: number; url: string }, GitHubCliError> =>
    Effect.gen(function* () {
      // `-F` (not `-f`) sends milestone as a JSON number, which the REST API
      // requires — a stringified `-f milestone=42` is rejected as a bad type.
      if (opts?.milestone !== undefined) yield* ensureNumber(opts.milestone);
      yield* Effect.log(`[GitHub] Creating issue: ${title}`);
      const args = [
        "api", "repos/{owner}/{repo}/issues", "-X", "POST",
        "-f", `title=${title}`, "-f", `body=${body}`,
      ];
      if (opts?.milestone !== undefined) args.push("-F", `milestone=${opts.milestone}`);
      for (const label of opts?.labels ?? []) args.push("-f", `labels[]=${label}`);
      const output = yield* execGh(args);
      const parsed = JSON.parse(output) as { number: number; html_url: string };
      return { number: parsed.number, url: parsed.html_url };
    });

  return {
    fetchIssue,
    listIssues,
    listPullRequests,
    getOpenPrByBranch,
    getPullRequest,
    createPullRequest,
    createIssue,
    createMilestone,
    addComment,
    commentOnPullRequest,
    listPullRequestReviews,
    listReviewComments,
    requestReview,
  };
};
