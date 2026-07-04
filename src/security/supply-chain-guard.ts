/**
 * Supply-chain guard (F4 #156)
 *
 * .openroutines/05-GUARDRAILS-SEGURANCA.md Camada 5 / 11-SEGURANCA.md: a
 * malicious/typosquat dependency added by the executor is stopped by two
 * layers this module owns:
 *
 *   (a) `ensureIgnoreScripts` merges `ignore-scripts=true` into the card's
 *       worktree `.npmrc` — lifecycle scripts (preinstall/postinstall/
 *       prepare) never run silently during install.
 *   (b) `supplyChainShimDir()` is prefixed onto the PATH of every
 *       claude-cli/kimi-cli spawn (src/provider/claude-cli.ts, kimi-cli.ts),
 *       so any `npm`/`pnpm`/`npx` the agent's Bash tool runs resolves to the
 *       shims in scripts/supply-chain/ instead of the real binaries. Those
 *       shims run a supply-chain checker (npq/socket) on any package not yet
 *       in the worktree's package.json/lockfile before ever calling the real
 *       binary — see scripts/supply-chain/_guard.sh for that logic.
 *
 * Golden rule (05): no guardrail depends on an instruction in a prompt — this
 * is a PATH/env boundary on the subprocess, never a request to the model to
 * "be careful with installs".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { delimiter, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/security/ (or dist/security/ once built) -> repo root: both source and
// compiled layouts sit exactly 2 levels under repo root, so this is the same
// absolute path either way, and independent of the caller's cwd.
const REPO_ROOT = join(__dirname, "..", "..");

/** Absolute path to the npm/pnpm/npx guard shims — prefix onto a spawn's PATH. */
export const supplyChainShimDir = (): string => join(REPO_ROOT, "scripts", "supply-chain");

/**
 * Default location of the lifecycle-scripts allowlist that
 * scripts/supply-chain/_guard.sh reads (self-located there the same way —
 * see its SHIM_DIR/REPO_ROOT). Exported for tests; ensureIgnoreScripts itself
 * only merges .npmrc, it does not read the allowlist (see openDecisions).
 */
export const DEFAULT_ALLOWLIST_PATH = join(REPO_ROOT, "config", "supply-chain-allowlist.yaml");

export interface SupplyChainGuardOptions {
  /** Card's worktree — where the guarded .npmrc lives. */
  worktree: string;
  /** Override for the lifecycle-scripts allowlist path (default: DEFAULT_ALLOWLIST_PATH). */
  allowlistPath?: string;
}

const IGNORE_SCRIPTS_LINE = "ignore-scripts=true";
const IGNORE_SCRIPTS_RE = /^\s*ignore-scripts\s*=/;

/**
 * Ensure `<worktree>/.npmrc` sets `ignore-scripts=true`, merging into
 * whatever is already there rather than overwriting it: existing lines are
 * preserved as-is, an existing `ignore-scripts=` line (any value) is
 * rewritten to `true` — the guardrail always wins over a repo's own
 * checked-in .npmrc — and if there is no such line yet, one is appended.
 * Idempotent: a second call on an already-guarded worktree is a no-op write.
 */
export const ensureIgnoreScripts = ({ worktree }: SupplyChainGuardOptions): void => {
  mkdirSync(worktree, { recursive: true });
  const npmrcPath = join(worktree, ".npmrc");
  const existing = existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf-8") : "";

  const lines = existing.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // drop the trailing "" from a final newline

  const idx = lines.findIndex((l) => IGNORE_SCRIPTS_RE.test(l));
  if (idx >= 0) lines[idx] = IGNORE_SCRIPTS_LINE;
  else lines.push(IGNORE_SCRIPTS_LINE);

  const next = lines.join("\n") + "\n";
  if (next !== existing) writeFileSync(npmrcPath, next, "utf-8");
};

/** Prefix supplyChainShimDir() onto env.PATH — same shape for every spawn's env. */
export const withSupplyChainPath = (env: Record<string, string>): Record<string, string> => ({
  ...env,
  PATH: [supplyChainShimDir(), env.PATH].filter((p): p is string => Boolean(p)).join(delimiter),
});
