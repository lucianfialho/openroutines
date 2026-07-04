import { describe, it, expect } from "vitest";
import { aggregateRevisao } from "./aggregate.js";

const approvedCorrectness = { name: "correctness", output: { approved: true, gaps: [] } };
const approvedSecurity = { name: "security", output: { approved: true, findings: [], criticalArea: false } };

describe("aggregateRevisao", () => {
  it("approves when every present lens approves, no gaps, securityVerdict passes through", () => {
    const out = aggregateRevisao([approvedCorrectness, approvedSecurity]);
    expect(out).toEqual({
      approved: true,
      gaps: [],
      securityVerdict: { approved: true, findings: [], criticalArea: false },
    });
  });

  it("flips approved:false when one lens reports approved:false and unions its contestable gap", () => {
    const out = aggregateRevisao([
      { name: "correctness", output: { approved: false, gaps: [{ description: "missing AC", contestable: true }] } },
      approvedSecurity,
    ]);
    expect(out.approved).toBe(false);
    expect(out.gaps).toEqual([{ lens: "correctness", description: "missing AC", contestable: true }]);
  });

  it("securityVerdict is null when the security lens is absent (e.g. not yet wired in a test fixture)", () => {
    const out = aggregateRevisao([approvedCorrectness]);
    expect(out.securityVerdict).toBeNull();
  });

  it("a skipped lens (absent from lentes, e.g. dataChanges:false) contributes nothing", () => {
    const out = aggregateRevisao([approvedCorrectness, approvedSecurity]);
    expect(out.approved).toBe(true);
    expect(out.gaps).toEqual([]);
  });

  it("an 'open' security finding becomes a contestable gap WITHOUT flipping approved (that's the terminal verdict's job)", () => {
    const out = aggregateRevisao([
      approvedCorrectness,
      {
        name: "security",
        output: {
          approved: true, // not yet adjudicated — an "open" finding alone must never flip this
          findings: [{ description: "possible SSRF", status: "open", confidence: 9 }],
          criticalArea: false,
        },
      },
    ]);
    expect(out.approved).toBe(true);
    expect(out.gaps).toEqual([{ lens: "security", description: "possible SSRF", contestable: true }]);
  });

  it("a terminal (non-open) reproved security verdict flips approved without adding a gap for it", () => {
    const out = aggregateRevisao([
      approvedCorrectness,
      {
        name: "security",
        output: {
          approved: false,
          findings: [{ description: "confirmed SSRF", status: "confirmado", confidence: 9 }],
          criticalArea: true,
        },
      },
    ]);
    expect(out.approved).toBe(false);
    expect(out.gaps).toEqual([]);
    expect(out.securityVerdict).toMatchObject({ approved: false });
  });

  it("a lens that errored (no output) is fail-closed: approved:false plus a non-contestable gap describing it", () => {
    const out = aggregateRevisao([approvedCorrectness, { name: "data", error: "schema validation failed: bad JSON" }]);
    expect(out.approved).toBe(false);
    expect(out.gaps).toEqual([
      { lens: "data", description: "Lente 'data' falhou: schema validation failed: bad JSON", contestable: false },
    ]);
  });

  it("tags a correctness gap as 'conventions' when the lens marks rubrica:convencoes, defaults to 'correctness' otherwise", () => {
    const out = aggregateRevisao([
      {
        name: "correctness",
        output: {
          approved: false,
          gaps: [
            { description: "glossary mismatch", contestable: true, rubrica: "convencoes" },
            { description: "wrong root cause fixed", contestable: true },
          ],
        },
      },
    ]);
    expect(out.gaps).toEqual([
      { lens: "conventions", description: "glossary mismatch", contestable: true },
      { lens: "correctness", description: "wrong root cause fixed", contestable: true },
    ]);
  });

  it("non-contestable gaps from a lens are never unioned into the output (altitude rule: notes don't block)", () => {
    const out = aggregateRevisao([
      { name: "correctness", output: { approved: true, gaps: [{ description: "style nit", contestable: false }] } },
    ]);
    expect(out.gaps).toEqual([]);
    expect(out.approved).toBe(true);
  });

  it("carries file/line through when the lens provides them", () => {
    const out = aggregateRevisao([
      {
        name: "data",
        output: { approved: false, gaps: [{ description: "missing index", file: "prisma/schema.prisma", line: 42, contestable: true }] },
      },
    ]);
    expect(out.gaps).toEqual([{ lens: "data", description: "missing index", file: "prisma/schema.prisma", line: 42, contestable: true }]);
  });
});
