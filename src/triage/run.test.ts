/**
 * runTriageCycle tests (F5 #170): fake TaskSource + fake CLI provider + a mock
 * pool (same shape as night-coordinator/run.test.ts). Covers the classify ->
 * classify-blank-only -> comment -> stamp path, the unchanged-fingerprint skip,
 * re-triage on edit, the !ready block ordering, the comment-failure/no-stamp
 * rule, budget denial, the per-tick cap, and alias repo resolution.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { randomUUID } from "crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runTriageCycle, type TriageDeps, type TriageProvider } from "./run.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { CompletionRequest, CompletionResponse } from "../provider/types.js";
import { TaskSourceError, type Task, type TaskClassification, type TaskSource } from "../task-source/types.js";

const registry: RepoRegistry = {
  repos: {
    // clonePath deliberately absent from disk -> useTools=false in most tests.
    "acme-widgets": { clonePath: "/tmp/or-triage-absent-acme", githubRepo: "acme/widgets", baseBranch: "development", verify: { build: "true", test: "true" } },
    detectwater: { clonePath: "/tmp/or-triage-absent-dw", githubRepo: "acme/dw", baseBranch: "development", verify: { build: "true", test: "true" }, labels: ["Detect Water"] },
  },
};

const cardWithRepo = (slug: string): string => `# Conceito\nfazer algo\n\n## Repositório\n${slug}\n`;

const makeTask = (over: Partial<Task> = {}): Task => ({
  sourceId: "trello-main",
  id: "card1",
  title: "Título do card",
  body: cardWithRepo("acme-widgets"),
  url: "https://trello/card1",
  state: "queued",
  type: "implementation",
  labels: [],
  assignees: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const readyVerdict = {
  tipo: "implementation",
  complexidade: "low",
  prioridade: "high",
  pronto: true,
  interpretacao: "O card pede X.",
  criteriosAceite: ["X funciona"],
  perguntas: [],
  riscos: [],
};

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "claude-sonnet-5",
  finishReason: "stop",
});

const makeFakeProvider = (verdict: object) => {
  const requests: CompletionRequest[] = [];
  const make = (_cfg: { model: string }): TriageProvider => ({
    complete: (req) => {
      requests.push(req);
      return Effect.succeed(resp(JSON.stringify(verdict)));
    },
  });
  return { make, requests };
};

const makeFakeSource = (tasks: Task[], events: string[], opts: { failComment?: boolean } = {}) => {
  const comment = vi.fn((_id: string, _body: string) => {
    events.push("comment");
    return opts.failComment ? Effect.fail(new TaskSourceError("comment boom", "comment")) : Effect.succeed(undefined);
  });
  const moveTo = vi.fn((_id: string, state: string) => {
    events.push(`moveTo:${state}`);
    return Effect.succeed(undefined);
  });
  const setClassification = vi.fn((_id: string, _c: TaskClassification) => {
    events.push("setClassification");
    return Effect.succeed(undefined);
  });
  const source = {
    listQueue: () => Effect.succeed(tasks),
    getTask: (id: string) => Effect.succeed(tasks.find((t) => t.id === id)!),
    comment,
    attachArtifact: () => Effect.succeed(undefined),
    moveTo,
    setClassification,
    watchNew: () => Effect.succeed({ tasks: [], cursor: "" }),
  } as unknown as TaskSource;
  return { source, comment, moveTo, setClassification };
};

const makeMockPool = (events: string[], opts: { budgetUsed?: number; seed?: Record<string, string>; claimQueued?: boolean } = {}) => {
  const stored: Record<string, string> = { ...(opts.seed ?? {}) };
  const executionInserts: unknown[][] = [];
  const executionSettles: unknown[][] = [];
  const stateBlocks: unknown[][] = [];
  const stamps: unknown[][] = [];
  const budgetInserts: unknown[][] = [];
  const workingClaims: unknown[][] = [];

  const run = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT triage_fingerprint FROM tasks")) {
      const [s, t] = params as [string, string];
      return { rows: [{ triage_fingerprint: stored[`${s}:${t}`] ?? null }] };
    }
    if (text.startsWith("INSERT INTO executions")) {
      executionInserts.push(params);
      return { rows: [] };
    }
    if (text.startsWith("UPDATE executions SET status")) {
      executionSettles.push(params);
      return { rows: [] };
    }
    if (text.startsWith("UPDATE tasks SET state = 'blocked'")) {
      events.push("db:state-blocked");
      stateBlocks.push(params);
      return { rows: [] };
    }
    // Day-research atomic claim: RETURNING a row iff the card was still 'queued'.
    if (text.startsWith("UPDATE tasks SET state = 'working'")) {
      events.push("db:state-working");
      workingClaims.push(params);
      return { rows: opts.claimQueued === false ? [] : [{ task_id: (params as string[])[1] }] };
    }
    if (text.startsWith("UPDATE tasks SET triaged_at")) {
      events.push("db:stamp");
      const [s, t, fp] = params as [string, string, string];
      stored[`${s}:${t}`] = fp;
      stamps.push(params);
      return { rows: [] };
    }
    // reserveDayBudget (pooled client) queries:
    if (text.startsWith("SELECT COALESCE(SUM")) return { rows: [{ used: opts.budgetUsed ?? 0 }] };
    if (text.startsWith("INSERT INTO budget_reservations")) {
      budgetInserts.push(params);
      return { rows: [{ id: "resv" }] };
    }
    return { rows: [] }; // BEGIN / COMMIT / ROLLBACK / advisory lock
  };

  const client = { query: run, release: () => {} };
  return {
    pool: { query: run, connect: async () => client } as unknown as TriageDeps["pool"],
    executionInserts,
    executionSettles,
    stateBlocks,
    stamps,
    budgetInserts,
    workingClaims,
  };
};

/** Capturing job queue for the same-day research dispatch. */
const makeQueue = () => {
  const jobs: Array<{ id: string; routineId?: string; trigger: { type: string; payload: unknown; executionId?: string } }> = [];
  return { queue: { enqueue: vi.fn(async (job) => { jobs.push(job); }) } as unknown as TriageDeps["queue"], jobs };
};

const baseDeps = (pool: TriageDeps["pool"], source: TaskSource, makeCliProvider: TriageDeps["makeCliProvider"], over: Partial<TriageDeps> = {}): TriageDeps => ({
  pool,
  sources: ["trello-main"],
  taskSourceFor: (id) => (id === "trello-main" ? source : undefined),
  taskRepo: { save: vi.fn(async () => {}), findByKey: async () => undefined, findBySource: async () => [] } as unknown as TriageDeps["taskRepo"],
  registry,
  excludeLabels: ["OpenRoutines"],
  dayBudgetUsd: 10,
  queue: { enqueue: vi.fn(async () => {}) } as unknown as TriageDeps["queue"],
  makeCliProvider,
  sendAlert: vi.fn(async () => {}),
  generateId: () => randomUUID(),
  ...over,
});

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("runTriageCycle", () => {
  it("classifies a new card: LLM once, only-blank classification, comment, stamp, stays queued", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    // priority PRE-SET (medium) -> triage must NOT overwrite it; complexity blank
    // -> filled; type is the implementation default and the LLM disagrees (mapping)
    // -> filled. mapping (not research) keeps this a pure classification test —
    // same-day dispatch fires only for research cards.
    const task = makeTask({ priority: "medium", complexity: undefined, type: "implementation" });
    const { source, comment, moveTo, setClassification } = makeFakeSource([task], events);
    const prov = makeFakeProvider({ ...readyVerdict, tipo: "mapping" });
    const deps = baseDeps(mock.pool, source, prov.make);

    const summary = await runTriageCycle(deps);

    expect(prov.requests).toHaveLength(1);
    expect(prov.requests[0].allowedTools).toBeUndefined(); // clone not on disk -> no tools/workdir
    expect(prov.requests[0].workdir).toBeUndefined();
    expect(setClassification).toHaveBeenCalledTimes(1);
    expect(setClassification.mock.calls[0][1]).toEqual({ complexity: "low", type: "mapping" }); // priority skipped
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0][1]).toContain("✅ Pronto para execução noturna");
    expect(comment.mock.calls[0][1]).toContain("**Repositório:** acme-widgets");
    expect(moveTo).not.toHaveBeenCalled(); // ready mapping -> stays queued, not dispatched
    expect(mock.stateBlocks).toHaveLength(0);
    expect(mock.stamps).toHaveLength(1);
    expect(mock.executionInserts).toHaveLength(1);
    expect(mock.executionSettles).toHaveLength(1);
    expect(mock.executionSettles[0][1]).toBe("completed");
    expect(summary).toEqual({ scanned: 1, skippedUnchanged: 0, triaged: 1, readyCount: 1, blockedNotReady: 0, budgetDenied: 0, researchDispatched: 0 });
  });

  it("skips an unchanged card on the next tick without calling the LLM", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    const task = makeTask();
    const { source, comment } = makeFakeSource([task], events);
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make);

    const first = await runTriageCycle(deps); // stamps the fingerprint
    const second = await runTriageCycle(deps); // identical card -> skip

    expect(first.triaged).toBe(1);
    expect(prov.requests).toHaveLength(1); // NOT called the second time
    expect(comment).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ scanned: 1, skippedUnchanged: 1, triaged: 0 });
  });

  it("re-triages a card whose body was edited (fingerprint changed)", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    const task = makeTask();
    const { source } = makeFakeSource([task], events);
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make);

    await runTriageCycle(deps);
    task.body = `${task.body}\n\n## Objetivo\nagora com mais contexto`; // human edits the card
    const second = await runTriageCycle(deps);

    expect(prov.requests).toHaveLength(2);
    expect(second).toMatchObject({ skippedUnchanged: 0, triaged: 1 });
    expect(mock.stamps).toHaveLength(2);
  });

  it("an unready card is commented, moved to Blocked, then the DB row flips (order verified)", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    const { source, comment, moveTo } = makeFakeSource([makeTask()], events);
    const prov = makeFakeProvider({ ...readyVerdict, pronto: false, motivoNaoPronto: "Falta detalhar o objetivo." });
    const deps = baseDeps(mock.pool, source, prov.make);

    const summary = await runTriageCycle(deps);

    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0][1]).toContain("⚠️ Precisa de ajustes");
    expect(comment.mock.calls[0][1]).toContain("Falta detalhar o objetivo.");
    expect(comment.mock.calls[0][1]).toContain("Para destravar:");
    expect(moveTo).toHaveBeenCalledWith("card1", "blocked");
    expect(mock.stateBlocks).toHaveLength(1);
    // moveTo BEFORE the DB flip BEFORE the stamp — the blockUnresolvableCard order.
    expect(events).toEqual(["setClassification", "comment", "moveTo:blocked", "db:state-blocked", "db:stamp"]);
    expect(summary).toMatchObject({ triaged: 1, readyCount: 0, blockedNotReady: 1 });
  });

  it("a failed Trello comment does NOT stamp the card (retries next tick) and settles the execution 'failed'", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    const { source } = makeFakeSource([makeTask()], events, { failComment: true });
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make);

    const summary = await runTriageCycle(deps);

    expect(mock.stamps).toHaveLength(0); // never stamped
    expect(mock.executionSettles[0][1]).toBe("failed");
    expect(summary).toMatchObject({ scanned: 1, triaged: 0, readyCount: 0 });
  });

  it("denied day budget: no LLM, no stamp, no reservation — card deferred to next tick", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events, { budgetUsed: 10 }); // 10 used + 1 > 10 cap -> denied
    const { source, comment } = makeFakeSource([makeTask()], events);
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make);

    const summary = await runTriageCycle(deps);

    expect(prov.requests).toHaveLength(0); // budget checked BEFORE the LLM
    expect(comment).not.toHaveBeenCalled();
    expect(mock.stamps).toHaveLength(0);
    expect(mock.budgetInserts).toHaveLength(0); // reservation rolled back
    expect(mock.executionInserts).toHaveLength(1);
    expect(mock.executionSettles[0][1]).toBe("completed"); // denial is not a failure
    expect(summary).toMatchObject({ scanned: 1, budgetDenied: 1, triaged: 0 });
  });

  it("respects maxPerTick across the scan (unchanged cards don't count)", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    const tasks = [makeTask({ id: "card1" }), makeTask({ id: "card2" }), makeTask({ id: "card3" })];
    const { source, comment } = makeFakeSource(tasks, events);
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make, { maxPerTick: 2 });

    const summary = await runTriageCycle(deps);

    expect(prov.requests).toHaveLength(2); // only 2 classified
    expect(comment).toHaveBeenCalledTimes(2);
    expect(mock.stamps).toHaveLength(2);
    expect(summary).toMatchObject({ scanned: 3, triaged: 2, skippedUnchanged: 0, budgetDenied: 0 }); // 1 deferred
  });

  it("resolves the repo from a project-label alias (excludeLabels drops the flag)", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    // No "## Repositório" field: routing falls back to labels. The flag comes
    // first and must be ignored; the alias "Detect Water" routes to detectwater.
    const task = makeTask({ body: "# Conceito\nsem campo de repo\n", labels: ["OpenRoutines", "Detect Water"] });
    const { source, comment, moveTo } = makeFakeSource([task], events);
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make);

    const summary = await runTriageCycle(deps);

    expect(comment.mock.calls[0][1]).toContain("**Repositório:** detectwater");
    expect(moveTo).not.toHaveBeenCalled(); // resolved + ready -> queued
    expect(summary).toMatchObject({ triaged: 1, readyCount: 1 });
  });

  it("grants Read/Glob/Grep + workdir when the clone is on disk, and suggests Mapping when it has no REPO-PROFILE", async () => {
    const clone = mkdtempSync(join(tmpdir(), "or-triage-clone-"));
    tmpDirs.push(clone);
    const events: string[] = [];
    const mock = makeMockPool(events);
    const reg: RepoRegistry = { repos: { tmprepo: { clonePath: clone, githubRepo: "acme/tmp", baseBranch: "development", verify: { build: "true", test: "true" } } } };
    const { source, comment } = makeFakeSource([makeTask({ body: cardWithRepo("tmprepo") })], events);
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make, { registry: reg });

    await runTriageCycle(deps);

    expect(prov.requests[0].allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(prov.requests[0].workdir).toBe(clone);
    expect(comment.mock.calls[0][1]).toContain("não tem docs/REPO-PROFILE.md");
  });

  it("feeds docs/REPO-PROFILE.md into the prompt and omits the Mapping suggestion when it exists", async () => {
    const clone = mkdtempSync(join(tmpdir(), "or-triage-clone-"));
    tmpDirs.push(clone);
    mkdirSync(join(clone, "docs"));
    writeFileSync(join(clone, "docs", "REPO-PROFILE.md"), "# Perfil\nStack: TypeScript + Express.");
    const events: string[] = [];
    const mock = makeMockPool(events);
    const reg: RepoRegistry = { repos: { tmprepo: { clonePath: clone, githubRepo: "acme/tmp", baseBranch: "development", verify: { build: "true", test: "true" } } } };
    const { source, comment } = makeFakeSource([makeTask({ body: cardWithRepo("tmprepo") })], events);
    const prov = makeFakeProvider(readyVerdict);
    const deps = baseDeps(mock.pool, source, prov.make, { registry: reg });

    await runTriageCycle(deps);

    expect(prov.requests[0].messages![0].content).toContain("Stack: TypeScript + Express.");
    expect(comment.mock.calls[0][1]).not.toContain("não tem docs/REPO-PROFILE.md");
  });

  it("one source's scan failure is logged + alerted, never aborting the others", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    const failing = { listQueue: () => Effect.fail(new TaskSourceError("coluna 'Fila' sumiu", "listQueue")) } as unknown as TaskSource;
    const { source: good, comment } = makeFakeSource([makeTask()], events);
    const prov = makeFakeProvider(readyVerdict);
    const sendAlert = vi.fn(async () => {});
    const deps = baseDeps(mock.pool, good, prov.make, {
      sources: ["broken", "trello-main"],
      taskSourceFor: (id) => (id === "broken" ? failing : id === "trello-main" ? good : undefined),
      sendAlert,
    });

    const summary = await runTriageCycle(deps);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledTimes(1); // the healthy source still triaged
    expect(summary).toMatchObject({ scanned: 1, triaged: 1 });
  });

  it("does not overwrite classification fields the human already set, and skips setClassification when nothing is blank", async () => {
    const events: string[] = [];
    const mock = makeMockPool(events);
    const task = makeTask({ type: "research", complexity: "high", priority: "low" }); // all set
    const { source, setClassification } = makeFakeSource([task], events);
    const prov = makeFakeProvider({ ...readyVerdict, tipo: "implementation", complexidade: "low", prioridade: "high" });
    const deps = baseDeps(mock.pool, source, prov.make);

    await runTriageCycle(deps);

    expect(setClassification).not.toHaveBeenCalled(); // nothing blank -> no call
  });

  describe("same-day research dispatch (#170, step i)", () => {
    it("dispatches a ready research card <= Medium: reserves budget, claims 'working', enqueues card-research (no night_id)", async () => {
      const events: string[] = [];
      const mock = makeMockPool(events); // budgetUsed 0 -> both the triage and research reservations grant
      const { queue, jobs } = makeQueue();
      const task = makeTask({ type: "research", complexity: undefined }); // human typed research; complexity blank
      const { source, moveTo } = makeFakeSource([task], events);
      const prov = makeFakeProvider({ ...readyVerdict, tipo: "research", complexidade: "low" });
      let n = 0;
      const deps = baseDeps(mock.pool, source, prov.make, { queue, generateId: () => `exec-${++n}` });

      const summary = await runTriageCycle(deps);

      expect(summary.researchDispatched).toBe(1);
      expect(summary.readyCount).toBe(1);
      // Claimed out of 'queued' AND moved off the board queue (so a later sync
      // can't clobber the claim and the night can't re-claim it).
      expect(mock.workingClaims).toHaveLength(1);
      expect(moveTo).toHaveBeenCalledWith("card1", "working");
      // Exactly one card-research job, mirroring the night payload minus night_id/tier.
      expect(jobs).toHaveLength(1);
      expect(jobs[0].trigger.type).toBe("card-execution");
      const payload = jobs[0].trigger.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        skill: "card-research",
        complexity: "low",
        source_id: "trello-main",
        task_id: "card1",
        repo: "acme-widgets",
      });
      expect(payload.night_id).toBeUndefined();
      expect(payload.tier).toBeUndefined();
      // Two executions rows (triage + the research run) and two day reservations (1 + 4 units).
      expect(mock.executionInserts).toHaveLength(2);
      expect(mock.budgetInserts).toHaveLength(2);
    });

    it("does NOT dispatch a ready research card > Medium — it waits for the night", async () => {
      const events: string[] = [];
      const mock = makeMockPool(events);
      const { queue, jobs } = makeQueue();
      const task = makeTask({ type: "research", complexity: "high" });
      const { source, moveTo } = makeFakeSource([task], events);
      const prov = makeFakeProvider({ ...readyVerdict, tipo: "research", complexidade: "high" });
      const deps = baseDeps(mock.pool, source, prov.make, { queue });

      const summary = await runTriageCycle(deps);

      expect(summary.researchDispatched).toBe(0);
      expect(summary.readyCount).toBe(1);
      expect(jobs).toHaveLength(0);
      expect(moveTo).not.toHaveBeenCalled();
      expect(mock.workingClaims).toHaveLength(0);
      expect(mock.budgetInserts).toHaveLength(1); // only the triage classification reserved
    });

    it("leaves a research card queued when the day budget denies the research reservation (triage still completes)", async () => {
      const events: string[] = [];
      // 7 used: the triage reserve (7+1<=10) grants, the research reserve (7+4>10) is denied.
      const mock = makeMockPool(events, { budgetUsed: 7 });
      const { queue, jobs } = makeQueue();
      const task = makeTask({ type: "research", complexity: "low" });
      const { source, moveTo } = makeFakeSource([task], events);
      const prov = makeFakeProvider({ ...readyVerdict, tipo: "research", complexidade: "low" });
      const deps = baseDeps(mock.pool, source, prov.make, { queue });

      const summary = await runTriageCycle(deps);

      expect(summary.triaged).toBe(1);
      expect(summary.researchDispatched).toBe(0);
      expect(jobs).toHaveLength(0);
      expect(moveTo).not.toHaveBeenCalled(); // no claim — the card stays queued for the night
      expect(mock.workingClaims).toHaveLength(0);
      expect(mock.stamps).toHaveLength(1); // the card WAS triaged
      expect(mock.budgetInserts).toHaveLength(1); // research reservation rolled back
      expect(mock.executionSettles[0][1]).toBe("completed"); // a dispatch denial is not a triage failure
    });

    it("a non-ready research card is Blocked, never dispatched", async () => {
      const events: string[] = [];
      const mock = makeMockPool(events);
      const { queue, jobs } = makeQueue();
      const task = makeTask({ type: "research", complexity: "low" });
      const { source, moveTo } = makeFakeSource([task], events);
      const prov = makeFakeProvider({ ...readyVerdict, tipo: "research", complexidade: "low", pronto: false, motivoNaoPronto: "Falta escopo." });
      const deps = baseDeps(mock.pool, source, prov.make, { queue });

      const summary = await runTriageCycle(deps);

      expect(summary.blockedNotReady).toBe(1);
      expect(summary.researchDispatched).toBe(0);
      expect(moveTo).toHaveBeenCalledWith("card1", "blocked");
      expect(moveTo).not.toHaveBeenCalledWith("card1", "working");
      expect(jobs).toHaveLength(0);
      expect(mock.budgetInserts).toHaveLength(1); // triage only — dispatch never runs for a !ready card
    });
  });
});
