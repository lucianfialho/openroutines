/**
 * card-mapeamento E2E (F5 #162): drives the REAL skill.yaml through
 * runStateMachine with the 5 script handlers registered and every external
 * effect (git worktree, Sonnet survey, Kimi capture, compose, GitHub, Trello)
 * mocked/injected — mirrors card-pesquisa/e2e.test.ts's harness.
 *
 * Covers the acceptance criteria: no-front-end repo skips captura_visual and
 * ships a docs-only PR; a front-end repo boots compose and captures screenshots;
 * a validacao reprovado loops ONE round back to varredura before the PR opens.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { Effect } from "effect";
import { runStateMachine, type StateMachineContext } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import { registerMapeamentoHandlers } from "./index.js";
import type { MapeamentoDeps } from "./index.js";
import { today } from "./preparacao.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import type { CompletionResponse } from "../../provider/types.js";
import type { Routine } from "../../routine/types.js";
import type { TriggerEvent } from "../../routine/matcher.js";
import type { ExecutionRecord } from "../../persistence/types.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { TaskSource } from "../../task-source/types.js";
import type { ComposeHandle } from "../../orchestrator/compose-lifecycle.js";

const routine: Routine = { id: "r", triggers: [{ type: "task_source" }], pipeline: { skill: "card-mapeamento" } } as Routine;
const registry: RepoRegistry = {
  repos: { "acme-widgets": { clonePath: "/tmp/or-map-clone", githubRepo: "acme/widgets", baseBranch: "development", verify: { build: "true", test: "true" } } },
};

const resp = (content: string, model = "claude-sonnet-5"): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model,
  finishReason: "stop",
});

const profileJson = (comandos: string, goldenRoutes: string[]) =>
  JSON.stringify({
    profile: { "Tese de arquitetura": "**X**", "Arquivos-chave": "`src/x.ts`", "Comandos canônicos": comandos },
    coreSectionsComplete: true,
    goldenRoutes,
  });

// git log with 3 distinct change-shapes so mining has something real to do.
const GIT_LOG = `${"a".repeat(40)}\nsrc/routes/x.ts\n\n${"b".repeat(40)}\nprisma/migrations/1/migration.sql\n\n${"c".repeat(40)}\nsrc/components/Y.tsx\n`;

const makeRepoStore = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", { id: "exec1", routineId: "r", triggerType: "task_source", skillName: "card-mapeamento", status: "pending", startedAt: new Date() });
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

interface Harness {
  composeUps: number;
  prCreated: number;
  moves: Array<{ id: string; state: string }>;
  surveyCalls: number;
}

const makeDeps = (h: Harness, cli: (call: number) => string): MapeamentoDeps =>
  ({
    registry,
    githubToken: "gh",
    worktreeBase: WT_BASE,
    ledger: makeInMemoryActionLedgerRepository(),
    taskSourceFor: () =>
      ({
        moveTo: (id: string, state: string) => {
          h.moves.push({ id, state });
          return Effect.succeed(undefined);
        },
        comment: () => Effect.succeed(undefined),
      }) as unknown as TaskSource,
    makeCliProvider: () => ({
      complete: () => {
        h.surveyCalls += 1;
        return Effect.succeed(resp(cli(h.surveyCalls)));
      },
    }),
    makeGithub: (() => ({
      getOpenPrByBranch: () => Effect.succeed(undefined),
      createPullRequest: (branch: string) => {
        h.prCreated += 1;
        return Effect.succeed({ pr: { url: "https://github.com/acme/widgets/pull/9", number: 9, branch } });
      },
    })) as unknown as MapeamentoDeps["makeGithub"],
    runGit: async (args: string[]) => {
      if (args[0] === "log") return { stdout: GIT_LOG, stderr: "" };
      if (args[0] === "rev-parse") return { stdout: "base0\n", stderr: "" };
      if (args[0] === "diff" && args[1] === "--cached") return { stdout: "docs/REPO-PROFILE.md", stderr: "" };
      if (args[0] === "diff" && args[1] === "--name-only") return { stdout: "docs/REPO-PROFILE.md", stderr: "" };
      return { stdout: "", stderr: "" }; // fetch / worktree add / add / commit / push
    },
    visual: {
      agentProvider: {
        complete: () => Effect.succeed(resp(JSON.stringify({ screenshots: ["docs/visual/01-login.png"], readmeWritten: true }), "kimi")),
      },
      composeUp: async (): Promise<ComposeHandle> => {
        h.composeUps += 1;
        return { baseUrl: "http://127.0.0.1:4000", project: "or-exec1" };
      },
      composeDown: async () => undefined,
    },
    // Deterministic probes: file exists, `test` script present (build absent) —
    // lets a "npm run build" command fail validacao and "npm test" pass it.
    validacao: {
      fileExists: () => true,
      readScripts: () => ({ test: "vitest" }),
      readMakeTargets: () => new Set(),
    },
  }) as unknown as MapeamentoDeps;

const WT_BASE = join("/tmp", `or-map-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const event: TriggerEvent = {
  type: "task_source",
  payload: { source_id: "trello", task_id: "card1", repo: "acme-widgets", title: "Mapear acme", description: "d", night_id: "n1" },
} as TriggerEvent;
const dummyProvider = { complete: () => Effect.succeed(resp("{}", "mock")) };

const drive = async (deps: MapeamentoDeps) => {
  const skill = parseSkillStateMachine(readFileSync(".gates/skills/card-mapeamento/skill.yaml", "utf-8"));
  const scriptRegistry = makeScriptRegistry();
  registerMapeamentoHandlers(scriptRegistry, deps);
  const store = makeRepoStore();
  const r = await Effect.runPromise(
    runStateMachine({ provider: dummyProvider, repository: store.repo, scriptRegistry })(skill, routine, event, "exec1")
  );
  return { r, ctx: store.lastContext()! };
};

const createdWorktrees: string[] = [];
afterEach(() => {
  for (const wt of createdWorktrees.splice(0)) rmSync(wt, { recursive: true, force: true });
});

describe("card-mapeamento E2E (#162)", () => {
  it("criterion 1: no front-end repo skips captura_visual and ships a docs-only PR", async () => {
    const h: Harness = { composeUps: 0, prCreated: 0, moves: [], surveyCalls: 0 };
    // Worktree dir NOT created -> package.json unreadable -> hasFrontend=false.
    const { r, ctx } = await drive(makeDeps(h, () => profileJson("npm test", [])));

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    expect(h.composeUps).toBe(0); // captura_visual never ran
    expect((ctx.outputs.captura_visual as unknown)).toBeUndefined();
    const pr = ctx.outputs.pr_docs as { prUrl: string; changedFiles: string[] };
    expect(pr.changedFiles.every((f) => f.startsWith("docs/"))).toBe(true);
    expect(h.prCreated).toBe(1);
    expect(h.moves).toContainEqual({ id: "card1", state: "review" });
    // exemplars were mined from the git log (>=2 distinct shapes)
    const varredura = ctx.outputs.varredura as { exemplars: Array<{ changeShape: string }>; hasFrontend: boolean };
    expect(varredura.hasFrontend).toBe(false);
    expect(new Set(varredura.exemplars.map((e) => e.changeShape)).size).toBeGreaterThanOrEqual(2);
  });

  it("criterion 2: front-end repo boots compose and captures >=1 screenshot per route", async () => {
    const h: Harness = { composeUps: 0, prCreated: 0, moves: [], surveyCalls: 0 };
    // Pre-create the worktree with a front-end package.json so varredura detects it.
    const wt = join(WT_BASE, `mapeamento-acme-widgets-${today()}`);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "package.json"), JSON.stringify({ dependencies: { next: "14" } }));
    createdWorktrees.push(wt);

    const { r, ctx } = await drive(makeDeps(h, () => profileJson("npm test", ["/login"])));

    expect(r.success).toBe(true);
    expect(h.composeUps).toBe(1); // captura_visual ran (compose booted)
    const captura = ctx.outputs.captura_visual as { screenshots: string[]; readmeWritten: boolean };
    expect(captura.readmeWritten).toBe(true);
    expect(captura.screenshots.length).toBeGreaterThanOrEqual(1);
    expect(h.prCreated).toBe(1);
  });

  it("criterion 3: a validacao reprovado loops ONE round back to varredura, then the PR opens", async () => {
    const h: Harness = { composeUps: 0, prCreated: 0, moves: [], surveyCalls: 0 };
    // 1st survey lists an absent script (npm run build) -> validacao reproves;
    // 2nd survey lists npm test (present) -> validacao passes.
    const { r, ctx } = await drive(
      makeDeps(h, (call) => (call === 1 ? profileJson("npm run build", []) : profileJson("npm test", [])))
    );

    expect(r.success).toBe(true);
    expect(h.surveyCalls).toBe(2); // varredura ran twice (original + one retry)
    const validacao = ctx.outputs.validacao as { passed: boolean };
    expect(validacao.passed).toBe(true); // PR only opens after a pass
    expect(h.prCreated).toBe(1);
    expect(h.moves).toContainEqual({ id: "card1", state: "review" });
  });
});
