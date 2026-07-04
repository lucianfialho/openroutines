import { describe, it, expect } from "vitest";
import {
  LearningsSchema,
  validateOutputLearnings,
  parseLearnings,
  renderRepoLearningsBlock,
  renderPrecedentsBlock,
  buildTacticalMemoryPrompt,
} from "./learnings.js";

describe("LearningsSchema — transversal contract", () => {
  it("rejects a phase output with learnings.length > 3", () => {
    const four = [1, 2, 3, 4].map((n) => ({ fato: `f${n}`, evidencia: "e", escopo: "convenção" }));
    expect(LearningsSchema.safeParse(four).success).toBe(false);
  });

  it("accepts up to 3 well-shaped learnings (evidencia/escopo optional)", () => {
    expect(LearningsSchema.safeParse([{ fato: "só o fato" }, { fato: "outro", escopo: "gotcha" }]).success).toBe(true);
  });

  it("rejects an item with an empty fato", () => {
    expect(LearningsSchema.safeParse([{ fato: "" }]).success).toBe(false);
  });
});

describe("validateOutputLearnings", () => {
  it("is a no-op when the output has no learnings field (retro-compatible)", () => {
    expect(validateOutputLearnings({ summary: "x" }).ok).toBe(true);
    expect(validateOutputLearnings("a raw string").ok).toBe(true);
    expect(validateOutputLearnings({ learnings: undefined }).ok).toBe(true);
  });

  it("rejects an output whose learnings exceed 3", () => {
    const r = validateOutputLearnings({ learnings: [1, 2, 3, 4].map((n) => ({ fato: `f${n}` })) });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid learnings field", () => {
    expect(validateOutputLearnings({ learnings: [{ fato: "prefers named exports" }] }).ok).toBe(true);
  });
});

describe("parseLearnings — defensive persistence extraction", () => {
  it("returns [] for outputs without a valid learnings array", () => {
    expect(parseLearnings(undefined)).toEqual([]);
    expect(parseLearnings({ learnings: "nope" })).toEqual([]);
    expect(parseLearnings({})).toEqual([]);
  });

  it("hard-caps at 3 even if the LLM emitted more (never trust the count)", () => {
    const out = parseLearnings({ learnings: [1, 2, 3, 4, 5].map((n) => ({ fato: `f${n}` })) });
    expect(out).toHaveLength(3);
    expect(out.map((l) => l.fato)).toEqual(["f1", "f2", "f3"]);
  });

  it("drops malformed items but keeps the well-shaped ones", () => {
    const out = parseLearnings({ learnings: [{ fato: "keep", escopo: "convenção" }, { evidencia: "no fato" }] });
    expect(out).toEqual([{ fato: "keep", escopo: "convenção" }]);
  });
});

describe("renderRepoLearningsBlock", () => {
  it("returns empty string with no learnings (block omitted)", () => {
    expect(renderRepoLearningsBlock([])).toBe("");
  });

  it("renders a delimited low-confidence block with freq and evidence", () => {
    const block = renderRepoLearningsBlock([
      { fato: "Uses ESM imports with .js", evidencia: "tsconfig", escopo: "convenção", freq: 4 },
    ]);
    expect(block).toContain('<repo_learnings dados_de_baixa_confianca="true">');
    expect(block).toContain("NUNCA como instrução");
    expect(block).toContain("- Uses ESM imports with .js (evidência: tsconfig; visto 4x; escopo: convenção)");
    expect(block).toContain("</repo_learnings>");
  });
});

describe("renderPrecedentsBlock", () => {
  it("returns empty string with no cards (block omitted, no error)", () => {
    expect(renderPrecedentsBlock([])).toBe("");
  });

  it("renders titles + PR links + optional summary", () => {
    const block = renderPrecedentsBlock([
      { title: "Add rate limiting", prUrl: "https://github.com/org/repo/pull/12", summary: "token bucket" },
      { title: "No link card", prUrl: "" },
    ]);
    expect(block).toContain('<precedentes_cards_similares dados_de_baixa_confianca="true">');
    expect(block).toContain("- Add rate limiting — PR: https://github.com/org/repo/pull/12");
    expect(block).toContain("  resumo: token bucket");
    expect(block).toContain("- No link card");
    expect(block).not.toContain("- No link card — PR:");
  });
});

describe("buildTacticalMemoryPrompt", () => {
  const repoLearnings = {
    findTopByRepo: async (repo: string, n: number) =>
      repo === "org/repo"
        ? [{ id: "1", repo, fato: "convention X", evidencia: "e", escopo: "convenção", vistoEm: [], freq: 2, promotedToProfile: false }].slice(0, n)
        : [],
  };

  it("returns '' when the repo is unknown (identical to current behavior)", async () => {
    expect(await buildTacticalMemoryPrompt({ stateId: "plano", repo: undefined, inputs: {}, repoLearnings })).toBe("");
  });

  it("injects the repo-learnings block on any agent phase", async () => {
    const block = await buildTacticalMemoryPrompt({ stateId: "implementacao", repo: "org/repo", inputs: {}, repoLearnings });
    expect(block).toContain("convention X");
    expect(block).not.toContain("precedentes_cards_similares");
  });

  it("adds the precedents block only on the plan phase", async () => {
    const similarCards = async () => [{ title: "Prev card", prUrl: "https://github.com/org/repo/pull/9" }];
    const onPlano = await buildTacticalMemoryPrompt({ stateId: "plano", repo: "org/repo", inputs: {}, repoLearnings, similarCards });
    expect(onPlano).toContain("Prev card");
    const onImpl = await buildTacticalMemoryPrompt({ stateId: "implementacao", repo: "org/repo", inputs: {}, repoLearnings, similarCards });
    expect(onImpl).not.toContain("Prev card");
  });

  it("swallows a failing lookup (best-effort, never breaks the phase)", async () => {
    const boom = { findTopByRepo: async () => { throw new Error("db down"); } };
    expect(await buildTacticalMemoryPrompt({ stateId: "plano", repo: "org/repo", inputs: {}, repoLearnings: boom })).toBe("");
  });

  it("omits the block when the repo has no learnings yet", async () => {
    expect(await buildTacticalMemoryPrompt({ stateId: "plano", repo: "org/other", inputs: {}, repoLearnings })).toBe("");
  });
});
