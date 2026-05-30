/**
 * In-Memory File Metadata Repository
 */
import type { FileMetadata, FileMetadataRepository } from "./types.js";

export const makeInMemoryFileMetadataRepository = (): FileMetadataRepository => {
  const store = new Map<string, FileMetadata>();

  return {
    save: async (meta) => {
      store.set(meta.path, { ...meta, updatedAt: new Date() });
    },
    findByPath: async (path) => store.get(path),
    findByExecution: async (executionId) =>
      Array.from(store.values()).filter((m) => m.executionId === executionId),
    findByIssue: async (issueNumber) =>
      Array.from(store.values()).filter((m) => m.issueNumber === issueNumber),
  };
};
