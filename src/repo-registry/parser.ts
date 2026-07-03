/**
 * Repo Registry Parser
 *
 * Parse repos.yaml into a typed RepoRegistry. Uses Zod for strict validation.
 */

import { parse } from "yaml";
import { RepoRegistrySchema } from "./schema.js";
import type { RepoRegistry } from "./schema.js";

export class RepoRegistryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRegistryParseError";
  }
}

export const parseRepoRegistry = (yamlContent: string): RepoRegistry => {
  const raw = parse(yamlContent) as unknown;

  if (!raw || typeof raw !== "object") {
    throw new RepoRegistryParseError("Repo registry YAML must be an object");
  }

  const result = RepoRegistrySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new RepoRegistryParseError(`Invalid repo registry: ${issues}`);
  }

  return result.data;
};
