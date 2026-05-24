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

    const blocked = await engine.checkGate("exec-1", "security_review");
    const gate = await repo.findByExecution("exec-1");
    expect(gate?.type).toBe("security_review");
  });
});
