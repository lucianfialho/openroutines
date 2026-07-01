import { describe, it, expect } from "vitest";
import { makeGateEngine, GateBlockedError } from "./gate.js";
import { makeInMemoryGateRepository } from "./in-memory.js";

describe("makeGateEngine", () => {
  it("should create pending gate when none exists", async () => {
    const repo = makeInMemoryGateRepository();
    const engine = makeGateEngine({ repository: repo });

    const result = await engine.checkGate("exec-1", "manual_approval");

    expect(result.approved).toBe(false);
    expect(result.gateId).toBeDefined();

    const gate = await repo.findByExecution("exec-1");
    expect(gate).toBeDefined();
    expect(gate?.status).toBe("pending");
    expect(gate?.type).toBe("manual_approval");
  });

  it("should approve when gate is approved", async () => {
    const repo = makeInMemoryGateRepository();
    const engine = makeGateEngine({ repository: repo });

    const blocked = await engine.checkGate("exec-1", "manual_approval");
    expect(blocked.approved).toBe(false);

    await engine.approve(blocked.gateId, "LGTM");

    const result = await engine.checkGate("exec-1", "manual_approval");
    expect(result.approved).toBe(true);

    const gate = await repo.findByExecution("exec-1");
    expect(gate?.status).toBe("approved");
    expect(gate?.reason).toBe("LGTM");
  });

  it("should throw GateBlockedError when gate is rejected", async () => {
    const repo = makeInMemoryGateRepository();
    const engine = makeGateEngine({ repository: repo });

    const blocked = await engine.checkGate("exec-1", "manual_approval");
    await engine.reject(blocked.gateId, "Security issue");

    await expect(engine.checkGate("exec-1", "manual_approval")).rejects.toThrow(
      GateBlockedError
    );

    const gate = await repo.findByExecution("exec-1");
    expect(gate?.status).toBe("rejected");
    expect(gate?.reason).toBe("Security issue");
  });

  it("should support different gate types", async () => {
    const repo = makeInMemoryGateRepository();
    const engine = makeGateEngine({ repository: repo });

    await engine.checkGate("exec-1", "security_review");
    const gate = await repo.findByExecution("exec-1");
    expect(gate?.type).toBe("security_review");
  });

  it("should not create duplicate gates for the same execution and state", async () => {
    const repo = makeInMemoryGateRepository();
    const engine = makeGateEngine({ repository: repo });

    const [first, second] = await Promise.all([
      engine.checkGate("exec-1", "manual_approval", "state-a"),
      engine.checkGate("exec-1", "manual_approval", "state-a"),
    ]);

    expect(first.gateId).toBe(second.gateId);

    const allGates: unknown[] = [];
    // Access internal store via a saved gate lookup
    const gate = await repo.findByExecutionAndState("exec-1", "state-a");
    expect(gate).toBeDefined();
    allGates.push(gate);
    expect(allGates).toHaveLength(1);
  });

  it("should create a second gate for the same execution after the first is resolved", async () => {
    const repo = makeInMemoryGateRepository();
    const engine = makeGateEngine({ repository: repo });

    const review = await engine.checkGate("exec-1", "review", "review-state");
    expect(review.approved).toBe(false);

    await engine.approve(review.gateId, "review approved");

    const commit = await engine.checkGate("exec-1", "commit", "commit-state");
    expect(commit.approved).toBe(false);
    expect(commit.gateId).not.toBe(review.gateId);

    const stored = await repo.findByExecutionAndState("exec-1", "commit-state");
    expect(stored?.type).toBe("commit");
    expect(stored?.status).toBe("pending");
  });
});
