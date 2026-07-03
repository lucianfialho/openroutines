import { describe, it, expect, afterAll } from "vitest";
import { acquireNightLock } from "./lock.js";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, cleanupNight } from "../persistence/db.test-helpers.js";

describe.skipIf(!hasTestDb())("acquireNightLock (real DB)", () => {
  const pool = makeTestPool();
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) await cleanupNight(pool, id);
    await pool.end();
  });

  it("returns a nightId once per date; the 2nd caller for the same date gets null (AC1)", async () => {
    await ensureSchema(pool);
    const date = uniqueDate();

    const first = await acquireNightLock(pool, date, { budgetCapUsd: 30, prCap: 6 });
    const second = await acquireNightLock(pool, date, { budgetCapUsd: 30, prCap: 6 });

    expect(first?.nightId).toBeTruthy();
    expect(second).toBeNull();
    if (first) created.push(first.nightId);
  });

  it("grants distinct nightIds for distinct dates", async () => {
    const a = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    const b = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    expect(a?.nightId).toBeTruthy();
    expect(b?.nightId).toBeTruthy();
    expect(a?.nightId).not.toBe(b?.nightId);
    if (a) created.push(a.nightId);
    if (b) created.push(b.nightId);
  });

  it("two truly-parallel lock attempts on the same date yield exactly one winner", async () => {
    const date = uniqueDate();
    const [x, y] = await Promise.all([
      acquireNightLock(pool, date, { budgetCapUsd: 30, prCap: 6 }),
      acquireNightLock(pool, date, { budgetCapUsd: 30, prCap: 6 }),
    ]);
    const winners = [x, y].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    for (const w of winners) created.push(w!.nightId);
  });
});
