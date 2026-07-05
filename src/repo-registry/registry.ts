/**
 * Repo Registry
 *
 * Resolve a repo config by registry key or by a card's `Repositório` field.
 * The registry is the union of auto-discovery over REPOS_BASE_DIR and an
 * OPTIONAL repos.yaml override (yaml wins on conflict). A pure baseDir install
 * needs no repos.yaml at all; a card naming a repo absent from BOTH is cloned
 * lazily at preparation time (ensure-clone.ts).
 */

import { readFileSync } from "fs";
import { parseRepoRegistry, RepoRegistryParseError } from "./parser.js";
import { discoverRepos } from "./discovery.js";
import type { RepoConfig, RepoRegistry } from "./schema.js";

export const loadRepoRegistry = (path?: string, baseDir?: string): RepoRegistry => {
  const filePath = path ?? process.env.REPOS_REGISTRY_PATH ?? "./repos.yaml";
  const resolvedBaseDir = baseDir ?? process.env.REPOS_BASE_DIR;

  let yamlRepos: Record<string, RepoConfig> = {};
  try {
    yamlRepos = parseRepoRegistry(readFileSync(filePath, "utf-8"), resolvedBaseDir).repos;
  } catch (err) {
    // A malformed registry is a hard error; a MISSING one is fine when
    // baseDir discovery can cover it (pure auto-discovery install).
    if (err instanceof RepoRegistryParseError) throw err;
  }

  const discovered = resolvedBaseDir ? discoverRepos(resolvedBaseDir) : {};
  return { repos: { ...discovered, ...yamlRepos } };
};

export const resolveRepo = (registry: RepoRegistry, name: string): RepoConfig | undefined =>
  registry.repos[name];

/**
 * Match a Trello card's `Repositório` field (02-FLUXO-TRELLO.md) against the
 * registry key: exact match after lowercase/trim, no fuzzy matching. Returns
 * undefined for a name absent from the registry — ensure-clone then tries to
 * clone it lazily from REPOS_BASE_DIR + ALLOWED_REPO_OWNERS.
 */
export const resolveRepoBySlug = (registry: RepoRegistry, cardRepoField: string): RepoConfig | undefined => {
  const slug = cardRepoField.trim().toLowerCase();
  for (const [key, config] of Object.entries(registry.repos)) {
    if (key.trim().toLowerCase() === slug) return config;
  }
  return undefined;
};

/** The registry key (slug) a card's `Repositório` field resolves to, or the trimmed field itself. */
export const resolveSlug = (registry: RepoRegistry, cardRepoField: string): string => {
  const slug = cardRepoField.trim().toLowerCase();
  for (const key of Object.keys(registry.repos)) {
    if (key.trim().toLowerCase() === slug) return key;
  }
  return cardRepoField.trim();
};
