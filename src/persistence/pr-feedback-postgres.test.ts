import { describe, it, expect, afterAll } from "vitest";
import { makePostgresPrFeedbackRepository } from "./pr-feedback-postgres.js";
import { hasTestDb, makeTestPool, ensureSchema } from "./db.test-helpers.js";
import type { Pool } from "pg";

describe.skipIf(!hasTestDb())("makePostgresPrFeedbackRepository (real DB)", () => {
  let pool: Pool;
  const repoName = `org/pr-feedback-${crypto.randomUUID()}`;

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM pr_feedback WHERE repo = $1`, [repoName]);
      await pool.end();
    }
  });

  it("saves a row and finds it by repo", async () => {
    pool = makeTestPool();
    await ensureSchema(pool);
    const repo = makePostgresPrFeedbackRepository(pool);

    await repo.save({
      repo: repoName,
      prNumber: 7,
      sourceId: "trello-main",
      taskId: "card-1",
      kind: "review-comment",
      content: "Please add a test",
    });

    const found = await repo.findByRepo(repoName);
    expect(found).toHaveLength(1);
    expect(found[0].prNumber).toBe(7);
    expect(found[0].kind).toBe("review-comment");
    expect(found[0].content).toBe("Please add a test");
  });

  it("allows a null pr_number for a 'steering' row that predates any PR", async () => {
    const repo = makePostgresPrFeedbackRepository(pool);
    await repo.save({
      repo: repoName,
      sourceId: "trello-main",
      taskId: "card-2",
      kind: "steering",
      content: "Split this into two cards",
    });

    const found = await repo.findByRepo(repoName);
    const steering = found.find((f) => f.kind === "steering");
    expect(steering?.prNumber).toBeUndefined();
  });

  it("findSince returns only rows at/after the given timestamp", async () => {
    const repo = makePostgresPrFeedbackRepository(pool);
    const cutoff = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await repo.save({
      repo: repoName,
      sourceId: "trello-main",
      taskId: "card-3",
      kind: "human-delta",
      content: "renamed a var after merge",
    });

    const found = await repo.findSince(cutoff);
    expect(found.some((f) => f.taskId === "card-3")).toBe(true);
    expect(found.some((f) => f.taskId === "card-1")).toBe(false); // saved before cutoff
  });
});
