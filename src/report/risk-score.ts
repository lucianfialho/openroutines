/**
 * Risk radar + green lane (F4 #158, D29).
 *
 * Deterministic (zero-LLM) scoring over signals Verify / adversarial review
 * already emit (03-PIPELINE-EXECUCAO.md "Verify" row, once the sibling SAST
 * issue lands: `{diffLoc, dataChanges, semgrepFindings[],
 * dependencyAudit{new[],vulnerable[]}}`). Ranks the PR queue, assembles the
 * "🎯 Revise isto primeiro" section, and flags PRs safe enough for the
 * green-lane batch-merge block. The merge itself always stays a human running
 * `gh pr merge` from their own machine — this module never calls gh, git, or
 * the network; it only builds text.
 *
 * Weights are named constants here, not a versioned policy.yaml (that's
 * D32/F5) — tune by editing a constant, not by adding config surface.
 */

// --- calculateRiskScore weights: LOC low, security/data/deps high, findings/tests/visual medium ---
const WEIGHT_PER_DIFF_LOC = 0.2;
const WEIGHT_DATA_CHANGES = 25;
const WEIGHT_AUTH_OR_MONEY = 25;
const WEIGHT_PER_NEW_DEPENDENCY = 15;
const WEIGHT_PER_LOW_CONFIDENCE_FINDING = 8;
const WEIGHT_NEGATIVE_TEST_DELTA = 10;
const WEIGHT_LOW_VISUAL_CONFIDENCE = 10;

// --- estimateReviewMinutes weights: own scale (minutes), not a reuse of the score weights above ---
const BASE_REVIEW_MINUTES = 2;
const MINUTES_PER_DIFF_LOC = 0.1;
const MINUTES_DATA_CHANGES = 5;
const MINUTES_AUTH_OR_MONEY = 5;
const MINUTES_PER_NEW_DEPENDENCY = 3;
const MINUTES_PER_LOW_CONFIDENCE_FINDING = 2;
const MINUTES_NEGATIVE_TEST_DELTA = 3;
const MINUTES_LOW_VISUAL_CONFIDENCE = 3;
const MIN_REVIEW_MINUTES = 1;

/** isGreenLane's visual-confidence gate; an *undefined* visualConfidence (no visual phase ran) passes. */
const VISUAL_CONFIDENCE_THRESHOLD = 0.9;
/** "achados<8" / "semgrep<8" (08-DECISOES-E-RISCOS.md D26/D29): a finding's own confidence below this counts as low-confidence. */
export const LOW_FINDING_CONFIDENCE = 0.8;
/** isGreenLane's own LOC ceiling. */
const GREEN_LANE_MAX_DIFF_LOC = 80;
/** Default number of hunks surfaced in "🎯 Revise isto primeiro" (2-3 per D29). */
const DEFAULT_TOP_HUNKS = 3;

/** Path substrings that make a hunk (or a whole PR) security/money-sensitive — D29's "auth/payment/migration/webhook". */
const SENSITIVE_PATH_RE = /(auth|payment|migrat|webhook)/i;

export interface RiskScoreInput {
  diffLoc: number;
  dataChanges: boolean;
  touchesAuthOrMoney: boolean;
  newDependencies: number;
  lowConfidenceFindings: number;
  /** Raw semgrep finding count (#158/#185 H10) — unlike lowConfidenceFindings, this is never 0 by construction when SemgrepFinding lacks `confidence`; isGreenLane needs the real count, not the confidence-filtered one. */
  semgrepFindingsCount: number;
  testDelta: number;
  visualConfidence?: number;
  repoCritical: boolean;
}

export interface RiskyHunk {
  file: string;
  startLine: number;
  endLine: number;
  reason: string;
}

/** True if `file`'s path touches auth, payment, a migration, or a webhook — the paths D29 always wants surfaced first. */
export const isSensitivePath = (file: string): boolean => SENSITIVE_PATH_RE.test(file);

/** Count of findings whose own confidence is below LOW_FINDING_CONFIDENCE. A finding with no confidence field is treated as high-confidence (not counted) rather than guessed at. */
export const countLowConfidenceFindings = (findings: Array<{ confidence?: number }> | undefined): number =>
  (findings ?? []).filter((f) => typeof f.confidence === "number" && f.confidence < LOW_FINDING_CONFIDENCE).length;

export const calculateRiskScore = (input: RiskScoreInput): number => {
  let score = input.diffLoc * WEIGHT_PER_DIFF_LOC;
  if (input.dataChanges) score += WEIGHT_DATA_CHANGES;
  if (input.touchesAuthOrMoney) score += WEIGHT_AUTH_OR_MONEY;
  score += input.newDependencies * WEIGHT_PER_NEW_DEPENDENCY;
  score += input.lowConfidenceFindings * WEIGHT_PER_LOW_CONFIDENCE_FINDING;
  if (input.testDelta < 0) score += WEIGHT_NEGATIVE_TEST_DELTA;
  if (input.visualConfidence !== undefined && input.visualConfidence < VISUAL_CONFIDENCE_THRESHOLD) {
    score += WEIGHT_LOW_VISUAL_CONFIDENCE;
  }
  return Math.round(score);
};

export const estimateReviewMinutes = (input: RiskScoreInput): number => {
  let minutes = BASE_REVIEW_MINUTES + input.diffLoc * MINUTES_PER_DIFF_LOC;
  if (input.dataChanges) minutes += MINUTES_DATA_CHANGES;
  if (input.touchesAuthOrMoney) minutes += MINUTES_AUTH_OR_MONEY;
  minutes += input.newDependencies * MINUTES_PER_NEW_DEPENDENCY;
  minutes += input.lowConfidenceFindings * MINUTES_PER_LOW_CONFIDENCE_FINDING;
  if (input.testDelta < 0) minutes += MINUTES_NEGATIVE_TEST_DELTA;
  if (input.visualConfidence !== undefined && input.visualConfidence < VISUAL_CONFIDENCE_THRESHOLD) {
    minutes += MINUTES_LOW_VISUAL_CONFIDENCE;
  }
  return Math.max(MIN_REVIEW_MINUTES, Math.round(minutes));
};

/**
 * `opts.enabled` is the GREEN_LANE_ENABLED kill switch — read from env by
 * whoever calls this in the `pr` phase, never inside this pure module.
 * `false` always wins, even over an otherwise 100%-green input.
 */
export const isGreenLane = (input: RiskScoreInput, opts: { enabled: boolean }): boolean =>
  opts.enabled &&
  input.diffLoc <= GREEN_LANE_MAX_DIFF_LOC &&
  !input.dataChanges &&
  !input.touchesAuthOrMoney &&
  input.newDependencies === 0 &&
  input.lowConfidenceFindings === 0 &&
  input.semgrepFindingsCount === 0 &&
  (input.visualConfidence === undefined || input.visualConfidence >= VISUAL_CONFIDENCE_THRESHOLD) &&
  !input.repoCritical;

/** Sensitive-path hunks first, then largest hunks — D29's "arquivos tocando auth/payment/migration/webhook primeiro, depois maiores hunks". */
export const pickTopRiskyHunks = (hunks: RiskyHunk[], n: number = DEFAULT_TOP_HUNKS): RiskyHunk[] =>
  [...hunks]
    .sort((a, b) => {
      const sensitiveDelta = Number(isSensitivePath(b.file)) - Number(isSensitivePath(a.file));
      if (sensitiveDelta !== 0) return sensitiveDelta;
      return b.endLine - b.startLine - (a.endLine - a.startLine);
    })
    .slice(0, n);

const hunkPermalink = (repo: string, sha: string, hunk: RiskyHunk): string =>
  `https://github.com/${repo}/blob/${sha}/${hunk.file}#L${hunk.startLine}-L${hunk.endLine}`;

/** The "🎯 Revise isto primeiro" section — belongs at the TOP of the PR body, never inside the collapsed evidence `<details>`. */
export const buildRiskSection = (input: { repo: string; sha: string; hunks: RiskyHunk[]; minutes: number }): string => {
  const body =
    input.hunks.length > 0
      ? input.hunks
          .map((h) => `- [${h.file}#L${h.startLine}-L${h.endLine}](${hunkPermalink(input.repo, input.sha, h)}) — ${h.reason}`)
          .join("\n")
      : "Nenhum hunk de risco identificado automaticamente — revise o diff completo.";
  return ["## 🎯 Revise isto primeiro", "", `⏱️ ~${input.minutes} min`, "", body].join("\n");
};

/**
 * One `gh pr merge --squash` per PR, chained with `&&` — text only, never
 * executed here, no network call.
 *
 * M6: `gh pr merge <prUrl> --squash` (not `owner/repo#123`, which `gh`
 * mis-parses as a branch name and which cross-repo batches need `-R` for
 * anyway) — the full URL is unambiguous regardless of which repo `gh` is
 * invoked from. Callers must already have filtered out entries with no URL.
 */
export const buildGreenLaneBlock = (prs: Array<{ prUrl: string; diffSummary: string }>): string => {
  if (prs.length === 0) return "";
  const items = prs.map((p) => `- **${p.prUrl}** — ${p.diffSummary}`);
  const mergeCommand = prs.map((p) => `gh pr merge ${p.prUrl} --squash`).join(" && ");
  return ["## 🟢 Faixa verde — merge em lote", "", ...items, "", "```bash", mergeCommand, "```"].join("\n");
};
