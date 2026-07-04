/**
 * Circuit breaker tests (F4 #159).
 *
 * Pure-logic + mocked-pool unit tests always run; the real-Postgres suite
 * (the atomic UPSERT/threshold behavior against an actual `tier_circuit_state`
 * row) is gated on TEST_DATABASE_URL, mirroring night-coordinator/claim.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import {
  isTierOpen,
  recordTierOutcome,
  tierForComplexity,
  MIN_SAMPLE_SIZE,
  FAILURE_RATE_THRESHOLD,
} from "./circuit-breaker.js";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, cleanupNight } from "../persistence/db.test-helpers.js";

describe("tierForComplexity (D9 routing table)", () => {
  it("routes lowest/low to kimi", () => {
    expect(tierForComplexity("lowest")).toBe("kimi");
    expect(tierForComplexity("low")).toBe("kimi");
  });

  it("routes medium/high/not_sure to sonnet", () => {
    expect(tierForComplexity("medium")).toBe("sonnet");
    expect(tierForComplexity("high")).toBe("sonnet");
    expect(tierForComplexity("not_sure")).toBe("sonnet");
  });

  it("routes highest to opus", () => {
    expect(tierForComplexity("highest")).toBe("opus");
  });

  it("defaults unclassified (undefined) to sonnet, same as not_sure", () => {
    expect(tierForComplexity(undefined)).toBe("sonnet");
  });
});

describe("isTierOpen (mocked pool)", () => {
  const makeMockPool = (row?: { cards_attempted: number; cards_failed: number }) =>
    ({ query: vi.fn(async () => ({ rows: row ? [row] : [] })) }) as unknown as Pool;

  it("false when no row exists yet (tier never attempted this night)", async () => {
    const pool = makeMockPool(undefined);
    expect(await isTierOpen(pool, "night-1", "kimi")).toBe(false);
  });

  it("false below MIN_SAMPLE_SIZE even at 100% failure", async () => {
    const pool = makeMockPool({ cards_attempted: MIN_SAMPLE_SIZE - 1, cards_failed: MIN_SAMPLE_SIZE - 1 });
    expect(await isTierOpen(pool, "night-1", "kimi")).toBe(false);
  });

  it("true at MIN_SAMPLE_SIZE with failure rate above threshold", async () => {
    const failed = Math.floor(MIN_SAMPLE_SIZE * FAILURE_RATE_THRESHOLD) + 1;
    const pool = makeMockPool({ cards_attempted: MIN_SAMPLE_SIZE, cards_failed: failed });
    expect(await isTierOpen(pool, "night-1", "kimi")).toBe(true);
  });

  it("false at MIN_SAMPLE_SIZE with failure rate at/below threshold", async () => {
    const pool = makeMockPool({ cards_attempted: MIN_SAMPLE_SIZE, cards_failed: 1 });
    expect(await isTierOpen(pool, "night-1", "kimi")).toBe(false);
  });

  it("queries scoped by both night_id and tier", async () => {
    const pool = makeMockPool(undefined);
    await isTierOpen(pool, "night-42", "opus");
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("WHERE night_id = $1 AND tier = $2"), [
      "night-42",
      "opus",
    ]);
  });
});

describe("recordTierOutcome (mocked pool)", () => {
  it("upserts with cards_failed increment 0 on success", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;
    await recordTierOutcome(pool, "night-1", "sonnet", "success");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (night_id, tier) DO UPDATE"), [
      "night-1",
      "sonnet",
      0,
    ]);
  });

  it("upserts with cards_failed increment 1 on failure", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;
    await recordTierOutcome(pool, "night-1", "kimi", "failure");
    expect(query).toHaveBeenCalledWith(expect.any(String), ["night-1", "kimi", 1]);
  });
});

describe.skipIf(!hasTestDb())("circuit breaker (real DB, atomic)", () => {
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

  it("stays closed below MIN_SAMPLE_SIZE even at 100% failure", async () => {
    const nightId = await newNight();
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    expect(await isTierOpen(pool, nightId, "kimi")).toBe(false);
  });

  it("opens once MIN_SAMPLE_SIZE is reached with >60% failure", async () => {
    const nightId = await newNight();
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "kimi", "success");
    // 2/3 = 0.667 > 0.6
    expect(await isTierOpen(pool, nightId, "kimi")).toBe(true);
  });

  it("stays closed at MIN_SAMPLE_SIZE with failure rate at/below 60%", async () => {
    const nightId = await newNight();
    await recordTierOutcome(pool, nightId, "sonnet", "failure");
    await recordTierOutcome(pool, nightId, "sonnet", "success");
    await recordTierOutcome(pool, nightId, "sonnet", "success");
    // 1/3 = 0.333, well under 0.6
    expect(await isTierOpen(pool, nightId, "sonnet")).toBe(false);
  });

  it("tracks tiers independently within the same night", async () => {
    const nightId = await newNight();
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "kimi", "failure");
    await recordTierOutcome(pool, nightId, "opus", "success");
    await recordTierOutcome(pool, nightId, "opus", "success");
    await recordTierOutcome(pool, nightId, "opus", "success");
    expect(await isTierOpen(pool, nightId, "kimi")).toBe(true);
    expect(await isTierOpen(pool, nightId, "opus")).toBe(false);
  });

  it("the next night resets the breaker (different night_id, fresh counters)", async () => {
    const nightA = await newNight();
    await recordTierOutcome(pool, nightA, "kimi", "failure");
    await recordTierOutcome(pool, nightA, "kimi", "failure");
    await recordTierOutcome(pool, nightA, "kimi", "failure");
    expect(await isTierOpen(pool, nightA, "kimi")).toBe(true);

    const nightB = await newNight();
    expect(await isTierOpen(pool, nightB, "kimi")).toBe(false);
  });
});
