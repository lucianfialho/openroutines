/**
 * Task Source Parser
 *
 * Parse task-sources.yaml and connector.yaml manifests into typed objects.
 * Uses Zod for strict validation.
 */

import { parse } from "yaml";
import type { ZodIssue } from "zod";
import { TaskSourcesFileSchema, ConnectorManifestSchema } from "./schema.js";
import type { TaskSourcesFile, ConnectorManifest } from "./schema.js";

export class TaskSourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSourceConfigError";
  }
}

const formatIssues = (issues: ZodIssue[]): string =>
  issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

export const parseTaskSourcesFile = (yamlContent: string): TaskSourcesFile => {
  const raw = parse(yamlContent) as unknown;

  if (!raw || typeof raw !== "object") {
    throw new TaskSourceConfigError("task-sources.yaml must be an object");
  }

  const result = TaskSourcesFileSchema.safeParse(raw);
  if (!result.success) {
    throw new TaskSourceConfigError(`Invalid task-sources.yaml: ${formatIssues(result.error.issues)}`);
  }

  return result.data;
};

export const parseConnectorManifest = (yamlContent: string): ConnectorManifest => {
  const raw = parse(yamlContent) as unknown;

  if (!raw || typeof raw !== "object") {
    throw new TaskSourceConfigError("connector.yaml must be an object");
  }

  const result = ConnectorManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new TaskSourceConfigError(`Invalid connector.yaml: ${formatIssues(result.error.issues)}`);
  }

  return result.data;
};
