/**
 * Branch-protection preflight check (issue #151).
 *
 * Verifies — server-side, via the GitHub API — that a repo's branch has
 * required_pull_request_reviews configured before any card is allowed to run
 * against it. Fail-closed by construction: any outcome other than "200 +
 * required_pull_request_reviews present" returns protected:false, never
 * assuming protection on error/timeout/partial config.
 */

export interface BranchProtectionResult {
  protected: boolean;
  reason?: string; // populado quando protected=false
}

export const checkBranchProtection = async (
  deps: { token: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  owner: string,
  repo: string,
  branch: string = "main"
): Promise<BranchProtectionResult> => {
  const doFetch = deps.fetchImpl ?? fetch; // fetch nativo do Node 20+, sem dependência nova
  const timeoutMs = deps.timeoutMs ?? 10_000;
  try {
    const res = await doFetch(
      `https://api.github.com/repos/${owner}/${repo}/branches/${branch}/protection`,
      {
        headers: { Authorization: `Bearer ${deps.token}`, Accept: "application/vnd.github+json" },
        // A hung connection to api.github.com must fail closed, not block forever.
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    if (res.status === 404) return { protected: false, reason: "sem branch protection configurada" };
    if (!res.ok) return { protected: false, reason: `falha ao consultar API do GitHub: HTTP ${res.status}` };
    const body = (await res.json()) as { required_pull_request_reviews?: unknown };
    return body?.required_pull_request_reviews
      ? { protected: true }
      : { protected: false, reason: "protection ativa mas sem required_pull_request_reviews" };
  } catch (err) {
    // Fail closed on ANY error path — network/DNS failure, timeout, malformed
    // JSON body. Never assume protection when the check itself did not succeed.
    return {
      protected: false,
      reason: `falha ao consultar API do GitHub: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
