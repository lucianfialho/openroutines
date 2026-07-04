import { describe, it, expect } from "vitest";
import {
  calculateRiskScore,
  estimateReviewMinutes,
  isGreenLane,
  pickTopRiskyHunks,
  buildRiskSection,
  buildGreenLaneBlock,
  countLowConfidenceFindings,
  isSensitivePath,
  type RiskScoreInput,
  type RiskyHunk,
} from "./risk-score.js";

// Baseline: every dimension at its safest value — used both as the "lowest
// score in the range" fixture and as the green-lane happy path, tweaked per test.
const zeroInput: RiskScoreInput = {
  diffLoc: 0,
  dataChanges: false,
  touchesAuthOrMoney: false,
  newDependencies: 0,
  lowConfidenceFindings: 0,
  testDelta: 0,
  visualConfidence: undefined,
  repoCritical: false,
};

describe("calculateRiskScore", () => {
  it("input tudo zero/false devolve o menor score do range", () => {
    expect(calculateRiskScore(zeroInput)).toBe(0);
  });

  it("dataChanges+touchesAuthOrMoney+newDependencies>0 devolve score sensivelmente mais alto que a baseline", () => {
    const baseline = calculateRiskScore({ ...zeroInput, diffLoc: 10 });
    const risky = calculateRiskScore({
      ...zeroInput,
      diffLoc: 10,
      dataChanges: true,
      touchesAuthOrMoney: true,
      newDependencies: 2,
    });
    expect(risky).toBeGreaterThan(baseline * 5); // not just "higher" — a clear, deliberate jump
  });

  it("never goes negative even with every dimension at its safest value", () => {
    expect(calculateRiskScore(zeroInput)).toBeGreaterThanOrEqual(0);
  });
});

describe("estimateReviewMinutes", () => {
  it("a riskier input estimates more minutes than the zero baseline", () => {
    const risky = { ...zeroInput, diffLoc: 200, dataChanges: true, touchesAuthOrMoney: true, newDependencies: 3 };
    expect(estimateReviewMinutes(risky)).toBeGreaterThan(estimateReviewMinutes(zeroInput));
  });

  it("never estimates below the 1-minute floor", () => {
    expect(estimateReviewMinutes(zeroInput)).toBeGreaterThanOrEqual(1);
  });
});

describe("isGreenLane", () => {
  const green: RiskScoreInput = { ...zeroInput, diffLoc: 50 };

  it("100%-green input with the kill switch on returns true", () => {
    expect(isGreenLane(green, { enabled: true })).toBe(true);
  });

  it("diffLoc > 80 -> false", () => {
    expect(isGreenLane({ ...green, diffLoc: 81 }, { enabled: true })).toBe(false);
  });

  it("diffLoc === 80 (boundary) -> true", () => {
    expect(isGreenLane({ ...green, diffLoc: 80 }, { enabled: true })).toBe(true);
  });

  it("dataChanges -> false", () => {
    expect(isGreenLane({ ...green, dataChanges: true }, { enabled: true })).toBe(false);
  });

  it("newDependencies > 0 -> false", () => {
    expect(isGreenLane({ ...green, newDependencies: 1 }, { enabled: true })).toBe(false);
  });

  it("lowConfidenceFindings > 0 (achados presentes) -> false", () => {
    expect(isGreenLane({ ...green, lowConfidenceFindings: 1 }, { enabled: true })).toBe(false);
  });

  it("visualConfidence < 0.9 -> false", () => {
    expect(isGreenLane({ ...green, visualConfidence: 0.89 }, { enabled: true })).toBe(false);
  });

  it("visualConfidence === 0.9 (boundary) -> true", () => {
    expect(isGreenLane({ ...green, visualConfidence: 0.9 }, { enabled: true })).toBe(true);
  });

  it("visualConfidence undefined (no visual phase ran) -> true", () => {
    expect(isGreenLane({ ...green, visualConfidence: undefined }, { enabled: true })).toBe(true);
  });

  it("repoCritical -> false", () => {
    expect(isGreenLane({ ...green, repoCritical: true }, { enabled: true })).toBe(false);
  });

  it("enabled: false (kill switch off) -> false even for a 100% green input", () => {
    expect(isGreenLane(green, { enabled: false })).toBe(false);
  });
});

describe("isSensitivePath", () => {
  it.each([
    "src/auth/login.ts",
    "src/billing/payment.ts",
    "src/persistence/migrations/017_x.sql",
    "src/webhook/handler.ts",
  ])("%s is sensitive", (file) => {
    expect(isSensitivePath(file)).toBe(true);
  });

  it("an unrelated path is not sensitive", () => {
    expect(isSensitivePath("src/util/format.ts")).toBe(false);
  });
});

describe("pickTopRiskyHunks", () => {
  const hunks: RiskyHunk[] = [
    { file: "src/util/format.ts", startLine: 1, endLine: 50, reason: "altera 50 linha(s)" }, // biggest, not sensitive
    { file: "src/auth/login.ts", startLine: 1, endLine: 5, reason: "toca caminho sensível" }, // tiny, sensitive
    { file: "src/util/other.ts", startLine: 1, endLine: 20, reason: "altera 20 linha(s)" },
  ];

  it("sensitive-path hunks come first even when smaller than a non-sensitive one", () => {
    const [first] = pickTopRiskyHunks(hunks, 3);
    expect(first.file).toBe("src/auth/login.ts");
  });

  it("within the same sensitivity tier, the largest hunk comes first", () => {
    const picked = pickTopRiskyHunks(hunks, 3);
    expect(picked[1].file).toBe("src/util/format.ts");
    expect(picked[2].file).toBe("src/util/other.ts");
  });

  it("defaults to the top 3 and truncates the rest", () => {
    const many = [...hunks, { file: "src/util/fourth.ts", startLine: 1, endLine: 1, reason: "x" }];
    expect(pickTopRiskyHunks(many)).toHaveLength(3);
  });

  it("does not mutate the input array", () => {
    const copy = [...hunks];
    pickTopRiskyHunks(hunks, 1);
    expect(hunks).toEqual(copy);
  });
});

describe("buildRiskSection", () => {
  it("gera permalinks corretos para 2-3 hunks de exemplo, com ⏱️ ~N min presente", () => {
    const section = buildRiskSection({
      repo: "acme/widgets",
      sha: "deadbeef",
      minutes: 12,
      hunks: [
        { file: "src/auth/login.ts", startLine: 10, endLine: 42, reason: "toca caminho sensível (auth)" },
        { file: "src/util/format.ts", startLine: 100, endLine: 120, reason: "altera 21 linha(s)" },
      ],
    });

    expect(section).toContain("⏱️ ~12 min");
    expect(section).toContain(
      "https://github.com/acme/widgets/blob/deadbeef/src/auth/login.ts#L10-L42"
    );
    expect(section).toContain(
      "https://github.com/acme/widgets/blob/deadbeef/src/util/format.ts#L100-L120"
    );
    expect(section).toContain("toca caminho sensível (auth)");
    expect(section.startsWith("## 🎯 Revise isto primeiro")).toBe(true);
  });

  it("no hunks -> still renders the header and the minutes, with a fallback message", () => {
    const section = buildRiskSection({ repo: "acme/widgets", sha: "deadbeef", minutes: 3, hunks: [] });
    expect(section).toContain("⏱️ ~3 min");
    expect(section).toContain("revise o diff completo");
  });
});

describe("buildGreenLaneBlock", () => {
  it("2 PRs -> 1 comando gh pr merge cobrindo os dois, sem chamada de rede", () => {
    const block = buildGreenLaneBlock([
      { owner: "acme", repo: "widgets", prNumber: 10, diffSummary: "+5 -1 in src/foo.ts" },
      { owner: "acme", repo: "gadgets", prNumber: 11, diffSummary: "+2 -0 in src/bar.ts" },
    ]);

    expect(block).toContain("gh pr merge acme/widgets#10 --squash && gh pr merge acme/gadgets#11 --squash");
  });

  it("empty list -> empty string, no crash", () => {
    expect(buildGreenLaneBlock([])).toBe("");
  });
});

describe("countLowConfidenceFindings", () => {
  it("undefined findings -> 0", () => {
    expect(countLowConfidenceFindings(undefined)).toBe(0);
  });

  it("counts only findings below the low-confidence threshold", () => {
    expect(
      countLowConfidenceFindings([{ confidence: 0.5 }, { confidence: 0.95 }, { confidence: 0.79 }])
    ).toBe(2);
  });

  it("a finding with no confidence field is treated as high-confidence (not counted)", () => {
    expect(countLowConfidenceFindings([{}])).toBe(0);
  });
});
