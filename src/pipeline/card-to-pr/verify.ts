/**
 * card-to-pr / verify (F3 #146)
 *
 * Deterministic verify-vs-baseline + forbidden-path guard. Decides
 * pass/retry/stall so the state machine can loop back to implementacao at
 * most once before routing to bloqueado (see skill.yaml transitions).
 */
import { createHash } from "crypto";
import type { ScriptHandler } from "../../script/registry.js";
import { runVerifyCommands, type VerifyResults } from "../../verify/run-commands.js";
import { diffAgainstBaseline } from "../../verify/compare.js";
import { defaultRunGit, type CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";

export interface VerifyOutput {
  passed: boolean;
  attempt: number;
  failures: string[];
  newFailures: string[];
  knownFailures: string[];
  forbiddenPathsTouched: string[];
  diffLoc: number;
  failureSignature: string;
  stalled: boolean;
  retryable: boolean;
  blockReason?: string;
}

// A change under .git/, a GitHub Actions workflow, a root-level dotfile, or a
// .env at ANY depth (apps/api/.env in a monorepo — secrets) is never something
// the model should be touching.
const isForbiddenPath = (p: string): boolean =>
  p.startsWith(".git/") ||
  p.startsWith(".github/workflows/") ||
  /^\.[^/]+$/.test(p) ||
  p.split("/").some((seg) => seg.startsWith(".env"));

export const makeVerify = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const preparacao = ctx.outputs.preparacao as PreparacaoOutput;
  const wt = preparacao.worktree!.path;
  const base = preparacao.baseSha!;
  const verifyCommands = preparacao.repo!.verify;

  const runVerify = deps.runVerify ?? runVerifyCommands;
  const current = await runVerify(wt, verifyCommands);

  // A missing baseline (manual run, no night_id/pool) means an empty baseline —
  // every current failure is treated as new (strict), per preparacao's contract.
  const diff = diffAgainstBaseline((preparacao.baselineResults ?? {}) as VerifyResults, current);

  const runGit = deps.runGit ?? defaultRunGit(deps.githubToken);
  const { stdout } = await runGit(["diff", "--name-only", base, "HEAD"], wt);
  const changed = stdout.split("\n").filter(Boolean);
  const forbiddenPathsTouched = changed.filter(isForbiddenPath);
  const diffLoc = changed.length; // ponytail: file count stands in for LOC for the pilot.

  // SECURITY: a forbidden-path touch reproves deterministically, regardless of
  // whether the verify commands themselves passed.
  const passed = diff.passed && forbiddenPathsTouched.length === 0;

  const failureSignature = createHash("sha256")
    .update(
      JSON.stringify({
        newFailures: [...diff.newFailures].sort(),
        forbiddenPathsTouched: [...forbiddenPathsTouched].sort(),
      })
    )
    .digest("hex");

  const prev = ctx.outputs.verify as { attempt?: number; failureSignature?: string } | undefined;
  const attempt = prev?.attempt ? prev.attempt + 1 : 1;
  const stalled = attempt > 1 && failureSignature === prev?.failureSignature;
  const retryable = !passed && !stalled && attempt <= 2;

  return {
    passed,
    attempt,
    failures: [...diff.newFailures, ...diff.knownFailures],
    newFailures: diff.newFailures,
    knownFailures: diff.knownFailures,
    forbiddenPathsTouched,
    diffLoc,
    failureSignature,
    stalled,
    retryable,
    blockReason: !passed && !retryable ? "verify-falhou" : undefined,
  } satisfies VerifyOutput;
};
