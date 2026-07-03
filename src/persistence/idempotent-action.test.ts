import { describe, it, expect } from "vitest";
import { runIdempotent } from "./idempotent-action.js";
import { makeInMemoryActionLedgerRepository } from "./action-ledger-in-memory.js";
import { makePostgresActionLedgerRepository } from "./action-ledger-postgres.js";
import { hasTestDb, makeTestPool, ensureSchema, insertExecution } from "./db.test-helpers.js";

describe("runIdempotent (in-memory ledger)", () => {
  it("fires the effect once, short-circuits the 2nd call with the stored ref (AC2)", async () => {
    const ledger = makeInMemoryActionLedgerRepository();
    let calls = 0;
    const ctx = { executionId: "exec-1", stateId: "pr", actionKey: "pr:create" };
    const run = async () => {
      calls += 1;
      return { externalRef: "https://github.com/o/r/pull/7" };
    };

    const first = await runIdempotent(ledger, ctx, run);
    const second = await runIdempotent(ledger, ctx, run);

    expect(calls).toBe(1);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.externalRef).toBe("https://github.com/o/r/pull/7");
  });

  it("records 'failed' on a throwing run and RE-DOES on the next attempt — never stuck pending (AC3)", async () => {
    const ledger = makeInMemoryActionLedgerRepository();
    let calls = 0;
    const ctx = { executionId: "exec-2", stateId: "pr", actionKey: "git:push" };

    await expect(
      runIdempotent(ledger, ctx, async () => {
        calls += 1;
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const entry = await ledger.findByKey("exec-2", "git:push");
    expect(entry?.status).toBe("failed");

    // Next attempt must actually retry, not short-circuit on a stale 'pending'.
    const retry = await runIdempotent(ledger, ctx, async () => {
      calls += 1;
      return { externalRef: "ok" };
    });
    expect(calls).toBe(2);
    expect(retry.skipped).toBe(false);
    expect(retry.externalRef).toBe("ok");
  });

  it("scopes idempotency per (executionId, actionKey)", async () => {
    const ledger = makeInMemoryActionLedgerRepository();
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { externalRef: `ref-${calls}` };
    };
    await runIdempotent(ledger, { executionId: "e", stateId: "pr", actionKey: "a" }, run);
    await runIdempotent(ledger, { executionId: "e", stateId: "pr", actionKey: "b" }, run);
    expect(calls).toBe(2); // different actionKey → both fire
  });
});

describe.skipIf(!hasTestDb())("runIdempotent (postgres ledger, real DB)", () => {
  it("short-circuits across a simulated crash: 2 runs → exactly 1 real effect", async () => {
    const pool = makeTestPool();
    await ensureSchema(pool);
    const executionId = crypto.randomUUID();
    await insertExecution(pool, executionId);
    const ledger = makePostgresActionLedgerRepository(pool);

    let calls = 0;
    const ctx = { executionId, stateId: "pr", actionKey: "pr:create" };
    const run = async () => {
      calls += 1;
      return { externalRef: "https://github.com/o/r/pull/9" };
    };

    // First "process" completes the action, second "process" (post-crash resume) must skip it.
    await runIdempotent(ledger, ctx, run);
    const resumed = await runIdempotent(ledger, ctx, run);

    expect(calls).toBe(1);
    expect(resumed.skipped).toBe(true);
    expect(resumed.externalRef).toBe("https://github.com/o/r/pull/9");

    await pool.query(`DELETE FROM action_ledger WHERE execution_id = $1`, [executionId]);
    await pool.query(`DELETE FROM executions WHERE id = $1`, [executionId]);
    await pool.end();
  });
});
