/**
 * Task Source Loader
 *
 * Load the task-sources.yaml manifest (registered source instances) plus
 * the connector.yaml manifest each entry resolves to.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseTaskSourcesFile, parseConnectorManifest } from "./parser.js";
import type { TaskSourceEntry, ConnectorManifest } from "./schema.js";

export interface ResolvedTaskSource {
  entry: TaskSourceEntry;
  manifest: ConnectorManifest;
}

const defaultManifestPath = (type: string): string => join(".gates", "connectors", type, "connector.yaml");

export const loadTaskSources = (rootDir = "."): ResolvedTaskSource[] => {
  const taskSourcesFile = process.env.TASK_SOURCES_FILE ?? "./task-sources.yaml";
  const filePath = join(rootDir, taskSourcesFile);

  if (!existsSync(filePath)) {
    return [];
  }

  const { sources } = parseTaskSourcesFile(readFileSync(filePath, "utf-8"));

  return sources.map((entry) => {
    const manifestPath = join(rootDir, entry.manifest ?? defaultManifestPath(entry.type));
    const manifest = parseConnectorManifest(readFileSync(manifestPath, "utf-8"));
    return { entry, manifest };
  });
};
