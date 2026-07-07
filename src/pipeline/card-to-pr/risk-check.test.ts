import { describe, it, expect } from "vitest";
import { makeRiskCheck, type RiskCheckOutput } from "./risk-check.js";

const run = (plan: unknown): Promise<RiskCheckOutput> =>
  makeRiskCheck()({ inputs: {}, outputs: { plan }, executionId: "e", stateId: "risk_check" }) as Promise<RiskCheckOutput>;

describe("card-to-pr risk-check", () => {
  it("a clean plan (self-assessed false, only non-sensitive files, no data changes) needs no gate", async () => {
    const out = await run({ needsArchGate: false, files: ["src/util/format.ts"], dataChanges: [] });
    expect(out).toEqual({ needsArchGate: false, reasons: [] });
  });

  it("a sensitive path forces the gate even when the plan rated itself safe", async () => {
    const out = await run({ needsArchGate: false, files: ["src/auth/login.ts"] });
    expect(out.needsArchGate).toBe(true);
    expect(out.reasons).toContain("sensitive path: src/auth/login.ts");
  });

  it("a non-empty dataChanges forces the gate", async () => {
    const out = await run({ needsArchGate: false, files: [], dataChanges: [{ table: "users" }] });
    expect(out.needsArchGate).toBe(true);
    expect(out.reasons).toContain("data changes");
  });

  it("the plan's own needsArchGate=true is honored and surfaced as a reason", async () => {
    const out = await run({ needsArchGate: true, files: [] });
    expect(out.needsArchGate).toBe(true);
    expect(out.reasons).toContain("self-assessed");
  });

  it("a missing plan output degrades to no gate rather than crashing", async () => {
    const out = await run(undefined);
    expect(out).toEqual({ needsArchGate: false, reasons: [] });
  });
});
