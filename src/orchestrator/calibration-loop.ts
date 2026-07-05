/**
 * Weekly calibration loop (F5 #165, D27/D32).
 *
 * Closes the "a gap you point out becomes a rule" loop: once a week it mines the
 * signals a human left on the agent's PRs — the pr_feedback corpus (human deltas
 * + review comments, written by the PR-review poller's merge write-path) plus the
 * week's 🧭 steering (card_steering, produced by #169 — consumed here, never
 * produced) — asks Kimi to cluster them, keeps only patterns seen >= 2 times,
 * has Opus veto anything that contradicts the current docs / raizes-docs, and
 * opens ONE calibration PR that adds those rules as bullets:
 *   - scope "global"    -> `## Regras aprendidas` of the machine's CLAUDE.md;
 *   - scope "repo:<slug>"-> `Instruções para Agentes de IA` of that repo's
 *                          docs/REPO-PROFILE.md.
 * A rule with no fresh hit in 8 weeks is proposed for REMOVAL in the same PR, so
 * the files never bloat.
 *
 * ISOLATION: runWeeklyCalibration is a pure orchestration over injected seams —
 * the cron that calls it weekly, and the REAL implementations of those seams,
 * are F6:
 *   - `cluster`  : Kimi (cheap) — build one prompt from the corpus, parse
 *                  `{ clusters: [...] }`. Kimi, never the apex — mining is not apex.
 *   - `validate` : Opus via src/provider/claude.ts — the ONLY apex call here;
 *                  sees the proposed rules + current docs + applicable raizes-docs
 *                  slugs and returns `{ approved, contradictions[] }`.
 *   - `openCalibrationPr` : clone + edit ONLY CLAUDE.md / docs/REPO-PROFILE.md +
 *                  `gh pr create` (mirror src/pipeline/mapping/pr-docs.ts's
 *                  docs-only, argv-safe git mechanics).
 * Wiring those here now would be dead code (nothing calls this until the F6
 * cron), so they stay seams — the pure decision logic (occurrence filter, 5-rule
 * cap, contradiction drop, 8-week expiry, D32 guardrail block) is what this file
 * owns and tests.
 *
 * SECURITY (D32): a learned rule only ever edits guidance/documentation, never a
 * guardrail or permission. A cluster that names an operational knob (policyChange)
 * is passed through validateProposedChange and DROPPED before the PR when out of
 * bound; even in bound it is never turned into a policy.yaml edit — the change
 * plan can only ever target CLAUDE.md or a REPO-PROFILE.
 */
import { validateProposedChange } from "../config/policy.js";
import type { CardSteeringRepository, PrFeedbackRepository } from "../persistence/types.js";

/** "global" -> machine CLAUDE.md; "repo:<slug>" -> that repo's REPO-PROFILE. */
export type RuleScope = "global" | `repo:${string}`;

/** One Kimi cluster (D27): a correction pattern with its occurrence count + provenance. */
export interface FeedbackCluster {
  pattern: string;
  occurrences: number;
  examples: Array<{ before: string; after: string }>;
  scope: RuleScope;
  proposedRule: string;
  /** Source PR/comment references — provenance is mandatory in the PR body (D27). */
  provenance?: string[];
  /**
   * D32 defense-in-depth: an operational knob the pattern implies. Gated by
   * validateProposedChange — out of bound drops the whole rule. Learned rules
   * never edit a guardrail, so this only decides whether the rule is surfaced.
   */
  policyChange?: { path: string; value: number };
}

export interface ClusterResult {
  clusters: FeedbackCluster[];
}

export interface ValidationVerdict {
  approved: boolean;
  /**
   * proposedRule texts that contradict the current docs / raizes-docs. Each is
   * dropped from THIS week (stays a candidate for the next round). Authoritative
   * per-rule; `approved` is advisory.
   */
  contradictions: string[];
}

/** One bullet to add or remove in exactly one docs file. */
export interface ChangePlanEntry {
  target: "claude-md" | "repo-profile";
  /** Present iff target === "repo-profile" — the repo whose docs/REPO-PROFILE.md is edited. */
  repo?: string;
  section: string;
  bullet: string;
  op: "add" | "remove";
}

export interface CalibrationChangePlan {
  branch: string;
  entries: ChangePlanEntry[];
  body: string;
}

/** A rule already living in the docs, for expiry (its date + scope). */
export interface ExistingRule {
  rule: string;
  scope: RuleScope;
  lastSeen: Date;
}

/** Lowest-common-denominator corpus item the Kimi cluster seam receives. */
export interface MiningItem {
  repo: string;
  kind: string;
  content: string;
}

export interface CalibrationDeps {
  prFeedback: Pick<PrFeedbackRepository, "findSince">;
  /**
   * Optional 🧭 source (D27 source c). Best-effort: CardSteeringRepository has
   * no time-scoped read, so this folds in the week's UNAPPLIED steering only
   * (a proper findSince belongs to the steering flow, #169). Absent -> corpus
   * is pr_feedback alone.
   */
  cardSteering?: Pick<CardSteeringRepository, "findUnapplied">;
  /** Kimi clustering (F6 wires the real call). */
  cluster: (corpus: MiningItem[]) => Promise<ClusterResult>;
  /** Opus non-contradiction gate (F6 wires the real claude.ts call). */
  validate: (rules: FeedbackCluster[]) => Promise<ValidationVerdict>;
  /** Opens the single weekly calibration PR from the plan (F6 wires the real git/gh). */
  openCalibrationPr: (plan: CalibrationChangePlan) => Promise<{ url: string }>;
  /** Rules currently in the docs, for 8-week expiry. Absent -> no removals proposed. */
  existingRules?: ExistingRule[];
  now?: () => Date;
}

export const MAX_RULES_PER_WEEK = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRY_MS = 8 * WEEK_MS;
const CLAUDE_SECTION = "Regras aprendidas";
const PROFILE_SECTION = "Instruções para Agentes de IA";

/**
 * Rules in `existing` that were NOT re-seen this week and whose last hit is older
 * than 8 weeks — the "negative clusters" (D27) proposed for removal so the docs
 * never bloat.
 */
export const computeExpirations = (
  existing: ExistingRule[],
  accepted: FeedbackCluster[],
  now: Date
): Array<{ rule: string; scope: RuleScope }> => {
  const reSeen = new Set(accepted.map((c) => c.proposedRule));
  return existing
    .filter((r) => !reSeen.has(r.rule) && now.getTime() - r.lastSeen.getTime() > EXPIRY_MS)
    .map((r) => ({ rule: r.rule, scope: r.scope }));
};

/** ISO-8601 week number (1-53) — deterministic branch suffix, not the LLM's call. */
export const isoWeek = (date: Date): number => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / WEEK_MS);
};

const scopeToEntry = (scope: RuleScope, bullet: string, op: "add" | "remove"): ChangePlanEntry =>
  scope === "global"
    ? { target: "claude-md", section: CLAUDE_SECTION, bullet, op }
    : { target: "repo-profile", repo: scope.slice(5), section: PROFILE_SECTION, bullet, op };

const buildPrBody = (
  accepted: FeedbackCluster[],
  removals: Array<{ rule: string; scope: RuleScope }>,
  date: string
): string => {
  const lines = [`# Calibração semanal — ${date}`, ""];
  if (accepted.length > 0) {
    lines.push(`## Regras propostas (${accepted.length})`, "");
    for (const c of accepted) {
      const where = c.scope === "global" ? "CLAUDE.md" : `REPO-PROFILE (${c.scope.slice(5)})`;
      const prov = c.provenance && c.provenance.length > 0 ? c.provenance.join(", ") : "—";
      lines.push(`- **${c.proposedRule}** → ${where} · ${c.occurrences} ocorrências · proveniência: ${prov}`);
    }
    lines.push("");
  }
  if (removals.length > 0) {
    lines.push("## Remoções propostas (sem hit em 8 semanas)", "");
    for (const r of removals) lines.push(`- ~~${r.rule}~~`);
    lines.push("");
  }
  lines.push("_Regras aprendidas mudam guidance/documentação — nunca guardrails ou permissões (D32)._");
  return lines.join("\n");
};

/** Compose the change plan (what bullet lands in which file) from the surviving rules + removals. */
export const buildChangePlan = (
  accepted: FeedbackCluster[],
  removals: Array<{ rule: string; scope: RuleScope }>,
  now: Date
): CalibrationChangePlan => {
  const week = String(isoWeek(now)).padStart(2, "0");
  const date = now.toISOString().slice(0, 10);
  const entries: ChangePlanEntry[] = [];
  for (const c of accepted) {
    const prov = c.provenance && c.provenance.length > 0 ? ` (proveniência: ${c.provenance.join(", ")})` : "";
    entries.push(scopeToEntry(c.scope, `${c.proposedRule} — aprendida em ${date}${prov}`, "add"));
  }
  for (const r of removals) {
    entries.push(scopeToEntry(r.scope, r.rule, "remove"));
  }
  return { branch: `openroutines/calibracao-semana-${week}`, entries, body: buildPrBody(accepted, removals, date) };
};

/**
 * Mine the week's feedback into at most 5 calibration rules and open one PR.
 * Callable in isolation (the weekly cron is F6). Returns the PR url (absent when
 * nothing survives) and the count of rules proposed.
 */
export const runWeeklyCalibration = async (
  deps: CalibrationDeps
): Promise<{ prUrl?: string; rulesProposed: number }> => {
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - WEEK_MS);

  // 1. Corpus: pr_feedback (a: human-delta, b: review-comment) + the week's 🧭 (c).
  const feedback = await deps.prFeedback.findSince(since);
  const corpus: MiningItem[] = feedback.map((f) => ({ repo: f.repo, kind: f.kind, content: f.content }));
  if (deps.cardSteering) {
    const steering = (await deps.cardSteering.findUnapplied()).filter(
      (s) => (s.createdAt?.getTime() ?? 0) >= since.getTime()
    );
    for (const s of steering) corpus.push({ repo: "", kind: "steering", content: s.text });
  }

  // 2. Kimi clusters -> keep only repeated patterns (>= 2) that also carry real
  // provenance (D27: provenance is mandatory, never "—") — an isolated
  // correction, or one Kimi couldn't source, never becomes a rule. Skip the
  // call on an empty week (expiry below still runs).
  const { clusters } = corpus.length > 0 ? await deps.cluster(corpus) : { clusters: [] };
  const hasProvenance = (c: FeedbackCluster): boolean =>
    Array.isArray(c.provenance) && c.provenance.some((p) => p.trim().length > 0);
  const repeated = clusters.filter((c) => c.occurrences >= 2 && hasProvenance(c));

  // 3. D32: a rule naming an out-of-bound operational knob is rejected before any PR.
  const withinBounds = repeated.filter(
    (c) => !c.policyChange || validateProposedChange(c.policyChange.path, c.policyChange.value).ok
  );

  // 4. Cap at 5, cutting the lowest-occurrence candidates first.
  const ranked = [...withinBounds].sort((a, b) => b.occurrences - a.occurrences).slice(0, MAX_RULES_PER_WEEK);

  // 5. Opus veto (apex, skipped when there is nothing to validate) — a rule that
  // contradicts current docs / raizes-docs waits for next week.
  const verdict = ranked.length > 0 ? await deps.validate(ranked) : { approved: true, contradictions: [] };
  const contradicted = new Set(verdict.contradictions);
  const accepted = ranked.filter((c) => !contradicted.has(c.proposedRule));

  // 6. 8-week expiry: stale, un-re-seen rules become removal proposals in the same PR.
  const removals = computeExpirations(deps.existingRules ?? [], accepted, now);

  if (accepted.length === 0 && removals.length === 0) return { rulesProposed: 0 };

  const plan = buildChangePlan(accepted, removals, now);
  const { url } = await deps.openCalibrationPr(plan);
  return { prUrl: url, rulesProposed: accepted.length };
};
