/**
 * card-research E2E (F5 #161): drives the REAL skill.yaml through
 * runStateMachine with the 4 script handlers registered and every external
 * effect (git worktree, claude-cli survey, claude.ts judgment, GitHub, Trello)
 * mocked/injected — mirrors card-to-pr/e2e.test.ts's harness.
 *
 * preparation -> survey_proposal -> architecture_judgment -> delivery ->
 * done, plus the bounded refutado refinement loop.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import { registerResearchHandlers, SONNET_MODEL } from "./index.js";
import type { ResearchDeps } from "./index.js";
import type { CompletionRequest, CompletionResponse } from "../../provider/types.js";
import type { Routine } from "../../routine/types.js";
import type { TriggerEvent } from "../../routine/matcher.js";
import type { ExecutionRecord } from "../../persistence/types.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { TaskSource } from "../../task-source/types.js";

const routine: Routine = { id: "r", triggers: [{ type: "task_source" }], pipeline: { skill: "card-research" } } as Routine;

const resp = (content: string, model: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model,
  finishReason: "stop",
});

const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", { id: "exec1", routineId: "r", triggerType: "task_source", skillName: "card-research", status: "pending", startedAt: new Date() });
  let lastContext: StateMachineContext | undefined;
  return {
    repo: {
      save: async (rec: ExecutionRecord) => {
        const smc = (rec.metadata as { stateMachineContext?: StateMachineContext } | undefined)?.stateMachineContext;
        if (smc) lastContext = smc;
        store.set(rec.id, rec);
      },
      findById: async (id: string) => store.get(id),
      findByRoutine: async () => [],
      findAll: async () => [],
    },
    lastContext: () => lastContext,
  };
};

const registry: RepoRegistry = {
  repos: { "acme-widgets": { clonePath: "/tmp/or-pesquisa-e2e-clone", githubRepo: "acme/widgets", baseBranch: "development", verify: { build: "true", test: "true" } } },
};

const survey = (phaseCount: number) =>
  JSON.stringify({
    summary: "resumo executivo da proposta",
    currentState: "estado atual",
    options: [
      { name: "Alternativa A", tradeoffs: "prós/contras A", recommended: true },
      { name: "Alternativa B", tradeoffs: "prós/contras B", recommended: false },
    ],
    dataChanges: [],
    filesAffected: ["src/x.ts"],
    phases: Array.from({ length: phaseCount }, (_, i) => `Fase ${i + 1}`),
  });

const aprovado = JSON.stringify({ verdict: "aprovado", corrections: [], securityOpinion: { exposesNewSurface: false, notes: "ok" } });

interface GhRec {
  milestones: Array<{ title: string }>;
  issues: Array<{ title: string; opts?: { milestone?: number } }>;
}
interface TsRec {
  comments: string[];
  attachments: Array<{ filename: string; content: string }>;
  moves: Array<{ id: string; state: string }>;
}

const makeDeps = (over: {
  gh: GhRec;
  ts: TsRec;
  cli: (req: CompletionRequest) => CompletionResponse;
  api: (model: string) => CompletionResponse;
  worktreeBase: string;
}): ResearchDeps => ({
  registry,
  githubToken: "gh",
  worktreeBase: over.worktreeBase,
  claudeApiKey: "sk",
  runGit: async () => ({ stdout: "", stderr: "" }),
  makeCliProvider: () => ({ complete: (req: CompletionRequest) => Effect.succeed(over.cli(req)) }),
  makeApiProvider: (cfg) => ({ complete: () => Effect.succeed(over.api(cfg.model)) }),
  makeGithub: (() => ({
    createMilestone: (title: string) => {
      over.gh.milestones.push({ title });
      return Effect.succeed({ number: 99, url: "https://github.com/acme/widgets/milestone/99" });
    },
    createIssue: (title: string, _body: string, opts?: { milestone?: number }) => {
      over.gh.issues.push({ title, opts });
      const n = over.gh.issues.length;
      return Effect.succeed({ number: n, url: `https://github.com/acme/widgets/issues/${n}` });
    },
  })) as unknown as ResearchDeps["makeGithub"],
  taskSourceFor: (sourceId) =>
    sourceId === "trello"
      ? ({
          comment: (_id: string, body: string) => {
            over.ts.comments.push(body);
            return Effect.succeed(undefined);
          },
          attachArtifact: (_id: string, art: { filename: string; content: string }) => {
            over.ts.attachments.push({ filename: art.filename, content: art.content });
            return Effect.succeed(undefined);
          },
          moveTo: (id: string, state: string) => {
            over.ts.moves.push({ id, state });
            return Effect.succeed(undefined);
          },
        } as unknown as TaskSource)
      : undefined,
});

const event: TriggerEvent = {
  type: "task_source",
  payload: { source_id: "trello", task_id: "card1", repo: "acme-widgets", title: "Pesquisar X", description: "Descrição do card", night_id: "n1" },
} as TriggerEvent;

const dummyProvider = { complete: () => Effect.succeed(resp("{}", "mock")) };

describe("card-research E2E (#161)", () => {
  it("4 phases traverse: survey (>=2 alts) -> parecer -> milestone + 4 issues -> card comment + .md attachment -> Review (criterion 1)", async () => {
    const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-research/skill.yaml", "utf-8"));
    const gh: GhRec = { milestones: [], issues: [] };
    const ts: TsRec = { comments: [], attachments: [], moves: [] };
    const deps = makeDeps({
      gh,
      ts,
      cli: () => resp(survey(4), SONNET_MODEL),
      api: (model) => resp(aprovado, model),
      worktreeBase: `/tmp/or-pesquisa-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });

    const scriptRegistry = makeScriptRegistry();
    registerResearchHandlers(scriptRegistry, deps);
    const repo = makeRepo();

    const r = await Effect.runPromise(
      runStateMachine({ provider: dummyProvider, repository: repo.repo, scriptRegistry })(skill, routine, event, "exec1")
    );

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");

    const ctx = repo.lastContext()!;
    const lev = ctx.outputs.survey_proposal as { options: unknown[] };
    expect(lev.options.length).toBeGreaterThanOrEqual(2);
    const jul = ctx.outputs.architecture_judgment as { verdict: string; securityOpinion: unknown };
    expect(jul.verdict).toBe("aprovado");
    expect(jul.securityOpinion).toBeDefined();

    // >= 3 phases -> milestone with one issue per phase
    expect(gh.milestones).toHaveLength(1);
    expect(gh.issues).toHaveLength(4);
    expect(gh.issues.every((i) => i.opts?.milestone === 99)).toBe(true);

    // card: summary comment + full .md attachment + move to Review
    expect(ts.comments).toHaveLength(1);
    expect(ts.attachments).toHaveLength(1);
    expect(ts.attachments[0].content).toContain("# Pesquisa: Pesquisar X");
    expect(ts.moves).toContainEqual({ id: "card1", state: "review" });
  });

  it("refutado loops ONE bounded round back to survey (with the corrections) then delivers", async () => {
    const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-research/skill.yaml", "utf-8"));
    const gh: GhRec = { milestones: [], issues: [] };
    const ts: TsRec = { comments: [], attachments: [], moves: [] };

    const surveyPrompts: string[] = [];
    let judgeCalls = 0;
    const deps = makeDeps({
      gh,
      ts,
      cli: (req) => {
        surveyPrompts.push(req.messages![0].content);
        return resp(survey(2), SONNET_MODEL);
      },
      api: (model) => {
        judgeCalls++;
        // 1st judgment refutado (with a correction), 2nd aprovado.
        const body =
          judgeCalls === 1
            ? JSON.stringify({ verdict: "refutado", corrections: ["use índice único"], securityOpinion: { exposesNewSurface: false, notes: "" } })
            : aprovado;
        return resp(body, model);
      },
      worktreeBase: `/tmp/or-pesquisa-e2e-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });

    const scriptRegistry = makeScriptRegistry();
    registerResearchHandlers(scriptRegistry, deps);
    const repo = makeRepo();

    const r = await Effect.runPromise(
      runStateMachine({ provider: dummyProvider, repository: repo.repo, scriptRegistry })(skill, routine, event, "exec1")
    );

    expect(r.success).toBe(true);
    // re-surveyed once after the refutado verdict, and the 2nd survey saw the corrections
    expect(surveyPrompts).toHaveLength(2);
    expect(surveyPrompts[1]).toContain("CORREÇÕES DO JUÍZO ANTERIOR");
    expect(surveyPrompts[1]).toContain("use índice único");
    expect(judgeCalls).toBe(2);
    // then delivered on the aprovado re-judgment
    expect(ts.moves).toContainEqual({ id: "card1", state: "review" });
    expect(gh.issues.length).toBeGreaterThanOrEqual(1);
  });
});
