/**
 * card-to-pr / verify (F3 #146, F4 #155)
 *
 * Deterministic verify-vs-baseline + forbidden-path guard + SAST (semgrep,
 * gitleaks, npm audit — see verify/sast.ts). Decides pass/retry/stall so the
 * state machine can loop back to implementacao at most once before routing to
 * bloqueado (see skill.yaml transitions).
 */
import { createHash } from "crypto";
import type { ScriptHandler } from "../../script/registry.js";
import { runVerifyCommands, type VerifyResults } from "../../verify/run-commands.js";
import { diffAgainstBaseline } from "../../verify/compare.js";
import {
  runSast,
  filterSastAgainstBaseline,
  type SemgrepFinding,
  type GitleaksFinding,
  type SastResult,
} from "../../verify/sast.js";
import type { BaselineResults } from "../../verify/baseline.js";
import { defaultRunGit, type CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";

export interface VerifyOutput {
  passed: boolean;
  attempt: number;
  failures: string[];
  newFailures: string[];
  knownFailures: string[];
  forbiddenPathsTouched: string[];
  /** Full diff --name-only list vs base (F4 #153) — the security/critical-area lens needs the real file list, not just the derived booleans. */
  changedFiles: string[];
  diffLoc: number;
  isUI: boolean;
  dataChanges: boolean;
  secretsFound: GitleaksFinding[];
  semgrepFindings: SemgrepFinding[];
  dependencyAudit: SastResult["dependencyAudit"];
  sastNotes: string[];
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

// Diff-derived, never the card's own text (F1 rule: scope decisions are
// always deterministic off the real diff) — consumed by the review phase via
// outputs.verify.isUI / outputs.verify.dataChanges.
const isUIFile = (p: string): boolean => /\.(tsx|jsx)$/.test(p);
const isDataChangeFile = (p: string): boolean => /\.prisma$/.test(p) || /(^|\/)migrations\//.test(p) || /\.sql$/.test(p);

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
  const isUI = changed.some(isUIFile);
  const dataChanges = changed.some(isDataChangeFile);

  // SAST (F4 #155): semgrep + gitleaks + npm audit, restricted to this card's
  // diff and filtered against the night's baseline snapshot so a pre-existing
  // finding never reproves a card — only what THIS diff newly introduces does
  // (same "known flaky" principle diffAgainstBaseline already applies above).
  const sastRaw = await runSast(wt, base);
  const baselineSast = (preparacao.baselineResults as BaselineResults | null | undefined)?.sast;
  const sast = filterSastAgainstBaseline(sastRaw, baselineSast);
  // Semgrep feeds the security lens (separate issue) but never gates `passed`
  // by itself — only an actual secret or a new high/critical prod
  // vulnerability does, the same bar as a broken build/test.
  const sastPassed = sast.secretsFound.length === 0 && sast.dependencyAudit.vulnerable.length === 0;

  // SECURITY: a forbidden-path touch, a new secret, or a new high/critical
  // prod vulnerability reproves deterministically, regardless of whether the
  // verify commands themselves passed.
  const passed = diff.passed && forbiddenPathsTouched.length === 0 && sastPassed;

  const sastFingerprints = [
    ...sast.secretsFound.map((f) => `secret:${f.ruleId}:${f.file}:${f.line}`),
    ...sast.dependencyAudit.vulnerable.map((v) => `vuln:${v.name}:${v.advisory}`),
  ].sort();

  const failureSignature = createHash("sha256")
    .update(
      JSON.stringify({
        newFailures: [...diff.newFailures].sort(),
        forbiddenPathsTouched: [...forbiddenPathsTouched].sort(),
        sastFingerprints,
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
    changedFiles: changed,
    diffLoc,
    isUI,
    dataChanges,
    secretsFound: sast.secretsFound,
    semgrepFindings: sast.semgrepFindings,
    dependencyAudit: sast.dependencyAudit,
    sastNotes: sastRaw.notes,
    failureSignature,
    stalled,
    retryable,
    blockReason: !passed && !retryable ? "verify-falhou" : undefined,
  } satisfies VerifyOutput;
};
