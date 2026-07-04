import { describe, it, expect, afterAll } from "vitest";
import { makePostgresCardSteeringRepository } from "./card-steering-postgres.js";
import { hasTestDb, makeTestPool, ensureSchema } from "./db.test-helpers.js";
import type { Pool } from "pg";

describe.skipIf(!hasTestDb())("makePostgresCardSteeringRepository (real DB)", () => {
  let pool: Pool;
  const sourceId = "trello-main";
  const taskId = `card-steering-${crypto.randomUUID()}`;

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM card_steering WHERE source_id = $1 AND task_id = $2`, [sourceId, taskId]);
      await pool.query(`DELETE FROM tasks WHERE source_id = $1 AND task_id = $2`, [sourceId, taskId]);
      await pool.end();
    }
  });

  it("saves and round-trips a steering row (FK to tasks resolves)", async () => {
    pool = makeTestPool();
    await ensureSchema(pool);
    // The composite FK requires the task to already exist (019's design assumption).
    await pool.query(
      `INSERT INTO tasks (source_id, task_id, title, body, state, type) VALUES ($1, $2, 'Do the thing', '', 'backlog', 'implementation')`,
      [sourceId, taskId]
    );

    const repo = makePostgresCardSteeringRepository(pool);
    await repo.save({
      sourceId,
      taskId,
      authorTrelloId: "member-1",
      text: "Use the v2 endpoint instead",
      applied: false,
    });

    const found = await repo.findUnapplied(sourceId, taskId);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe("Use the v2 endpoint instead");
    expect(found[0].applied).toBe(false);
    expect(found[0].authorTrelloId).toBe("member-1");
  });

  it("rejects a steering row for a task that was never synced (FK enforced)", async () => {
    const repo = makePostgresCardSteeringRepository(pool);
    await expect(
      repo.save({
        sourceId,
        taskId: "never-synced-card",
        authorTrelloId: "member-1",
        text: "orphan comment",
        applied: false,
      })
    ).rejects.toThrow();
  });

  it("markApplied flips applied + effect_type; the row drops out of findUnapplied", async () => {
    const repo = makePostgresCardSteeringRepository(pool);
    const [row] = await repo.findUnapplied(sourceId, taskId);

    await repo.markApplied(row.id!, "reverted-approach");

    expect(await repo.findUnapplied(sourceId, taskId)).toHaveLength(0);
    const { rows } = await pool.query(`SELECT * FROM card_steering WHERE id = $1`, [row.id]);
    expect(rows[0].applied).toBe(true);
    expect(rows[0].effect_type).toBe("reverted-approach");
  });
});
