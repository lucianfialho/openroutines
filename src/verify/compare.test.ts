import { describe, it, expect } from "vitest";
import { diffAgainstBaseline } from "./compare.js";
import type { VerifyResults } from "./run-commands.js";

const results = (partial: Partial<VerifyResults>): VerifyResults =>
  ({ build: undefined, typecheck: undefined, lint: undefined, test: undefined, ...partial });

describe("diffAgainstBaseline", () => {
  it("splits a mix of known (already failing in baseline) and new failures (AC3)", () => {
    const baseline = results({ lint: { passed: false } });
    const current = results({ lint: { passed: false }, test: { passed: false } });

    const diff = diffAgainstBaseline(baseline, current);

    expect(diff.knownFailures).toEqual(["lint"]);
    expect(diff.newFailures).toEqual(["test"]);
    expect(diff.passed).toBe(false);
  });

  it("does NOT block on a known failure that recurs with nothing new — the headline scenario", () => {
    const baseline = results({ lint: { passed: false } }); // base branch already fails lint
    const current = results({ build: { passed: true }, lint: { passed: false } }); // same known failure, nothing new

    const diff = diffAgainstBaseline(baseline, current);

    expect(diff.knownFailures).toEqual(["lint"]);
    expect(diff.newFailures).toEqual([]);
    expect(diff.passed).toBe(true);
  });

  it("passes with empty arrays when baseline and current are identical and all green (AC4)", () => {
    const allGreen = results({
      build: { passed: true },
      typecheck: { passed: true },
      lint: { passed: true },
      test: { passed: true },
    });

    expect(diffAgainstBaseline(allGreen, allGreen)).toEqual({
      newFailures: [],
      knownFailures: [],
      passed: true,
    });
  });

  it("treats a command the baseline never had configured as new territory on failure", () => {
    const baseline = results({ build: { passed: true } }); // typecheck wasn't configured at baseline time
    const current = results({ build: { passed: true }, typecheck: { passed: false } });

    const diff = diffAgainstBaseline(baseline, current);

    expect(diff.newFailures).toEqual(["typecheck"]);
    expect(diff.knownFailures).toEqual([]);
  });

  it("only inspects keys present in current — an unconfigured command is neither new nor known", () => {
    const baseline = results({ lint: { passed: false } });
    const current = results({ build: { passed: true } }); // lint/test not run this time

    expect(diffAgainstBaseline(baseline, current)).toEqual({
      newFailures: [],
      knownFailures: [],
      passed: true,
    });
  });
});
