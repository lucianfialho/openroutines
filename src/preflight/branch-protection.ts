/**
 * Branch-protection preflight check (issue #151).
 *
 * Verifies — server-side, via the GitHub API — that a repo's branch requires a
 * pull request before merge, by EITHER of the two GitHub mechanisms:
 *   1. classic branch protection (`/branches/{b}/protection` with
 *      required_pull_request_reviews) — Pro/Team, or any public repo;
 *   2. a repository RULESET with a `pull_request` rule on the branch
 *      (`/rules/branches/{b}`) — available on PRIVATE repos in the free plan,
 *      where classic protection is not.
 * Fail-closed by construction: any outcome other than a confirmed PR
 * requirement returns protected:false, never assuming protection on
 * error/timeout/partial config.
 */

export interface BranchProtectionResult {
  protected: boolean;
  reason?: string; // populado quando protected=false
}

const NO_PROTECTION = "sem branch protection configurada";

export const checkBranchProtection = async (
  deps: { token: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  owner: string,
  repo: string,
  branch: string = "main"
): Promise<BranchProtectionResult> => {
  const doFetch = deps.fetchImpl ?? fetch; // fetch nativo do Node 20+, sem dependência nova
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const headers = { Authorization: `Bearer ${deps.token}`, Accept: "application/vnd.github+json" };
  const opts = () => ({ headers, signal: AbortSignal.timeout(timeoutMs) });
  try {
    // 1. Classic branch protection.
    const res = await doFetch(
      `https://api.github.com/repos/${owner}/${repo}/branches/${branch}/protection`,
      opts()
    );
    if (res.ok) {
      const body = (await res.json()) as { required_pull_request_reviews?: unknown };
      return body?.required_pull_request_reviews
        ? { protected: true }
        : { protected: false, reason: "protection ativa mas sem required_pull_request_reviews" };
    }
    // Only 404 ("no classic protection") is worth a rulesets fallback; any other
    // non-OK status is a genuine API failure and stays fail-closed.
    if (res.status !== 404) return { protected: false, reason: `falha ao consultar API do GitHub: HTTP ${res.status}` };

    // 2. Fallback: rulesets. The "rules for a branch" endpoint returns the
    // EFFECTIVE rules from every active ruleset applying to the branch; a
    // `pull_request` rule means a PR is required to merge (works on private
    // repos in the free plan, where classic protection returns 403/404).
    const rulesRes = await doFetch(
      `https://api.github.com/repos/${owner}/${repo}/rules/branches/${branch}`,
      opts()
    );
    if (!rulesRes.ok) {
      return { protected: false, reason: rulesRes.status === 404 ? NO_PROTECTION : `falha ao consultar API do GitHub: HTTP ${rulesRes.status}` };
    }
    const rules = (await rulesRes.json()) as Array<{ type?: string }>;
    return Array.isArray(rules) && rules.some((r) => r?.type === "pull_request")
      ? { protected: true }
      : { protected: false, reason: NO_PROTECTION };
  } catch (err) {
    // Fail closed on ANY error path — network/DNS failure, timeout, malformed
    // JSON body. Never assume protection when the check itself did not succeed.
    return {
      protected: false,
      reason: `falha ao consultar API do GitHub: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
