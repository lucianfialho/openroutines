/**
 * Morning report (F4 #159, 07:30, D29 "1 card único por dia").
 *
 * gatherMorningReportData reads the night's outcome from Postgres
 * (night_runs/executions/pr_links/tier_circuit_state); renderMorningReportCard
 * turns that into the digest body, in the exact section order the doc
 * ("03-PIPELINE-EXECUCAO.md", ciclo noturno) specifies: security blocks on
 * top → PRs by risk_score DESC → green lane → costs by tier → header/total.
 *
 * risk_score/green_lane themselves are #158's job (src/report/risk-score.ts) —
 * this module only consumes pr_links' already-computed columns and orders by
 * them (findForNight already does `ORDER BY risk_score DESC`).
 */
import type { Pool } from "pg";
import type { PrLinkRepository } from "../persistence/types.js";
import { makePostgresPrLinkRepository } from "../persistence/pr-links-postgres.js";
import { isSecurityBlockReason } from "../notify/telegram.js";
import { buildGreenLaneBlock } from "./risk-score.js";
import { MIN_SAMPLE_SIZE, FAILURE_RATE_THRESHOLD } from "../engine/circuit-breaker.js";

export const MORNING_REPORT_PREFIX = "📊 [Relatório]";
/** Card body budget (02-FLUXO-TRELLO.md, "comentários abaixo de ~8.000 caracteres"). */
export const MAX_BODY_CHARS = 8000;
const TRUNCATION_NOTE = "\n\n_(relatório truncado — corpo excedeu o limite de caracteres; ver execuções completas nos cards individuais)_";

export interface MorningReportData {
  nightId: string;
  securityBlocks: Array<{ cardId: string; title: string; blockReason: string; trelloUrl: string }>;
  prs: Array<{ cardId: string; prUrl: string; repo: string; riskScore: number; greenLane: boolean; estimatedMinutes: number; costUsd: number }>;
  costsByTier: Record<"kimi" | "sonnet" | "opus", number>;
  cardsCompleted: number;
  cardsBlocked: number;
  circuitBreakersTriggered: Array<{ tier: string }>;
}

export interface GatherMorningReportDeps {
  /** Overrides the pr_links lookup (tests inject an in-memory repo). Defaults to a Postgres-backed one over `pool`. */
  prLinks?: PrLinkRepository;
  /** slug -> "owner/name" (repo-registry) for building a real GitHub URL; absent falls back to the bare slug. */
  resolveGithubRepo?: (slug: string) => string | undefined;
}

// executions.provider_breakdown is keyed by MODEL first (H11:
// state-machine.ts keys costByProvider by `routedModel ?? routedProvider`,
// because one provider serves several tiers — claude-cli runs sonnet AND
// opus per D9 routing). Bare provider names stay as fallback for nights
// persisted before H11 and for fanout lenses (keyed by lens provider).
const PROVIDER_TO_TIER: Record<string, keyof MorningReportData["costsByTier"]> = {
  // model keys (current writes)
  "kimi-k2.6": "kimi",
  "claude-sonnet-5": "sonnet",
  "claude-opus-4-8": "opus",
  // provider-name fallbacks (pre-H11 rows and fanout lens keys)
  "kimi-cli": "kimi",
  "kimi-coding-api": "kimi",
  "claude-cli": "sonnet",
  "claude-api": "opus",
  "security-judge": "opus",
  "architecture-judge": "opus",
};

// ponytail: pr_links persists only the final risk_score (#158), not the raw
// RiskScoreInput estimateReviewMinutes needs, and recomputing the real
// formula would require touching card-to-pr/pr.ts (out of scope for #159).
// Approximate minutes from the stored score at the same order of magnitude as
// risk-score.ts's own weights (~0.2-0.3 min per point) — revisit if pr_links
// ever persists review_minutes directly.
const MINUTES_PER_RISK_POINT = 0.3;
const MIN_ESTIMATED_MINUTES = 1;
const approximateReviewMinutes = (riskScore: number | undefined): number =>
  Math.max(MIN_ESTIMATED_MINUTES, Math.round((riskScore ?? 0) * MINUTES_PER_RISK_POINT));

interface StateMachineOutputsShape {
  stateMachineContext?: { outputs?: Record<string, unknown> };
}

/**
 * Reads night_runs/executions/pr_links/tier_circuit_state for `nightId`.
 *
 * `executions.metadata` (where `outputs.blocked.blockReason` lives) is safe
 * to read here even for normally-completed executions: postgres.ts's upsert
 * does `metadata = COALESCE(EXCLUDED.metadata, executions.metadata)`, so
 * `succeed()`/`fail()`'s final write (state-machine.ts) never nulls out
 * metadata a previous write already set.
 */
export const gatherMorningReportData = async (
  pool: Pool,
  nightId: string,
  deps: GatherMorningReportDeps = {}
): Promise<MorningReportData> => {
  const prLinks = deps.prLinks ?? makePostgresPrLinkRepository(pool);
  const links = await prLinks.findForNight(nightId); // already ORDER BY risk_score DESC NULLS LAST

  const { rows: execRows } = await pool.query(
    `SELECT e.task_id AS task_id, e.metadata AS metadata, e.provider_breakdown AS provider_breakdown,
            e.cost_usd AS cost_usd, t.title AS title, t.url AS url
     FROM executions e
     LEFT JOIN tasks t ON t.source_id = e.source_id AND t.task_id = e.task_id
     WHERE e.night_id = $1`,
    [nightId]
  );

  const securityBlocks: MorningReportData["securityBlocks"] = [];
  let cardsBlocked = 0;
  const costsByTier: MorningReportData["costsByTier"] = { kimi: 0, sonnet: 0, opus: 0 };
  // Same (task_id) key card-to-pr / findForNight join on — summed in case a
  // card ran more than once this night (rework, D24: max 1 extra round).
  const costByTaskId = new Map<string, number>();

  for (const row of execRows) {
    const metadata = row.metadata as StateMachineOutputsShape | null;
    const blocked = metadata?.stateMachineContext?.outputs?.blocked as { blockReason?: string } | undefined;
    if (blocked?.blockReason) {
      cardsBlocked++;
      if (isSecurityBlockReason(blocked.blockReason)) {
        securityBlocks.push({
          cardId: String(row.task_id),
          title: row.title ? String(row.title) : String(row.task_id),
          blockReason: blocked.blockReason,
          trelloUrl: row.url ? String(row.url) : "",
        });
      }
    }
    const breakdown = (row.provider_breakdown as Record<string, number> | null) ?? {};
    for (const [providerName, usd] of Object.entries(breakdown)) {
      const tier = PROVIDER_TO_TIER[providerName];
      if (tier) costsByTier[tier] += Number(usd);
    }
    if (row.task_id != null && row.cost_usd != null) {
      const taskId = String(row.task_id);
      costByTaskId.set(taskId, (costByTaskId.get(taskId) ?? 0) + Number(row.cost_usd));
    }
  }

  const prs = links.map((l) => {
    const githubRepo = deps.resolveGithubRepo?.(l.repo);
    const prUrl = l.prNumber !== undefined ? `https://github.com/${githubRepo ?? l.repo}/pull/${l.prNumber}` : "";
    return {
      cardId: l.taskId,
      prUrl,
      repo: l.repo,
      riskScore: l.riskScore ?? 0,
      greenLane: l.greenLane ?? false,
      estimatedMinutes: approximateReviewMinutes(l.riskScore),
      costUsd: costByTaskId.get(l.taskId) ?? 0,
    };
  });

  const { rows: tierRows } = await pool.query(
    `SELECT tier, cards_attempted, cards_failed FROM tier_circuit_state WHERE night_id = $1`,
    [nightId]
  );
  const circuitBreakersTriggered = tierRows
    .filter((r) => {
      const attempted = Number(r.cards_attempted);
      const failed = Number(r.cards_failed);
      return attempted >= MIN_SAMPLE_SIZE && failed / attempted > FAILURE_RATE_THRESHOLD;
    })
    .map((r) => ({ tier: String(r.tier) }));

  return {
    nightId,
    securityBlocks,
    prs,
    costsByTier,
    cardsCompleted: prs.length,
    cardsBlocked,
    circuitBreakersTriggered,
  };
};

const renderSecurityBlocks = (blocks: MorningReportData["securityBlocks"]): string => {
  if (blocks.length === 0) return "";
  const items = blocks.map((b) => `- [${b.title}](${b.trelloUrl || "#"}) — ${b.blockReason}`);
  return ["## ⛔ Bloqueios de segurança", "", ...items].join("\n");
};

const renderPrs = (prs: MorningReportData["prs"]): string => {
  if (prs.length === 0) return "";
  const items = prs.map(
    (p) =>
      `- **${p.repo}**${p.greenLane ? " 🟢" : ""} risk_score=${p.riskScore} (~${p.estimatedMinutes} min)${p.costUsd > 0 ? ` ~$${p.costUsd.toFixed(2)}` : ""} — ${p.prUrl || "(PR sem URL registrada)"}`
  );
  return ["## 🎯 PRs para revisar (por risco)", "", ...items].join("\n");
};

// M6: a PR with no registered URL (no prNumber yet) can't build a valid `gh pr
// merge` target — skip it rather than fabricate a placeholder.
const renderGreenLane = (prs: MorningReportData["prs"]): string => {
  const greenLaneInputs = prs
    .filter((p) => p.greenLane && p.prUrl)
    .map((p) => ({ prUrl: p.prUrl, diffSummary: `risk_score ${p.riskScore}` }));
  return buildGreenLaneBlock(greenLaneInputs);
};

const renderCosts = (costsByTier: MorningReportData["costsByTier"]): string => {
  const entries = Object.entries(costsByTier).filter(([, usd]) => usd > 0);
  if (entries.length === 0) return "";
  const items = entries.map(([tier, usd]) => `- ${tier}: $${usd.toFixed(2)}`);
  return ["## 💰 Custos por tier", "", ...items].join("\n");
};

const renderCircuitBreakers = (triggered: MorningReportData["circuitBreakersTriggered"]): string => {
  if (triggered.length === 0) return "";
  const items = triggered.map((t) => `- ${t.tier}`);
  return ["## 🔌 Circuit breakers acionados esta noite (fora de rotação até amanhã)", "", ...items].join("\n");
};

/**
 * Renders `{title, body}` in the EXACT section order the doc specifies:
 * security blocks → PRs by risk → green lane → costs by tier → header/total.
 * Truncates (never throws) when the body exceeds MAX_BODY_CHARS.
 */
export const renderMorningReportCard = (data: MorningReportData): { title: string; body: string } => {
  const totalMinutes = data.prs.reduce((sum, p) => sum + p.estimatedMinutes, 0);
  // "cabeçalho com total" (03-PIPELINE-EXECUCAO.md) — the closing tally, LAST
  // in the doc's own section order; the 📊 [Relatório] protocol marker
  // (02-FLUXO-TRELLO.md) is a separate envelope tag that always leads the
  // body regardless, same shape as blocked.ts's `⛔ [Bloqueio]` comments.
  const summary = [
    "## 📈 Resumo",
    "",
    `✅ ${data.cardsCompleted} concluído(s) · ⛔ ${data.cardsBlocked} blocked(s)`,
    `⏱️ hoje: ~${totalMinutes} min de review`,
  ].join("\n");

  const sections = [
    renderSecurityBlocks(data.securityBlocks),
    renderPrs(data.prs),
    renderGreenLane(data.prs),
    renderCosts(data.costsByTier),
    renderCircuitBreakers(data.circuitBreakersTriggered),
    summary,
  ].filter((s) => s.length > 0);

  let body = `${MORNING_REPORT_PREFIX}\n\n${sections.join("\n\n")}`;
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, Math.max(0, MAX_BODY_CHARS - TRUNCATION_NOTE.length)) + TRUNCATION_NOTE;
  }

  return { title: "📊 Relatório matinal", body };
};
