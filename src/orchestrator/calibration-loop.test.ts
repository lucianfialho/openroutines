import { describe, it, expect, vi } from "vitest";
import {
  runWeeklyCalibration,
  computeExpirations,
  isoWeek,
  MAX_RULES_PER_WEEK,
  type CalibrationDeps,
  type FeedbackCluster,
  type CalibrationChangePlan,
  type MiningItem,
  type RuleScope,
} from "./calibration-loop.js";
import { makeInMemoryPrFeedbackRepository } from "../persistence/pr-feedback-in-memory.js";

const NOW = new Date("2026-03-05T12:00:00Z"); // ISO week 10 of 2026
const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000);

const cluster = (over: Partial<FeedbackCluster>): FeedbackCluster => ({
  pattern: "p",
  occurrences: 2,
  examples: [{ before: "a", after: "b" }],
  scope: "global",
  proposedRule: "regra",
  ...over,
});

interface Harness {
  deps: CalibrationDeps;
  capturedPlan: () => CalibrationChangePlan | undefined;
  capturedCorpus: () => MiningItem[];
  openCalibrationPr: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
  cluster: ReturnType<typeof vi.fn>;
}

const makeHarness = async (opts: {
  clusters: FeedbackCluster[];
  contradictions?: string[];
  approved?: boolean;
  existingRules?: CalibrationDeps["existingRules"];
  seedFeedback?: Array<{ repo: string; kind: "human-delta" | "review-comment"; content: string; prNumber: number }>;
}): Promise<Harness> => {
  const prFeedback = makeInMemoryPrFeedbackRepository();
  // A non-empty corpus is what real clustering feeds on; default to one row so
  // cluster-driven tests actually reach the Kimi seam (an empty week skips it).
  const seed = opts.seedFeedback ?? [{ repo: "acme", kind: "human-delta" as const, content: "seed", prNumber: 99 }];
  for (const f of seed) {
    await prFeedback.save({ ...f, sourceId: "trello", taskId: "t", createdAt: weeksAgo(0) });
  }

  let plan: CalibrationChangePlan | undefined;
  let corpus: MiningItem[] = [];
  const cluster = vi.fn(async (c: MiningItem[]) => {
    corpus = c;
    return { clusters: opts.clusters };
  });
  const validate = vi.fn(async () => ({
    approved: opts.approved ?? true,
    contradictions: opts.contradictions ?? [],
  }));
  const openCalibrationPr = vi.fn(async (p: CalibrationChangePlan) => {
    plan = p;
    return { url: "https://github.com/lucianfialho/openroutines/pull/1" };
  });

  const deps: CalibrationDeps = {
    prFeedback,
    cluster,
    validate,
    openCalibrationPr,
    existingRules: opts.existingRules,
    now: () => NOW,
  };
  return { deps, capturedPlan: () => plan, capturedCorpus: () => corpus, openCalibrationPr, validate, cluster };
};

const addBullets = (plan: CalibrationChangePlan) => plan.entries.filter((e) => e.op === "add");
const removeBullets = (plan: CalibrationChangePlan) => plan.entries.filter((e) => e.op === "remove");

describe("runWeeklyCalibration (F5 #165, D27)", () => {
  it("AC: 2 PRs with the same correction + 1 different -> exactly 1 rule (occurrences:2); the isolated correction never becomes a rule", async () => {
    const h = await makeHarness({
      clusters: [
        cluster({ occurrences: 2, proposedRule: "sempre validar input no boundary" }),
        cluster({ occurrences: 1, proposedRule: "correção isolada" }),
      ],
      seedFeedback: [
        { repo: "acme", kind: "human-delta", content: "diff1", prNumber: 1 },
        { repo: "acme", kind: "review-comment", content: "valide o input", prNumber: 2 },
      ],
    });

    const result = await runWeeklyCalibration(h.deps);

    expect(result.rulesProposed).toBe(1);
    const adds = addBullets(h.capturedPlan()!);
    expect(adds).toHaveLength(1);
    expect(adds[0].bullet).toContain("sempre validar input no boundary");
    expect(adds.some((e) => e.bullet.includes("correção isolada"))).toBe(false);
    // the corpus actually came from pr_feedback.findSince
    expect(h.capturedCorpus().map((c) => c.content)).toEqual(["diff1", "valide o input"]);
  });

  it("AC: scope global -> a CLAUDE.md bullet; scope repo:X -> that repo's REPO-PROFILE, never the global CLAUDE.md", async () => {
    const h = await makeHarness({
      clusters: [
        cluster({ occurrences: 3, scope: "global", proposedRule: "regra global" }),
        cluster({ occurrences: 2, scope: "repo:acme-widgets", proposedRule: "regra do acme" }),
      ],
    });

    await runWeeklyCalibration(h.deps);
    const adds = addBullets(h.capturedPlan()!);

    const global = adds.find((e) => e.bullet.includes("regra global"))!;
    expect(global.target).toBe("claude-md");
    expect(global.section).toBe("Regras aprendidas");
    expect(global.repo).toBeUndefined();

    const repoRule = adds.find((e) => e.bullet.includes("regra do acme"))!;
    expect(repoRule.target).toBe("repo-profile");
    expect(repoRule.repo).toBe("acme-widgets");
    expect(repoRule.section).toBe("Instruções para Agentes de IA");
    // the repo-scoped rule never pollutes the global CLAUDE.md
    expect(adds.filter((e) => e.target === "claude-md").some((e) => e.bullet.includes("regra do acme"))).toBe(false);
  });

  it("AC: the PR never exceeds 5 rules even with >5 valid clusters — the lowest-occurrence candidates are cut", async () => {
    const clusters = [3, 8, 5, 2, 7, 6, 4].map((occ) =>
      cluster({ occurrences: occ, proposedRule: `regra-occ-${occ}` })
    );
    const h = await makeHarness({ clusters });

    const result = await runWeeklyCalibration(h.deps);

    expect(result.rulesProposed).toBe(MAX_RULES_PER_WEEK);
    const adds = addBullets(h.capturedPlan()!);
    expect(adds).toHaveLength(5);
    const kept = adds.map((e) => e.bullet);
    // top-5 by occurrences: 8,7,6,5,4 kept; 3 and 2 cut
    for (const occ of [8, 7, 6, 5, 4]) expect(kept.some((b) => b.includes(`regra-occ-${occ}`))).toBe(true);
    for (const occ of [3, 2]) expect(kept.some((b) => b.includes(`regra-occ-${occ}`))).toBe(false);
  });

  it("AC: a rule Fable flags as contradictory is dropped from this week's PR; the rest ship", async () => {
    const h = await makeHarness({
      clusters: [
        cluster({ occurrences: 3, proposedRule: "regra-ok" }),
        cluster({ occurrences: 2, proposedRule: "regra-contra-raizes" }),
      ],
      approved: false,
      contradictions: ["regra-contra-raizes"],
    });

    const result = await runWeeklyCalibration(h.deps);

    expect(result.rulesProposed).toBe(1);
    const bullets = addBullets(h.capturedPlan()!).map((e) => e.bullet);
    expect(bullets.some((b) => b.includes("regra-ok"))).toBe(true);
    expect(bullets.some((b) => b.includes("regra-contra-raizes"))).toBe(false);
  });

  it("D32: a rule that names an out-of-bound policy knob is rejected before the PR; an in-bound one survives — and no plan entry ever targets a guardrail file", async () => {
    const h = await makeHarness({
      clusters: [
        cluster({ occurrences: 3, proposedRule: "raise cap too high", policyChange: { path: "night.max_prs_per_night", value: 999 } }),
        cluster({ occurrences: 2, proposedRule: "nudge cap in bound", policyChange: { path: "night.max_prs_per_night", value: 6 } }),
        cluster({ occurrences: 2, proposedRule: "unknown knob", policyChange: { path: "night.secret_override", value: 1 } }),
      ],
    });

    const result = await runWeeklyCalibration(h.deps);

    expect(result.rulesProposed).toBe(1); // only the in-bound one
    const bullets = addBullets(h.capturedPlan()!).map((e) => e.bullet);
    expect(bullets.some((b) => b.includes("nudge cap in bound"))).toBe(true);
    expect(bullets.some((b) => b.includes("raise cap too high"))).toBe(false);
    expect(bullets.some((b) => b.includes("unknown knob"))).toBe(false);
    // learned rules only ever edit docs — the plan can never target policy.yaml
    for (const e of h.capturedPlan()!.entries) expect(["claude-md", "repo-profile"]).toContain(e.target);
  });

  it("8-week expiry: a stale, un-re-seen rule becomes a removal in the same PR; a fresh or re-seen rule is kept", async () => {
    const h = await makeHarness({
      clusters: [cluster({ occurrences: 2, scope: "global", proposedRule: "regra-viva" })],
      existingRules: [
        { rule: "regra-viva", scope: "global", lastSeen: weeksAgo(20) }, // old BUT re-seen this week -> kept
        { rule: "regra-morta", scope: "global", lastSeen: weeksAgo(9) }, // >8 weeks, not re-seen -> removed
        { rule: "regra-recente", scope: "repo:acme", lastSeen: weeksAgo(2) }, // fresh -> kept
      ],
    });

    const result = await runWeeklyCalibration(h.deps);

    expect(result.rulesProposed).toBe(1);
    const removes = removeBullets(h.capturedPlan()!);
    expect(removes.map((e) => e.bullet)).toEqual(["regra-morta"]);
    expect(removes[0].target).toBe("claude-md");
  });

  it("opens a PR for removals alone in a quiet week (no new feedback) without calling Kimi or Fable", async () => {
    const h = await makeHarness({
      clusters: [],
      seedFeedback: [], // empty week: no pr_feedback at all
      existingRules: [{ rule: "regra-morta", scope: "global", lastSeen: weeksAgo(10) }],
    });

    const result = await runWeeklyCalibration(h.deps);

    expect(result.rulesProposed).toBe(0);
    expect(result.prUrl).toBeDefined();
    expect(removeBullets(h.capturedPlan()!)).toHaveLength(1);
    expect(h.cluster).not.toHaveBeenCalled(); // empty corpus -> Kimi skipped
    expect(h.validate).not.toHaveBeenCalled(); // nothing to validate -> Fable skipped
  });

  it("nothing survives -> no PR opened, no rules proposed", async () => {
    const h = await makeHarness({ clusters: [cluster({ occurrences: 1 })] });

    const result = await runWeeklyCalibration(h.deps);

    expect(result).toEqual({ rulesProposed: 0 });
    expect(h.openCalibrationPr).not.toHaveBeenCalled();
  });

  it("the weekly branch is deterministic: openroutines/calibracao-semana-NN", async () => {
    const h = await makeHarness({ clusters: [cluster({ occurrences: 2 })] });
    await runWeeklyCalibration(h.deps);
    expect(h.capturedPlan()!.branch).toBe("openroutines/calibracao-semana-10");
    expect(h.capturedPlan()!.branch).toMatch(/^openroutines\/calibracao-semana-\d{2}$/);
  });

  it("folds the week's 🧭 steering into the mining corpus when a card_steering source is wired", async () => {
    const h = await makeHarness({ clusters: [cluster({ occurrences: 2 })] });
    const steering = [
      { text: "faça sempre X", applied: false, createdAt: weeksAgo(0), sourceId: "s", taskId: "t", authorTrelloId: "u" },
      { text: "steering velho", applied: false, createdAt: weeksAgo(3), sourceId: "s", taskId: "t", authorTrelloId: "u" },
    ];
    h.deps.cardSteering = { findUnapplied: async () => steering };

    await runWeeklyCalibration(h.deps);

    const contents = h.capturedCorpus().map((c) => c.content);
    expect(contents).toContain("faça sempre X"); // within the week
    expect(contents).not.toContain("steering velho"); // older than the week
  });
});

describe("computeExpirations", () => {
  it("removes only rules older than 8 weeks that were not re-seen", () => {
    const out = computeExpirations(
      [
        { rule: "old-unseen", scope: "global", lastSeen: weeksAgo(9) },
        { rule: "old-reseen", scope: "global", lastSeen: weeksAgo(30) },
        { rule: "fresh", scope: "repo:x", lastSeen: weeksAgo(1) },
      ],
      [cluster({ proposedRule: "old-reseen" })],
      NOW
    );
    expect(out).toEqual([{ rule: "old-unseen", scope: "global" as RuleScope }]);
  });
});

describe("isoWeek", () => {
  it("computes the ISO-8601 week number", () => {
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe(1);
    expect(isoWeek(new Date("2026-03-05T00:00:00Z"))).toBe(10);
    expect(isoWeek(new Date("2026-12-31T00:00:00Z"))).toBe(53);
  });
});
