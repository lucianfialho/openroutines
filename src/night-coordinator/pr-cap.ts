/**
 * Per-night and per-repo PR backpressure (F3 #147).
 *
 * Two independent caps, either one can deny: the GLOBAL cap (how many PRs the
 * whole night is allowed to have open, via pr_links joined to this night's
 * executions) and a PER-REPO cap (never pile more than `perRepoOpenPrCap`
 * openroutines/card-* branches open on one repo, regardless of the global
 * budget) so one noisy repo can't starve every other repo's slice of the
 * night.
 */
import { Effect } from "effect";
import { makeGitHubConnector } from "../connector/github.js";
import { resolveRepo, resolveRepoBySlug } from "../repo-registry/registry.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { PrLinkRepository } from "../persistence/types.js";

const CARD_BRANCH_PREFIX = "openroutines/card-";
// ponytail: pre-#168 default (was the hardcoded cap). perRepoOpenPrCap is
// OPTIONAL only so night-coordinator/run.ts and app.ts — not this file's
// scope — keep compiling before they're wired to
// loadPolicy().backpressure.max_open_prs_per_repo; once both pass it
// explicitly, this fallback is dead code. Remove it then.
const DEFAULT_PER_REPO_OPEN_PR_CAP = 3;

export interface CanOpenPrDeps {
  prLinks: PrLinkRepository;
  nightPrCap: number;
  /** Per-repo open-PR cap (F5 #168, D32: `policy.yaml`'s `backpressure.max_open_prs_per_repo`). Defaults to 3 — see the ponytail note above DEFAULT_PER_REPO_OPEN_PR_CAP. */
  perRepoOpenPrCap?: number;
  githubToken: string;
  registry: RepoRegistry;
  /** Injectable seam for tests; defaults to the real gh-CLI connector. */
  makeGithub?: (cfg: { token: string; repo: string }) => ReturnType<typeof makeGitHubConnector>;
}

export const canOpenPr = async (
  deps: CanOpenPrDeps,
  args: { nightId: string; repo: string }
): Promise<boolean> => {
  const globalOpen = await deps.prLinks.countOpenForNight(args.nightId);
  if (globalOpen >= deps.nightPrCap) return false;

  const repoConfig = resolveRepoBySlug(deps.registry, args.repo) ?? resolveRepo(deps.registry, args.repo);
  if (!repoConfig) return false; // unresolvable repo — treat as backpressure, never as a crash here

  const makeGithub = deps.makeGithub ?? makeGitHubConnector;
  const github = makeGithub({ token: deps.githubToken, repo: repoConfig.githubRepo });

  let prs: Array<{ state: string; headRefName: string }>;
  try {
    prs = await Effect.runPromise(github.listPullRequests());
  } catch {
    // Fail closed: an unreachable GitHub API is not a green light to open
    // more PRs than we can verify are safe. The card is retried next cycle.
    return false;
  }

  const openCardPrs = prs.filter(
    (pr) => pr.state.toLowerCase() === "open" && pr.headRefName.startsWith(CARD_BRANCH_PREFIX)
  );
  return openCardPrs.length < (deps.perRepoOpenPrCap ?? DEFAULT_PER_REPO_OPEN_PR_CAP);
};
