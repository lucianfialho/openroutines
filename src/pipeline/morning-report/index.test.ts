/**
 * morning-report pipeline tests (F4 #159).
 *
 * Handler-level unit tests run a mocked pool directly (no DB needed); the
 * "real DB" describe block drives the ACTUAL skill.yaml through
 * runStateMachine end-to-end (mirrors card-to-pr/e2e.test.ts), gated on
 * TEST_DATABASE_URL.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import type { Pool } from "pg";
import { Effect } from "effect";
import {
  makeCollectData,
  makeBuildReport,
  makePublishCard,
  registerMorningReportHandlers,
  type MorningReportDeps,
} from "./index.js";
import type { MorningReportData } from "../../report/morning-report.js";
import type { TaskSource } from "../../task-source/types.js";
import { runStateMachine } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import type { Routine } from "../../routine/types.js";
import type { TriggerEvent } from "../../routine/matcher.js";
import type { ExecutionRecord, ExecutionRepository } from "../../persistence/types.js";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, cleanupNight } from "../../persistence/db.test-helpers.js";

const makeMockPool = (opts: {
  nightId?: string;
  reportCardId?: string | null;
  execRows?: unknown[];
  tierRows?: unknown[];
  prRows?: unknown[];
}) => {
  const updates: Array<[string, unknown[]]> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT id FROM night_runs WHERE date")) {
      return { rows: opts.nightId ? [{ id: opts.nightId }] : [] };
    }
    if (text.startsWith("SELECT report_card_id FROM night_runs")) {
      return { rows: opts.nightId ? [{ report_card_id: opts.reportCardId ?? null }] : [] };
    }
    if (text.startsWith("UPDATE night_runs SET report_card_id")) {
      updates.push([text, params]);
      return { rows: [] };
    }
    if (text.startsWith("SELECT DISTINCT pl.*")) {
      return { rows: opts.prRows ?? [] };
    }
    if (text.startsWith("SELECT e.task_id")) {
      return { rows: opts.execRows ?? [] };
    }
    if (text.startsWith("SELECT tier, cards_attempted")) {
      return { rows: opts.tierRows ?? [] };
    }
    throw new Error(`unexpected query in test: ${text}`);
  });
  return { pool: { query } as unknown as Pool, updates };
};

const baseDeps = (pool: Pool, overrides: Partial<MorningReportDeps> = {}): MorningReportDeps => ({
  pool,
  tz: "UTC",
  taskSourceFor: () => undefined,
  sourceId: "trello-main",
  createCard: async () => ({ id: "new-card-id" }),
  now: () => new Date("2026-07-03T10:30:00Z"),
  ...overrides,
});

describe("makeCollectData", () => {
  it("returns nightId:null when no night_runs row exists for today (no crash, no further queries)", async () => {
    const { pool } = makeMockPool({});
    const result = await makeCollectData(baseDeps(pool))({ inputs: {}, outputs: {}, executionId: "e1", stateId: "collect_data" });
    expect(result).toEqual({ nightId: null });
  });

  it("gathers data for today's night_runs row", async () => {
    const { pool } = makeMockPool({ nightId: "night-1", execRows: [], tierRows: [], prRows: [] });
    const result = await makeCollectData(baseDeps(pool))({ inputs: {}, outputs: {}, executionId: "e1", stateId: "collect_data" });
    expect((result as { nightId: string }).nightId).toBe("night-1");
    expect((result as { data: MorningReportData }).data.nightId).toBe("night-1");
  });
});

describe("makeBuildReport", () => {
  it("renders a placeholder body when no night ran", async () => {
    const result = (await makeBuildReport()({
      inputs: {},
      outputs: { collect_data: { nightId: null } },
      executionId: "e1",
      stateId: "build_report",
    })) as { title: string; body: string };
    expect(result.body).toContain("Nenhuma execução noturna");
  });

  it("delegates to renderMorningReportCard when data is present", async () => {
    const data: MorningReportData = {
      nightId: "night-1",
      securityBlocks: [],
      prs: [],
      costsByTier: { kimi: 0, sonnet: 0, opus: 0, fable: 0 },
      cardsCompleted: 0,
      cardsBlocked: 0,
      circuitBreakersTriggered: [],
    };
    const result = (await makeBuildReport()({
      inputs: {},
      outputs: { collect_data: { nightId: "night-1", data } },
      executionId: "e1",
      stateId: "build_report",
    })) as { title: string; body: string };
    expect(result.body).toContain("📊 [Relatório]");
    expect(result.body).toContain("min de review");
  });
});

describe("makePublishCard", () => {
  const outputsFor = (nightId: string | null) => ({
    collect_data: { nightId },
    build_report: { title: "📊 Relatório matinal", body: "corpo do relatório" },
  });

  it("creates a new card and persists report_card_id when none exists yet", async () => {
    const { pool, updates } = makeMockPool({ nightId: "night-1", reportCardId: null });
    const createCard = vi.fn(async () => ({ id: "brand-new-card" }));
    const comment = vi.fn(() => Effect.succeed(undefined));
    const taskSourceFor = () => ({ comment } as unknown as TaskSource);

    const result = (await makePublishCard(baseDeps(pool, { createCard, taskSourceFor }))({
      inputs: {},
      outputs: outputsFor("night-1"),
      executionId: "e1",
      stateId: "publish_card",
    })) as { cardId: string; published: boolean };

    expect(createCard).toHaveBeenCalledTimes(1);
    expect(result.cardId).toBe("brand-new-card");
    expect(result.published).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(["brand-new-card", "night-1"]);
    expect(comment).toHaveBeenCalledWith("brand-new-card", "corpo do relatório");
  });

  it("reuses the existing card (idempotent — no duplicate create) when report_card_id is already set", async () => {
    const { pool, updates } = makeMockPool({ nightId: "night-1", reportCardId: "existing-card" });
    const createCard = vi.fn(async () => ({ id: "should-not-be-used" }));
    const comment = vi.fn(() => Effect.succeed(undefined));
    const taskSourceFor = () => ({ comment } as unknown as TaskSource);

    const result = (await makePublishCard(baseDeps(pool, { createCard, taskSourceFor }))({
      inputs: {},
      outputs: outputsFor("night-1"),
      executionId: "e1",
      stateId: "publish_card",
    })) as { cardId: string; published: boolean };

    expect(createCard).not.toHaveBeenCalled();
    expect(result.cardId).toBe("existing-card");
    expect(updates).toHaveLength(0); // no new persist — already guarded
    expect(comment).toHaveBeenCalledWith("existing-card", "corpo do relatório");
  });

  it("still creates/publishes when there is no night_runs row (no persistable guard, documented ponytail gap)", async () => {
    const { pool } = makeMockPool({});
    const createCard = vi.fn(async () => ({ id: "no-night-card" }));
    const result = (await makePublishCard(baseDeps(pool, { createCard, taskSourceFor: () => undefined }))({
      inputs: {},
      outputs: outputsFor(null),
      executionId: "e1",
      stateId: "publish_card",
    })) as { cardId: string; published: boolean };
    expect(createCard).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(false); // no TaskSource resolved -> comment skipped, doesn't throw
  });
});

describe("registerMorningReportHandlers", () => {
  it("registers all 3 script names", () => {
    const reg = makeScriptRegistry();
    const { pool } = makeMockPool({});
    registerMorningReportHandlers(reg, baseDeps(pool));
    expect(reg.get("morning-report-collect-data")).toBeDefined();
    expect(reg.get("morning-report-build-report")).toBeDefined();
    expect(reg.get("morning-report-publish-card")).toBeDefined();
  });
});

describe.skipIf(!hasTestDb())("morning-report skill.yaml E2E (real DB)", () => {
  const pool = makeTestPool();
  const nights: string[] = [];

  beforeAll(async () => {
    await ensureSchema(pool);
  });

  afterAll(async () => {
    for (const id of nights) await cleanupNight(pool, id);
    await pool.end();
  });

  const makeRepo = (): ExecutionRepository => {
    const store = new Map<string, ExecutionRecord>();
    store.set("exec1", {
      id: "exec1",
      routineId: "morning-report",
      triggerType: "schedule",
      skillName: "morning-report",
      status: "pending",
      startedAt: new Date(),
    });
    return {
      save: async (rec) => void store.set(rec.id, rec),
      findById: async (id) => store.get(id),
      findByRoutine: async () => [],
      findByTask: async () => [],
      findAll: async () => [],
    };
  };

  it("drives collect_data -> build_report -> publish_card -> done and creates the card once", async () => {
    const date = uniqueDate();
    const { rows } = await pool.query(`INSERT INTO night_runs (date, budget_cap_usd, pr_cap) VALUES ($1, 30, 6) RETURNING id`, [
      date,
    ]);
    const nightId = rows[0].id as string;
    nights.push(nightId);

    const skill = parseSkillStateMachine(readFileSync(".gates/skills/morning-report/skill.yaml", "utf-8"));
    const routine: Routine = { id: "morning-report", triggers: [{ type: "schedule", cron: "30 7 * * *" }], pipeline: { skill: "morning-report" } };
    const event: TriggerEvent = { type: "schedule", payload: {} };

    const createCard = vi.fn(async () => ({ id: "e2e-card-1" }));
    const comment = vi.fn(() => Effect.succeed(undefined));
    const taskSourceFor = () => ({ comment } as unknown as TaskSource);

    const scriptRegistry = makeScriptRegistry();
    registerMorningReportHandlers(scriptRegistry, {
      pool,
      tz: "UTC",
      taskSourceFor,
      sourceId: "trello-main",
      createCard,
      now: () => {
        // Match the SAME date the night_runs row above was inserted with.
        const [y, m, d] = date.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d, 10, 30, 0));
      },
    });

    const result = await Effect.runPromise(
      runStateMachine({ provider: { complete: () => Effect.succeed({ content: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: "mock", finishReason: "stop" }) }, scriptRegistry, repository: makeRepo() })(
        skill,
        routine,
        event,
        "exec1"
      )
    );

    expect(result.success).toBe(true);
    expect(createCard).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledTimes(1);
    const [cardId, body] = comment.mock.calls[0];
    expect(cardId).toBe("e2e-card-1");
    expect(body).toContain("📊 [Relatório]");

    const { rows: nightRows } = await pool.query(`SELECT report_card_id FROM night_runs WHERE id = $1`, [nightId]);
    expect(nightRows[0].report_card_id).toBe("e2e-card-1");
  });
});
