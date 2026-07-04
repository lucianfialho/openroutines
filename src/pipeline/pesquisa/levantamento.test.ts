import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeLevantamento, LEVANTAMENTO_ALLOWED_TOOLS } from "./levantamento.js";
import type { PesquisaDeps } from "./index.js";
import type { CompletionRequest, CompletionResponse } from "../../provider/types.js";

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "claude-sonnet-5",
  finishReason: "stop",
});

const validDoc = {
  summary: "s",
  currentState: "c",
  options: [
    { name: "A", tradeoffs: "t", recommended: true },
    { name: "B", tradeoffs: "t2", recommended: false },
  ],
  dataChanges: [],
  filesAffected: ["src/x.ts"],
  phases: ["p1", "p2"],
};

const prepOut = { repos: [{ slug: "acme", githubRepo: "a/b", clonePath: "/c", baseBranch: "dev" }], worktree: { path: "/wt/pesquisa-t1" } };
const inputs = { source_id: "s", task_id: "t1", repo: "acme", title: "T", description: "D" };

const baseDeps = (
  makeCliProvider: PesquisaDeps["makeCliProvider"]
): PesquisaDeps => ({
  registry: { repos: {} },
  githubToken: "gh",
  worktreeBase: "/tmp",
  taskSourceFor: () => undefined,
  claudeApiKey: "sk",
  makeCliProvider,
});

const run = (deps: PesquisaDeps, outputs: Record<string, unknown>) =>
  makeLevantamento(deps)({ inputs, outputs, executionId: "e", stateId: "levantamento_proposta" });

describe("card-pesquisa levantamento", () => {
  it("runs the survey with a least-privilege allowlist that DENIES Write/Edit (criterion 2)", async () => {
    const seen: CompletionRequest[] = [];
    const deps = baseDeps(() => ({
      complete: (req: CompletionRequest) => {
        seen.push(req);
        return Effect.succeed(resp(JSON.stringify(validDoc)));
      },
    }));

    await run(deps, { preparacao: prepOut });

    expect(seen).toHaveLength(1);
    const allow = seen[0].allowedTools!;
    expect(allow).toEqual(LEVANTAMENTO_ALLOWED_TOOLS);
    // read-only tools granted...
    expect(allow).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    // ...and NO write tool of any spelling — the phase's core guarantee.
    for (const denied of ["Write", "Edit", "write_file", "edit_file", "MultiEdit", "Bash(npm install:*)", "Bash(rm:*)"]) {
      expect(allow).not.toContain(denied);
    }
    // every Bash prefix in the list is one of the four read-only commands.
    const badBash = allow.filter((t) => t.startsWith("Bash(") && !/^Bash\((git log|git show|raizes-docs|ctx7):/.test(t));
    expect(badBash).toEqual([]);
    // the survey is pinned to the read-only worktree and constrained by the schema.
    expect(seen[0].workdir).toBe("/wt/pesquisa-t1");
    expect(seen[0].jsonSchema).toBeDefined();
  });

  it("rejects a malformed survey (missing required fields)", async () => {
    const deps = baseDeps(() => ({ complete: () => Effect.succeed(resp(JSON.stringify({ summary: "only" }))) }));
    await expect(run(deps, { preparacao: prepOut })).rejects.toBeTruthy();
  });

  it("folds the judge's prior corrections into the prompt on a refutado re-run", async () => {
    let prompt = "";
    const deps = baseDeps(() => ({
      complete: (req: CompletionRequest) => {
        prompt = req.messages![0].content;
        return Effect.succeed(resp(JSON.stringify(validDoc)));
      },
    }));
    await run(deps, {
      preparacao: prepOut,
      julgamento_arquitetura: {
        verdict: "refutado",
        corrections: ["use índice único", "não exponha o webhook sem auth"],
        securityOpinion: { exposesNewSurface: false, notes: "" },
      },
    });
    expect(prompt).toContain("CORREÇÕES DO JUÍZO ANTERIOR");
    expect(prompt).toContain("use índice único");
    expect(prompt).toContain("não exponha o webhook sem auth");
  });

  it("first pass has no corrections block and no dangling template placeholder", async () => {
    let prompt = "";
    const deps = baseDeps(() => ({
      complete: (req: CompletionRequest) => {
        prompt = req.messages![0].content;
        return Effect.succeed(resp(JSON.stringify(validDoc)));
      },
    }));
    await run(deps, { preparacao: prepOut });
    expect(prompt).not.toContain("CORREÇÕES DO JUÍZO ANTERIOR");
    expect(prompt).not.toContain("{{outputs");
    expect(prompt).not.toContain("{{inputs");
  });
});
