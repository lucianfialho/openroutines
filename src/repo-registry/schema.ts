/**
 * Repo Registry Schema
 *
 * Two shapes:
 *  - RepoConfigSchema — the RESOLVED config the engine consumes (every
 *    runtime-required field present). Unchanged contract.
 *  - RepoConfigInputSchema — what repos.yaml may declare: every field optional.
 *    The loader fills the gaps from REPOS_BASE_DIR (clonePath) and on-disk
 *    detection (githubRepo/baseBranch/verify), so a repo can be a bare
 *    `name: {}` and still resolve. Resolved per card/execution, never bound at
 *    process boot.
 */

import { z } from "zod";

/** Verify command presets by lockfile-detected package manager (discovery.ts). */
export const VERIFY_DEFAULTS = {
  npm: { install: "npm ci", build: "npm run build", typecheck: "npx tsc --noEmit", lint: "npm run lint", test: "npm test -- --run" },
  pnpm: { install: "pnpm install --frozen-lockfile", build: "pnpm run build", typecheck: "pnpm exec tsc --noEmit", lint: "pnpm run lint", test: "pnpm test" },
  yarn: { install: "yarn install --frozen-lockfile", build: "yarn build", typecheck: "yarn tsc --noEmit", lint: "yarn lint", test: "yarn test" },
  bun: { install: "bun install", build: "bun run build", typecheck: "bunx tsc --noEmit", lint: "bun run lint", test: "bun test" },
} as const;

/** Base branch used when a repo declares none — never main/master (D14). */
export const DEFAULT_BASE_BRANCH = "development";

const notMainMaster = (b: string): boolean => b !== "main" && b !== "master";
const NOT_MAIN_MSG = "baseBranch nunca pode ser main/master (nenhuma transição toca a main)";
const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const VerifySchema = z.object({
  install: z.string().optional(),
  build: z.string(),
  typecheck: z.string().optional(),
  lint: z.string().optional(),
  test: z.string(),
});

// Resolved config (all runtime-required fields present). githubRepo may be ""
// only transiently: ensure-clone resolves it before preparation uses it.
export const RepoConfigSchema = z.object({
  clonePath: z.string().min(1),
  githubRepo: z.union([z.string().regex(GITHUB_REPO_RE, "esperado owner/repo"), z.literal("")]),
  baseBranch: z.string().refine(notMainMaster, NOT_MAIN_MSG),
  verify: VerifySchema,
  compose: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  /** F4 #158 (D29): repos exempt from the green lane regardless of how clean the diff is. */
  critical: z.boolean().default(false),
  /** F5 #164 (D26): product-family grouping — sibling-fix propagation only ever targets repos sharing this value. */
  family: z.string().optional(),
});

// Input schema (repos.yaml) — every field optional; the loader fills the rest.
export const RepoConfigInputSchema = z.object({
  clonePath: z.string().min(1).optional(),
  githubRepo: z.string().regex(GITHUB_REPO_RE, "esperado owner/repo").optional(),
  baseBranch: z.string().refine(notMainMaster, NOT_MAIN_MSG).optional(),
  verify: VerifySchema.optional(),
  compose: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  critical: z.boolean().optional(),
  family: z.string().optional(),
});

export const RepoRegistrySchema = z.object({
  repos: z.record(z.string(), RepoConfigSchema),
});

export const RepoRegistryInputSchema = z.object({
  repos: z.record(z.string(), RepoConfigInputSchema).optional().default({}),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type RepoConfigInput = z.infer<typeof RepoConfigInputSchema>;
export type RepoRegistry = z.infer<typeof RepoRegistrySchema>;
