import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { claimReadyCards, type ClaimCandidate } from "./claim.js";
import { acquireNightLock } from "./lock.js";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, cleanupNight } from "../persistence/db.test-helpers.js";
import type { Pool } from "pg";

const insertQueuedTask = async (
  pool: Pool,
  sourceId: string,
  taskId: string,
  opts: { priority?: string; complexity?: string; body?: string } = {}
): Promise<void> => {
  await pool.query(
    `INSERT INTO tasks (source_id, task_id, title, body, state, type, priority, complexity, labels, assignees)
     VALUES ($1, $2, $3, $4, 'queued', 'implementation', $5, $6, '[]', '[]')
     ON CONFLICT (source_id, task_id) DO UPDATE SET state = 'queued', claimed_by_night_id = NULL`,
    [sourceId, taskId, `title ${taskId}`, opts.body ?? "", opts.priority ?? null, opts.complexity ?? null]
  );
};

// Repo lives in the taskId prefix for the test (real coordinator derives it from the card's "Repositório" field).
const repoByPrefix = (t: ClaimCandidate): string | undefined => {
  const m = t.taskId.match(/^([a-z]+)-/);
  return m ? m[1] : undefined;
};

describe.skipIf(!hasTestDb())("claimReadyCards (real DB, atomic)", () => {
  const pool = makeTestPool();
  const nights: string[] = [];
  const sources: string[] = [];

  beforeAll(async () => {
    await ensureSchema(pool);
  });

  // claimReadyCards scans the whole queue by design, so each test must start from
  // an empty tasks table — this is the only test file that writes real `tasks`.
  beforeEach(async () => {
    await pool.query(`DELETE FROM tasks`);
  });

  afterAll(async () => {
    for (const s of sources) await pool.query(`DELETE FROM tasks WHERE source_id = $1`, [s]);
    for (const id of nights) await cleanupNight(pool, id);
    await pool.end();
  });

  const newNight = async (): Promise<string> => {
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    nights.push(lock!.nightId);
    return lock!.nightId;
  };

  it("never puts two cards of the same repo in one batch, capped by the limit (AC3)", async () => {
    const src = `s-${crypto.randomUUID()}`;
    sources.push(src);
    // 5 cards across 2 repos: repoa×3, repob×2.
    await insertQueuedTask(pool, src, "repoa-1");
    await insertQueuedTask(pool, src, "repoa-2");
    await insertQueuedTask(pool, src, "repoa-3");
    await insertQueuedTask(pool, src, "repob-1");
    await insertQueuedTask(pool, src, "repob-2");
    const nightId = await newNight();

    const claimed = await claimReadyCards(pool, nightId, 2, { resolveRepo: repoByPrefix });

    expect(claimed.length).toBeLessThanOrEqual(2);
    const repos = claimed.map((c) => c.repo);
    expect(new Set(repos).size).toBe(repos.length); // no repo twice in the batch
    expect(new Set(repos)).toEqual(new Set(["repoa", "repob"]));
  });

  it("same repo in series: with all cards in one repo, claims at most one per batch", async () => {
    const src = `s-${crypto.randomUUID()}`;
    sources.push(src);
    await insertQueuedTask(pool, src, "solo-1");
    await insertQueuedTask(pool, src, "solo-2");
    await insertQueuedTask(pool, src, "solo-3");
    const nightId = await newNight();

    const claimed = await claimReadyCards(pool, nightId, 3, { resolveRepo: repoByPrefix });
    expect(claimed).toHaveLength(1);
  });

  it("skips repos that already have a running execution (busyRepos)", async () => {
    const src = `s-${crypto.randomUUID()}`;
    sources.push(src);
    await insertQueuedTask(pool, src, "busya-1");
    await insertQueuedTask(pool, src, "freeb-1");
    const nightId = await newNight();

    const claimed = await claimReadyCards(pool, nightId, 2, {
      resolveRepo: repoByPrefix,
      busyRepos: new Set(["busya"]),
    });
    expect(claimed.map((c) => c.repo)).toEqual(["freeb"]);
  });

  it("skips cards whose repo cannot be resolved", async () => {
    const src = `s-${crypto.randomUUID()}`;
    sources.push(src);
    await insertQueuedTask(pool, src, "norepocard"); // no prefix → resolveRepo undefined
    const nightId = await newNight();

    const claimed = await claimReadyCards(pool, nightId, 2, { resolveRepo: repoByPrefix });
    expect(claimed).toHaveLength(0);
  });

  it("two concurrent coordinators racing for the same card produce exactly one winner", async () => {
    const src = `s-${crypto.randomUUID()}`;
    sources.push(src);
    await insertQueuedTask(pool, src, "racex-1");
    const nightA = await newNight();
    const nightB = await newNight();

    const [a, b] = await Promise.all([
      claimReadyCards(pool, nightA, 1, { resolveRepo: repoByPrefix }),
      claimReadyCards(pool, nightB, 1, { resolveRepo: repoByPrefix }),
    ]);
    expect(a.length + b.length).toBe(1); // the card is claimed once, by one night only
  });

  it("orders by priority then complexity", async () => {
    const src = `s-${crypto.randomUUID()}`;
    sources.push(src);
    await insertQueuedTask(pool, src, "ord-low", { priority: "low" });
    await insertQueuedTask(pool, src, "ord-high", { priority: "highest" });
    const nightId = await newNight();

    // Two different repos so both are claimable; the high-priority one comes first.
    const claimed = await claimReadyCards(pool, nightId, 1, {
      resolveRepo: (t) => t.taskId, // each card its own repo
    });
    expect(claimed[0].taskId).toBe("ord-high");
  });
});
