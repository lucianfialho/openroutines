import { describe, it, expect, afterAll } from "vitest";
import { makePostgresRepoLearningRepository } from "./repo-learnings-postgres.js";
import { hasTestDb, makeTestPool, ensureSchema } from "./db.test-helpers.js";
import type { Pool } from "pg";

describe.skipIf(!hasTestDb())("makePostgresRepoLearningRepository (real DB)", () => {
  let pool: Pool;
  const repoName = `org/repo-learnings-${crypto.randomUUID()}`;

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM repo_learnings WHERE repo = $1`, [repoName]);
      await pool.end();
    }
  });

  it("CRITICAL: upsertByFato dedupes a normalized repeat (lowercase+trim) into freq 2, exactly one row", async () => {
    pool = makeTestPool();
    await ensureSchema(pool);
    const repo = makePostgresRepoLearningRepository(pool);

    await repo.upsertByFato(repoName, { fato: "Uses Zod for validation", evidencia: "schemas/user.ts" });
    await repo.upsertByFato(repoName, { fato: "  uses zod for validation  " });

    const { rows } = await pool.query(`SELECT * FROM repo_learnings WHERE repo = $1`, [repoName]);
    expect(rows).toHaveLength(1);
    expect(rows[0].freq).toBe(2);
    expect(rows[0].visto_em).toHaveLength(2);
    // Original casing/spacing of the first sighting is preserved as the canonical fato.
    expect(rows[0].fato).toBe("Uses Zod for validation");
  });

  it("a repeat sighting without evidencia keeps the previously-stored evidencia (COALESCE-preserve)", async () => {
    const repo = makePostgresRepoLearningRepository(pool);
    await repo.upsertByFato(repoName, { fato: "Prefers composition over inheritance", evidencia: "base.ts" });
    await repo.upsertByFato(repoName, { fato: "prefers composition over inheritance" });

    const top = await repo.findTopByRepo(repoName, 10);
    const row = top.find((r) => r.fato === "Prefers composition over inheritance");
    expect(row?.evidencia).toBe("base.ts");
  });

  it("findTopByRepo orders by freq desc", async () => {
    const repo = makePostgresRepoLearningRepository(pool);
    await repo.upsertByFato(repoName, { fato: "Rare thing A" });
    // freq 3, unambiguously above any freq-2 row other tests in this file may
    // have already left behind under the same shared repoName.
    await repo.upsertByFato(repoName, { fato: "Popular thing B" });
    await repo.upsertByFato(repoName, { fato: "popular thing b" });
    await repo.upsertByFato(repoName, { fato: "POPULAR THING B" });

    const top = await repo.findTopByRepo(repoName, 2);
    expect(top[0].fato).toBe("Popular thing B");
    expect(top[0].freq).toBe(3);
  });

  it("findPromotable surfaces freq>=3 unpromoted rows; markPromoted removes them from the list", async () => {
    const repo = makePostgresRepoLearningRepository(pool);
    const fact = `Promotable fact ${crypto.randomUUID()}`;
    await repo.upsertByFato(repoName, { fato: fact });
    await repo.upsertByFato(repoName, { fato: fact.toLowerCase() });
    await repo.upsertByFato(repoName, { fato: fact.toUpperCase() });

    const promotable = await repo.findPromotable();
    const row = promotable.find((r) => r.repo === repoName);
    expect(row).toBeDefined();
    expect(row!.freq).toBe(3);

    await repo.markPromoted(row!.id!);
    const afterPromotion = await repo.findPromotable();
    expect(afterPromotion.some((r) => r.id === row!.id)).toBe(false);
  });
});
