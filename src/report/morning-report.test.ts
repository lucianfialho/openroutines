/**
 * Morning report tests (F4 #159).
 *
 * gatherMorningReportData is tested against a mocked pool + in-memory
 * pr_links (always runs, synthetic data) and — when a real Postgres is
 * available — against the real join/query shape (mirrors
 * engine/circuit-breaker.test.ts's dual strategy).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import {
  gatherMorningReportData,
  renderMorningReportCard,
  MORNING_REPORT_PREFIX,
  MAX_BODY_CHARS,
  type MorningReportData,
} from "./morning-report.js";
import { recordTierOutcome } from "../engine/circuit-breaker.js";
import { makeInMemoryPrLinkRepository } from "../persistence/pr-links-in-memory.js";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, cleanupNight } from "../persistence/db.test-helpers.js";

const syntheticData = (): MorningReportData => ({
  nightId: "night-1",
  securityBlocks: [
    { cardId: "card-sec", title: "Card com achado de segurança", blockReason: "seguranca", trelloUrl: "https://trello.com/c/sec" },
  ],
  prs: [
    { cardId: "card-a", prUrl: "https://github.com/acme/widgets/pull/9", repo: "acme-widgets", riskScore: 50, greenLane: false, estimatedMinutes: 15 },
    { cardId: "card-b", prUrl: "https://github.com/acme/beta/pull/5", repo: "beta-app", riskScore: 10, greenLane: true, estimatedMinutes: 3 },
  ],
  costsByTier: { kimi: 0.05, sonnet: 1.23, opus: 0, fable: 0 },
  cardsCompleted: 2,
  cardsBlocked: 2,
  circuitBreakersTriggered: [{ tier: "kimi" }],
});

describe("renderMorningReportCard — exact section order (D29)", () => {
  it("orders sections: security blocks -> PRs by risk -> green lane -> costs -> header/total", () => {
    const { body } = renderMorningReportCard(syntheticData());

    const idxSecurity = body.indexOf("Bloqueios de segurança");
    const idxPrs = body.indexOf("PRs para revisar");
    const idxGreenLane = body.indexOf("Faixa verde");
    const idxCosts = body.indexOf("Custos por tier");
    const idxHeader = body.indexOf("min de review");

    expect(idxSecurity).toBeGreaterThanOrEqual(0);
    expect(idxPrs).toBeGreaterThan(idxSecurity);
    expect(idxGreenLane).toBeGreaterThan(idxPrs);
    expect(idxCosts).toBeGreaterThan(idxGreenLane);
    expect(idxHeader).toBeGreaterThan(idxCosts);
  });

  it("prefixes the body with the 📊 [Relatório] protocol marker", () => {
    const { body } = renderMorningReportCard(syntheticData());
    expect(body.startsWith(MORNING_REPORT_PREFIX)).toBe(true);
  });

  it("includes the total review-minutes header", () => {
    const { body } = renderMorningReportCard(syntheticData());
    expect(body).toContain("~18 min de review"); // 15 + 3
  });

  it("omits sections with no content instead of rendering an empty heading", () => {
    const data: MorningReportData = {
      ...syntheticData(),
      securityBlocks: [],
      circuitBreakersTriggered: [],
      costsByTier: { kimi: 0, sonnet: 0, opus: 0, fable: 0 },
    };
    const { body } = renderMorningReportCard(data);
    expect(body).not.toContain("Bloqueios de segurança");
    expect(body).not.toContain("Custos por tier");
    expect(body).not.toContain("Circuit breakers");
  });

  it("stays under MAX_BODY_CHARS for the synthetic scenario", () => {
    const { body } = renderMorningReportCard(syntheticData());
    expect(body.length).toBeLessThan(MAX_BODY_CHARS);
  });

  it("M6: renders a valid 'gh pr merge <url> --squash' command for a green-lane PR, not the invalid owner/repo#number syntax", () => {
    const { body } = renderMorningReportCard(syntheticData());
    expect(body).toContain("gh pr merge https://github.com/acme/beta/pull/5 --squash");
  });

  it("M6: a green-lane PR with no registered URL is skipped from the merge command instead of fabricating a broken target", () => {
    const data: MorningReportData = {
      ...syntheticData(),
      prs: [
        ...syntheticData().prs,
        { cardId: "card-c", prUrl: "", repo: "acme-widgets", riskScore: 5, greenLane: true, estimatedMinutes: 2 },
      ],
    };
    const { body } = renderMorningReportCard(data);
    const mergeLine = body.split("\n").find((l) => l.startsWith("gh pr merge"));
    expect(mergeLine).toBe("gh pr merge https://github.com/acme/beta/pull/5 --squash"); // only the PR that HAS a URL
  });

  it("truncates with a note instead of crashing when the body exceeds MAX_BODY_CHARS", () => {
    const manyPrs: MorningReportData["prs"] = Array.from({ length: 400 }, (_, i) => ({
      cardId: `card-${i}`,
      prUrl: `https://github.com/acme/widgets/pull/${i}`,
      repo: "acme-widgets",
      riskScore: i,
      greenLane: false,
      estimatedMinutes: 5,
    }));
    const data: MorningReportData = { ...syntheticData(), prs: manyPrs };

    expect(() => renderMorningReportCard(data)).not.toThrow();
    const { body } = renderMorningReportCard(data);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain("truncado");
  });
});

describe("gatherMorningReportData (mocked pool, synthetic data)", () => {
  const makeMockPool = (opts: { execRows: unknown[]; tierRows: unknown[] }): Pool => {
    const query = async (sql: string) => {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT e.task_id")) return { rows: opts.execRows };
      if (text.startsWith("SELECT tier, cards_attempted")) return { rows: opts.tierRows };
      throw new Error(`unexpected query in test: ${text}`);
    };
    return { query } as unknown as Pool;
  };

  it("assembles PRs (ordered by risk_score, already sorted by findForNight), security blocks, costs by tier, and triggered breakers", async () => {
    const prLinks = makeInMemoryPrLinkRepository();
    await prLinks.create({ sourceId: "s", taskId: "card-b", repo: "beta-app", prNumber: 9, branch: "b1", status: "open", riskScore: 50, greenLane: false });
    await prLinks.create({ sourceId: "s", taskId: "card-a", repo: "acme-widgets", prNumber: 5, branch: "b2", status: "open", riskScore: 10, greenLane: true });

    const pool = makeMockPool({
      execRows: [
        {
          task_id: "card-sec",
          metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "seguranca" } } } },
          provider_breakdown: null,
          title: "Card com achado de segurança",
          url: "https://trello.com/c/sec",
        },
        {
          task_id: "card-verify-falhou",
          metadata: { stateMachineContext: { outputs: { bloqueado: { blockReason: "verify-falhou" } } } },
          // Legacy pre-H11 row: bare provider keys must still map via fallback.
          provider_breakdown: { "kimi-cli": 0.02 },
          title: "Card com verify falhando",
          url: "https://trello.com/c/vf",
        },
        {
          task_id: "card-b",
          metadata: null,
          // H11: model-keyed costs — claude-opus-4-8 must land on opus (never
          // sonnet) and the architecture-judge composite maps to opus too.
          provider_breakdown: { "claude-sonnet-5": 1.23, "kimi-k2.6": 0.03, "claude-opus-4-8": 0.5, "architecture-judge": 0.25 },
          title: null,
          url: null,
        },
      ],
      tierRows: [
        { tier: "kimi", cards_attempted: 3, cards_failed: 3 },
        { tier: "sonnet", cards_attempted: 3, cards_failed: 1 },
      ],
    });

    const data = await gatherMorningReportData(pool, "night-1", { prLinks });

    expect(data.nightId).toBe("night-1");
    expect(data.prs.map((p) => p.cardId)).toEqual(["card-b", "card-a"]); // risk 50 before 10
    expect(data.prs[1].greenLane).toBe(true);

    expect(data.securityBlocks).toHaveLength(1);
    expect(data.securityBlocks[0]).toMatchObject({
      cardId: "card-sec",
      title: "Card com achado de segurança",
      blockReason: "seguranca",
      trelloUrl: "https://trello.com/c/sec",
    });

    // 2 bloqueado outputs total (1 security + 1 non-security "verify-falhou").
    expect(data.cardsBlocked).toBe(2);
    expect(data.cardsCompleted).toBe(2); // === prs.length

    expect(data.costsByTier).toEqual({ kimi: 0.05, sonnet: 1.23, opus: 0.75, fable: 0 });
    expect(data.circuitBreakersTriggered).toEqual([{ tier: "kimi" }]); // 3/3 > 0.6; sonnet 1/3 stays closed
  });

  it("builds a real GitHub PR URL when resolveGithubRepo is provided, falls back to the slug otherwise", async () => {
    const prLinks = makeInMemoryPrLinkRepository();
    await prLinks.create({ sourceId: "s", taskId: "card-a", repo: "acme-widgets", prNumber: 42, branch: "b1", status: "open", riskScore: 1 });
    const pool = makeMockPool({ execRows: [], tierRows: [] });

    const withResolver = await gatherMorningReportData(pool, "night-1", {
      prLinks,
      resolveGithubRepo: (slug) => (slug === "acme-widgets" ? "acme/widgets" : undefined),
    });
    expect(withResolver.prs[0].prUrl).toBe("https://github.com/acme/widgets/pull/42");

    const withoutResolver = await gatherMorningReportData(pool, "night-1", { prLinks });
    expect(withoutResolver.prs[0].prUrl).toBe("https://github.com/acme-widgets/pull/42");
  });
});

describe.skipIf(!hasTestDb())("gatherMorningReportData (real DB)", () => {
  const pool = makeTestPool();
  const nights: string[] = [];

  beforeAll(async () => {
    await ensureSchema(pool);
  });

  afterAll(async () => {
    for (const id of nights) await cleanupNight(pool, id);
    await pool.end();
  });

  const newNight = async (): Promise<string> => {
    const { rows } = await pool.query(
      `INSERT INTO night_runs (date, budget_cap_usd, pr_cap) VALUES ($1, 30, 6) RETURNING id`,
      [uniqueDate()]
    );
    const id = rows[0].id as string;
    nights.push(id);
    return id;
  };

  it("reads a real night end-to-end: 2 PRs, 1 security block, costs by tier, a triggered breaker", async () => {
    const nightId = await newNight();
    const sourceId = `s-${nightId}`;

    // Deliberately NOT inserting into `tasks` here: night-coordinator/claim.test.ts's
    // beforeEach does an unscoped `DELETE FROM tasks` for ITS OWN isolation
    // (documented as "the only test file that writes real tasks" — true until
    // this describe block), and vitest runs test FILES in parallel processes,
    // so a row inserted here could be wiped mid-test by that concurrent file.
    // The title/url-from-`tasks` fallback path is covered deterministically
    // in the mocked-pool describe block above instead.
    await pool.query(
      `INSERT INTO executions (id, routine_id, trigger_type, skill_name, status, started_at, night_id, source_id, task_id, metadata)
       VALUES (gen_random_uuid(), 'night-run', 'card-execution', 'card-to-pr', 'completed', NOW(), $1, $2, 'card-sec', $3::jsonb)`,
      [nightId, sourceId, JSON.stringify({ stateMachineContext: { outputs: { bloqueado: { blockReason: "seguranca-divergente" } } } })]
    );
    await pool.query(
      `INSERT INTO executions (id, routine_id, trigger_type, skill_name, status, started_at, night_id, source_id, task_id, provider_breakdown)
       VALUES (gen_random_uuid(), 'night-run', 'card-execution', 'card-to-pr', 'completed', NOW(), $1, $2, 'card-shipped', $3::jsonb)`,
      [nightId, sourceId, JSON.stringify({ "claude-cli": 2, "security-judge": 1, "claude-opus-4-8": 4 })]
    );
    // findForNight JOINs pr_links to executions on (source_id, task_id) filtered
    // by night_id — every PR needs its own execution row too, not just card-shipped.
    await pool.query(
      `INSERT INTO executions (id, routine_id, trigger_type, skill_name, status, started_at, night_id, source_id, task_id)
       VALUES (gen_random_uuid(), 'night-run', 'card-execution', 'card-to-pr', 'completed', NOW(), $1, $2, 'card-green')`,
      [nightId, sourceId]
    );

    await pool.query(
      `INSERT INTO pr_links (source_id, task_id, repo, pr_number, branch, status, risk_score, green_lane)
       VALUES ($1, 'card-shipped', 'acme-widgets', 12, 'b1', 'open', 40, false)`,
      [sourceId]
    );
    await pool.query(
      `INSERT INTO pr_links (source_id, task_id, repo, pr_number, branch, status, risk_score, green_lane)
       VALUES ($1, 'card-green', 'beta-app', 13, 'b2', 'open', 5, true)`,
      [sourceId]
    );

    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "kimi", "failure");

    const data = await gatherMorningReportData(pool, nightId);

    expect(data.prs).toHaveLength(2);
    expect(data.prs[0].riskScore).toBe(40); // ordered DESC
    expect(data.securityBlocks).toHaveLength(1);
    expect(data.securityBlocks[0]).toMatchObject({ cardId: "card-sec", blockReason: "seguranca-divergente" });
    expect(data.costsByTier.sonnet).toBe(2); // legacy provider-key fallback
    expect(data.costsByTier.opus).toBe(5); // security-judge (1) + model-keyed opus (4)
    expect(data.circuitBreakersTriggered).toEqual([{ tier: "kimi" }]);

    const { body } = renderMorningReportCard(data);
    expect(body.length).toBeLessThan(MAX_BODY_CHARS);
  });
});
