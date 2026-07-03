/**
 * Baseline diff (F3 #150).
 *
 * Only a NEW failure — one the base branch's own verify run didn't already
 * have — blocks a card. A failure already present in the baseline is a known
 * flaky/pre-existing issue: reported via knownFailures, never blocking.
 * Comparison is per verify command (build/typecheck/lint/test), not per
 * individual test name — see issue #150's granularity cut.
 */
import { VERIFY_STEP_KEYS, type VerifyResults } from "./run-commands.js";

export interface BaselineDiff {
  newFailures: string[];
  knownFailures: string[];
  passed: boolean;
}

export const diffAgainstBaseline = (baseline: VerifyResults, current: VerifyResults): BaselineDiff => {
  const newFailures: string[] = [];
  const knownFailures: string[] = [];

  for (const key of VERIFY_STEP_KEYS) {
    const curr = current[key];
    if (!curr || curr.passed) continue; // not configured or passing: not a failure

    const alreadyFailedInBaseline = baseline[key]?.passed === false;
    (alreadyFailedInBaseline ? knownFailures : newFailures).push(key);
  }

  return { newFailures, knownFailures, passed: newFailures.length === 0 };
};
