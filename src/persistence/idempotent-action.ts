/**
 * Idempotent external action wrapper (F3 #149).
 *
 * Wraps a side effect (git push, PR create, Trello move/comment) so it fires at
 * most once per (executionId, actionKey): if a prior run already completed it,
 * the recorded external_ref is returned without re-running. A mid-flight failure
 * records 'failed' and the NEXT attempt re-does the action — it never sticks in
 * 'pending'. Only 'done' short-circuits.
 */
import type { ActionLedgerRepository } from "./types.js";

export const runIdempotent = async (
  ledger: ActionLedgerRepository,
  ctx: { executionId: string; stateId: string; actionKey: string },
  run: () => Promise<{ externalRef?: string }>
): Promise<{ externalRef?: string; skipped: boolean }> => {
  const existing = await ledger.findByKey(ctx.executionId, ctx.actionKey);
  if (existing?.status === "done") {
    return { externalRef: existing.externalRef, skipped: true };
  }
  await ledger.recordPending(ctx.executionId, ctx.stateId, ctx.actionKey);
  try {
    const result = await run();
    await ledger.complete(ctx.executionId, ctx.actionKey, result.externalRef);
    return { externalRef: result.externalRef, skipped: false };
  } catch (err) {
    await ledger.fail(ctx.executionId, ctx.actionKey, err instanceof Error ? err.message : String(err));
    throw err;
  }
};
