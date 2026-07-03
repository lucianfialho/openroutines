/**
 * Repo Registry Schema
 *
 * Zod validation for repos.yaml (repo name -> clone path, base branch, verify
 * commands). Resolved per card/execution, never bound at process boot.
 */

import { z } from "zod";

export const RepoConfigSchema = z.object({
  clonePath: z.string().min(1),
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "esperado owner/repo"),
  baseBranch: z
    .string()
    .refine(
      (b) => b !== "main" && b !== "master",
      "baseBranch nunca pode ser main/master (nenhuma transição toca a main)"
    ),
  verify: z.object({
    install: z.string().optional(),
    build: z.string(),
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string(),
  }),
  compose: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
});

export const RepoRegistrySchema = z.object({
  repos: z.record(z.string(), RepoConfigSchema),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type RepoRegistry = z.infer<typeof RepoRegistrySchema>;
