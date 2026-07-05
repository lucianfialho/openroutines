/**
 * Repo Registry Parser
 *
 * Parse repos.yaml into a typed RepoRegistry. The YAML is a partial override
 * (RepoConfigInputSchema); this resolves each entry against REPOS_BASE_DIR and
 * static defaults so the engine always sees a complete RepoConfig. On-disk
 * detection (githubRepo/verify/base branch from a real clone) is discovery.ts's
 * job — this stays pure/synchronous (no fs) so a bare `name: {}` still parses.
 */

import { join } from "path";
import { parse } from "yaml";
import { RepoRegistryInputSchema, RepoConfigSchema, DEFAULT_BASE_BRANCH, VERIFY_DEFAULTS } from "./schema.js";
import type { RepoConfig, RepoConfigInput, RepoRegistry } from "./schema.js";

export class RepoRegistryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRegistryParseError";
  }
}

/**
 * Resolve one partial entry into a complete RepoConfig. clonePath comes from
 * the entry or from REPOS_BASE_DIR/<slug>; githubRepo is left "" when unknown
 * (ensure-clone resolves it at runtime); baseBranch/verify fall back to
 * static defaults (discovery refines them from a real clone). The result is
 * re-validated against RepoConfigSchema so main/master and a malformed
 * githubRepo are still rejected here.
 */
export const resolveRepoConfig = (slug: string, input: RepoConfigInput, baseDir?: string): RepoConfig => {
  const clonePath = input.clonePath ?? (baseDir ? join(baseDir, slug) : undefined);
  if (!clonePath) {
    throw new RepoRegistryParseError(
      `repo '${slug}': no clonePath declared and no REPOS_BASE_DIR to derive one`
    );
  }
  const resolved = {
    clonePath,
    githubRepo: input.githubRepo ?? "",
    baseBranch: input.baseBranch ?? DEFAULT_BASE_BRANCH,
    verify: input.verify ?? VERIFY_DEFAULTS.npm,
    compose: input.compose ?? null,
    labels: input.labels,
    critical: input.critical ?? false,
    family: input.family,
  };
  const check = RepoConfigSchema.safeParse(resolved);
  if (!check.success) {
    throw new RepoRegistryParseError(
      `repo '${slug}': ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }
  return check.data;
};

export const parseRepoRegistry = (yamlContent: string, baseDir?: string): RepoRegistry => {
  const raw = parse(yamlContent) as unknown;

  if (raw != null && typeof raw !== "object") {
    throw new RepoRegistryParseError("Repo registry YAML must be an object");
  }

  const result = RepoRegistryInputSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new RepoRegistryParseError(`Invalid repo registry: ${issues}`);
  }

  const repos: Record<string, RepoConfig> = {};
  for (const [slug, input] of Object.entries(result.data.repos)) {
    repos[slug] = resolveRepoConfig(slug, input, baseDir);
  }
  return { repos };
};
