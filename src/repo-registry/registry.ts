/**
 * Repo Registry
 *
 * Load repos.yaml (env REPOS_REGISTRY_PATH, default ./repos.yaml) and resolve
 * a repo config by registry key or by a card's `Repositório` field.
 */

import { readFileSync } from "fs";
import { parseRepoRegistry } from "./parser.js";
import type { RepoConfig, RepoRegistry } from "./schema.js";

export const loadRepoRegistry = (path?: string): RepoRegistry => {
  const filePath = path ?? process.env.REPOS_REGISTRY_PATH ?? "./repos.yaml";
  return parseRepoRegistry(readFileSync(filePath, "utf-8"));
};

export const resolveRepo = (registry: RepoRegistry, name: string): RepoConfig | undefined =>
  registry.repos[name];

/**
 * Match a Trello card's `Repositório` field (02-FLUXO-TRELLO.md) against the
 * registry key: exact match after lowercase/trim, no fuzzy matching.
 */
export const resolveRepoBySlug = (registry: RepoRegistry, cardRepoField: string): RepoConfig | undefined => {
  const slug = cardRepoField.trim().toLowerCase();
  for (const [key, config] of Object.entries(registry.repos)) {
    if (key.trim().toLowerCase() === slug) return config;
  }
  return undefined;
};
