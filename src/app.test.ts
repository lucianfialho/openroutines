import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Effect } from "effect";
import {
  makeRequireAuth,
  checkHealth,
  createApp,
  resolveCardToPrDynamicProvider,
  runCardExecutionJob,
  type CardExecutionJobDeps,
} from "./app.js";
import { makeInMemoryRepository } from "./persistence/in-memory.js";
import { makeInMemoryPrLinkRepository } from "./persistence/pr-links-in-memory.js";
import type { DynamicProviderContext, StateMachineConfig } from "./engine/state-machine.js";
import type { SkillStateMachine } from "./skill/schema.js";

// ── #187: auth middleware ────────────────────────────────────────────────────

const mockReq = (headers: Record<string, string>) =>
  ({ header: (n: string) => headers[n] }) as any;

const mockRes = () => {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
};

describe("makeRequireAuth", () => {
  const TOKEN = "s3cr3t-token";

  it("401s with no credentials", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(TOKEN)(mockReq({}), res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("allows a valid bearer token", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(TOKEN)(mockReq({ Authorization: `Bearer ${TOKEN}` }), res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it("401s on a wrong bearer token", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(TOKEN)(mockReq({ Authorization: "Bearer wrong" }), res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("allows a non-empty Tailscale identity header", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(undefined)(mockReq({ "Tailscale-User-Login": "op@example.com" }), res, () => { nexted = true; });
    expect(nexted).toBe(true);
  });

  it("401s when no token is configured and no Tailscale header (fail closed)", () => {
    const res = mockRes();
    let nexted = false;
    makeRequireAuth(undefined)(mockReq({ Authorization: "Bearer anything" }), res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

// ── #131: detailed health ────────────────────────────────────────────────────

describe("checkHealth", () => {
  it("reports in-memory when no probes are provided", async () => {
    const { checks, healthy } = await checkHealth({ cronOk: true });
    expect(checks).toEqual({ postgres: "in-memory", redis: "in-memory", cron: "ok" });
    expect(healthy).toBe(true);
  });

  it("reports ok when probes resolve", async () => {
    const { checks, healthy } = await checkHealth({
      pg: async () => undefined,
      redis: async () => undefined,
      cronOk: true,
    });
    expect(checks).toEqual({ postgres: "ok", redis: "ok", cron: "ok" });
    expect(healthy).toBe(true);
  });

  it("marks postgres error and degrades when the pg probe rejects", async () => {
    const { checks, healthy } = await checkHealth({
      pg: async () => { throw new Error("down"); },
      redis: async () => undefined,
      cronOk: true,
    });
    expect(checks.postgres).toBe("error");
    expect(healthy).toBe(false);
  });

  it("marks redis error and degrades when the redis probe rejects", async () => {
    const { checks, healthy } = await checkHealth({
      redis: async () => { throw new Error("down"); },
      cronOk: true,
    });
    expect(checks.redis).toBe("error");
    expect(healthy).toBe(false);
  });

  it("degrades when cron is not ok", async () => {
    const { healthy, checks } = await checkHealth({ cronOk: false });
    expect(checks.cron).toBe("error");
    expect(healthy).toBe(false);
  });
});

// ── #189: legacy tools gated off by default ─────────────────────────────────

describe("createApp — legacy tool gating", () => {
  const created: Array<{ stop: () => void }> = [];
  afterEach(() => {
    for (const c of created) c.stop();
    created.length = 0;
    delete process.env.OPENROUTINES_LEGACY_TOOLS;
  });

  const emptyConfig = () => {
    const dir = mkdtempSync(join(tmpdir(), "or-app-"));
    return { dir, config: { routinesDir: dir, skillsDir: dir, port: 0 } };
  };

  it("does NOT register run_shell without OPENROUTINES_LEGACY_TOOLS", async () => {
    const { dir, config } = emptyConfig();
    try {
      const app = await createApp(config);
      created.push(app.cronScheduler);
      expect(app.toolRegistry.has("run_shell")).toBe(false);
      expect(app.toolRegistry.has("git_create_worktree")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers run_shell when OPENROUTINES_LEGACY_TOOLS=1", async () => {
    process.env.OPENROUTINES_LEGACY_TOOLS = "1";
    const { dir, config } = emptyConfig();
    try {
      const app = await createApp(config);
      created.push(app.cronScheduler);
      expect(app.toolRegistry.has("run_shell")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── H9c: payload.tier (F4 #159 night-level circuit breaker escalation) ─────

describe("resolveCardToPrDynamicProvider — H9c", () => {
  const baseCtx = (overrides: Partial<DynamicProviderContext> = {}): DynamicProviderContext => ({
    stateId: "implementation",
    state: {} as DynamicProviderContext["state"],
    inputs: {},
    outputs: {},
    transitionCounts: {},
    escalated: false,
    ...overrides,
  });

  it("payload.tier='opus' with complexity 'low' (derives to kimi) routes to opus", () => {
    const route = resolveCardToPrDynamicProvider(baseCtx({ inputs: { complexity: "low", tier: "opus" } }));
    expect(route).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("payload.tier='kimi' with complexity 'highest' (derives to opus) keeps opus — never downgrades", () => {
    const route = resolveCardToPrDynamicProvider(baseCtx({ inputs: { complexity: "highest", tier: "kimi" } }));
    expect(route).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("no payload.tier: derives normally from complexity (unaffected)", () => {
    const route = resolveCardToPrDynamicProvider(baseCtx({ inputs: { complexity: "medium" } }));
    expect(route).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("payload.tier equal to the derived tier changes nothing", () => {
    const route = resolveCardToPrDynamicProvider(baseCtx({ inputs: { complexity: "medium", tier: "sonnet" } }));
    expect(route).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("ctx.escalated (retry-cap) still escalates exactly one tier up when payload.tier is absent (unchanged behavior)", () => {
    const route = resolveCardToPrDynamicProvider(baseCtx({ inputs: { complexity: "low" }, escalated: true }));
    expect(route).toMatchObject({ model: "claude-sonnet-5" }); // kimi -> sonnet
  });

  it("ctx.escalated at the opus ceiling still returns undefined (exhaust, not a bogus attempt)", () => {
    const route = resolveCardToPrDynamicProvider(baseCtx({ inputs: { complexity: "highest" }, escalated: true }));
    expect(route).toBeUndefined();
  });

  it("a non-routed state (e.g. plan) is untouched by payload.tier", () => {
    const route = resolveCardToPrDynamicProvider(baseCtx({ stateId: "plan", inputs: { tier: "opus" } }));
    expect(route).toBeUndefined();
  });
});

// ── H7 / H9a / H9b: runCardExecutionJob (extracted from queueHandler) ──────

describe("runCardExecutionJob", () => {
  type FakePool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; queries: Array<{ sql: string; params: unknown[] }> };

  const makeFakePool = (opts: { nightFinishedAt?: Date | null } = {}): FakePool => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    return {
      queries,
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("finished_at FROM night_runs")) {
          return { rows: [{ finished_at: opts.nightFinishedAt ?? null }] };
        }
        return { rows: [] };
      },
    };
  };

  const okResult = { executionId: "exec-1", success: true, output: "", logs: [], startedAt: new Date(), finishedAt: new Date() };

  const makeDeps = (
    overrides: Partial<CardExecutionJobDeps> = {}
  ): { deps: CardExecutionJobDeps; fakeRun: ReturnType<typeof vi.fn> } => {
    const fakeRun = vi.fn(() => () => Effect.succeed(okResult));
    const deps: CardExecutionJobDeps = {
      skills: { "card-to-pr": { config: {} as StateMachineConfig, skill: {} as SkillStateMachine } },
      persistence: makeInMemoryRepository(),
      prLinks: makeInMemoryPrLinkRepository(),
      pgPool: makeFakePool() as unknown as CardExecutionJobDeps["pgPool"],
      nightWindowStart: "01:00",
      nightWindowEnd: "06:30",
      nightTz: "UTC",
      runStateMachine: fakeRun as unknown as CardExecutionJobDeps["runStateMachine"],
      now: () => new Date("2026-01-01T03:00:00Z"), // inside the default 01:00-06:30 window
      ...overrides,
    };
    return { deps, fakeRun };
  };

  const seedExecution = async (
    persistence: CardExecutionJobDeps["persistence"],
    id: string,
    metadata?: Record<string, unknown>,
    nightId?: string
  ) => {
    await persistence.save({
      id,
      routineId: "night-run",
      triggerType: "card-execution",
      skillName: "card-to-pr",
      status: "pending",
      startedAt: new Date(),
      ...(metadata ? { metadata } : {}),
      ...(nightId ? { nightId } : {}),
    });
  };

  describe("H7: a job surviving past its night's window must not run", () => {
    it("delivered OUTSIDE the window: execution failed with blockReason timeout, claim released, runStateMachine NEVER called", async () => {
      const { deps, fakeRun } = makeDeps({ now: () => new Date("2026-01-01T07:00:00Z") }); // past 06:30
      await seedExecution(deps.persistence, "exec-1");
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { night_id: "night-1", source_id: "trello-main", task_id: "card1", tier: "sonnet" },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      const saved = await deps.persistence.findById("exec-1");
      expect(saved?.status).toBe("failed");
      expect(saved?.metadata?.blockReason).toBe("timeout");
      const pool = deps.pgPool as unknown as FakePool;
      expect(pool.queries.some((q) => q.sql.includes("claimed_by_night_id = NULL") && q.params.includes("night-1"))).toBe(true);
      expect(fakeRun).not.toHaveBeenCalled();
    });

    it("delivered inside the window but the night is already finished (finished_at set): also dropped, never run", async () => {
      const { deps, fakeRun } = makeDeps({ pgPool: makeFakePool({ nightFinishedAt: new Date() }) as unknown as CardExecutionJobDeps["pgPool"] });
      await seedExecution(deps.persistence, "exec-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: { night_id: "night-1" } } };

      await runCardExecutionJob(deps, job, undefined);

      const saved = await deps.persistence.findById("exec-1");
      expect(saved?.status).toBe("failed");
      expect(saved?.metadata?.blockReason).toBe("timeout");
      expect(fakeRun).not.toHaveBeenCalled();
    });

    it("delivered WITHIN the window, night still open: runs normally (runStateMachine IS called)", async () => {
      const { deps, fakeRun } = makeDeps();
      await seedExecution(deps.persistence, "exec-1");
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { night_id: "night-1", source_id: "trello-main", task_id: "card1", tier: "sonnet" },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      expect(fakeRun).toHaveBeenCalledTimes(1);
    });

    it("a manual execution (no night_id) is never blocked by the window guard, even outside it", async () => {
      const { deps, fakeRun } = makeDeps({ now: () => new Date("2026-01-01T07:00:00Z") }); // past window
      await seedExecution(deps.persistence, "exec-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: {} } };

      await runCardExecutionJob(deps, job, undefined);

      expect(fakeRun).toHaveBeenCalledTimes(1);
    });

    // H7 bypass fix: boot-reconciliation (and the human-gate/`/resume` paths)
    // ALWAYS re-enqueue an orphaned execution with `payload: {}` — night_id
    // only lives on the persisted execution record. Before the fix, `nightId`
    // read `payload?.night_id` alone, so this exact payload made the guard
    // above see "no night_id" and skip straight to running the full pipeline.
    it("orphaned resume (payload {}, night_id only on the persisted record) delivered OUTSIDE the window: still dropped via the registry fallback", async () => {
      const { deps, fakeRun } = makeDeps({ now: () => new Date("2026-01-01T07:00:00Z") }); // past 06:30
      await seedExecution(deps.persistence, "exec-1", undefined, "night-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: {} } };

      await runCardExecutionJob(deps, job, undefined);

      const saved = await deps.persistence.findById("exec-1");
      expect(saved?.status).toBe("failed");
      expect(saved?.metadata?.blockReason).toBe("timeout");
      expect(fakeRun).not.toHaveBeenCalled();
    });

    it("same orphaned resume (payload {}) delivered WITHIN the window, night still open: runs normally — the fallback never blocks a legitimate resume", async () => {
      const { deps, fakeRun } = makeDeps();
      await seedExecution(deps.persistence, "exec-1", undefined, "night-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: {} } };

      await runCardExecutionJob(deps, job, undefined);

      expect(fakeRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("H9a: rework success is 'the round actually completed', not 'a pr_link exists'", () => {
    it("a rework round whose completion step never ran tonight records FAILURE, even with an existing pr_link and success=true from the machine", async () => {
      const { deps } = makeDeps();
      await seedExecution(deps.persistence, "exec-1");
      await deps.prLinks.create({
        sourceId: "trello-main",
        taskId: "card1",
        repo: "acme-widgets",
        branch: "openroutines/card-card1",
        status: "open",
        lastReworkNightId: "some-previous-night", // last COMPLETED round was NOT tonight
      });
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { source_id: "trello-main", task_id: "card1", night_id: "night-1", tier: "sonnet", rework: true },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      const pool = deps.pgPool as unknown as FakePool;
      const call = pool.queries.find((q) => q.sql.includes("tier_circuit_state"));
      expect(call?.params).toEqual(["night-1", "sonnet", 1]); // failedIncrement=1 -> failure
    });

    it("a rework round completed tonight (lastReworkNightId===night_id) records SUCCESS", async () => {
      const { deps } = makeDeps();
      await seedExecution(deps.persistence, "exec-1");
      await deps.prLinks.create({
        sourceId: "trello-main",
        taskId: "card1",
        repo: "acme-widgets",
        branch: "openroutines/card-card1",
        status: "open",
        lastReworkNightId: "night-1",
      });
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { source_id: "trello-main", task_id: "card1", night_id: "night-1", tier: "sonnet", rework: true },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      const pool = deps.pgPool as unknown as FakePool;
      const call = pool.queries.find((q) => q.sql.includes("tier_circuit_state"));
      expect(call?.params).toEqual(["night-1", "sonnet", 0]); // failedIncrement=0 -> success
    });
  });

  describe("H9b: a pre-LLM script block never charges the tier", () => {
    it("blockReason 'repo-unresolvable' (preparation) skips recordTierOutcome entirely", async () => {
      const { deps } = makeDeps();
      await seedExecution(deps.persistence, "exec-1", {
        stateMachineContext: { outputs: { blocked: { blockReason: "repo-unresolvable" } } },
      });
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { source_id: "trello-main", task_id: "card1", night_id: "night-1", tier: "sonnet" },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      const pool = deps.pgPool as unknown as FakePool;
      expect(pool.queries.some((q) => q.sql.includes("tier_circuit_state"))).toBe(false);
    });

    it("blockReason 'budget' (budget denial) skips recordTierOutcome entirely", async () => {
      const { deps } = makeDeps();
      await seedExecution(deps.persistence, "exec-1", {
        stateMachineContext: { outputs: { blocked: { blockReason: "budget" } } },
      });
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { source_id: "trello-main", task_id: "card1", night_id: "night-1", tier: "sonnet" },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      const pool = deps.pgPool as unknown as FakePool;
      expect(pool.queries.some((q) => q.sql.includes("tier_circuit_state"))).toBe(false);
    });

    it("a block reached AFTER the tier ran (e.g. verify-failed) still charges the tier normally", async () => {
      const { deps } = makeDeps();
      await seedExecution(deps.persistence, "exec-1", {
        stateMachineContext: { outputs: { blocked: { blockReason: "verify-failed" } } },
      });
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { source_id: "trello-main", task_id: "card1", night_id: "night-1", tier: "sonnet" },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      const pool = deps.pgPool as unknown as FakePool;
      expect(pool.queries.some((q) => q.sql.includes("tier_circuit_state"))).toBe(true);
    });
  });

  describe("H9d: recordTierOutcome only fires for card-to-pr (F5 #163)", () => {
    it("a card-research execution with result.success:true never calls recordTierOutcome (it never creates pr_links, so it would otherwise always be charged as a tier failure)", async () => {
      const { deps } = makeDeps({
        skills: {
          "card-to-pr": { config: {} as StateMachineConfig, skill: { id: "card-to-pr" } as unknown as SkillStateMachine },
          "card-research": { config: {} as StateMachineConfig, skill: { id: "card-research" } as unknown as SkillStateMachine },
        },
      });
      await seedExecution(deps.persistence, "exec-1");
      const job = {
        trigger: {
          type: "card-execution",
          executionId: "exec-1",
          payload: { source_id: "trello-main", task_id: "card1", night_id: "night-1", tier: "sonnet", skill: "card-research" },
        },
      };

      await runCardExecutionJob(deps, job, undefined);

      const pool = deps.pgPool as unknown as FakePool;
      expect(pool.queries.some((q) => q.sql.includes("tier_circuit_state"))).toBe(false);
    });
  });

  describe("F5 #163: skill routing by payload.skill", () => {
    it("routes the job to the state machine named by payload.skill", async () => {
      const researchConfig = { marker: "research" } as unknown as StateMachineConfig;
      const researchSkill = { id: "card-research" } as unknown as SkillStateMachine;
      let ranConfig: unknown;
      let ranSkill: unknown;
      const fakeRun = vi.fn((config: unknown) => (skill: unknown) => {
        ranConfig = config;
        ranSkill = skill;
        return Effect.succeed(okResult);
      });
      const { deps } = makeDeps({
        skills: {
          "card-to-pr": { config: {} as StateMachineConfig, skill: { id: "card-to-pr" } as unknown as SkillStateMachine },
          "card-research": { config: researchConfig, skill: researchSkill },
        },
        runStateMachine: fakeRun as unknown as CardExecutionJobDeps["runStateMachine"],
      });
      await seedExecution(deps.persistence, "exec-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: { night_id: "night-1", skill: "card-research" } } };

      await runCardExecutionJob(deps, job, undefined);

      expect(ranConfig).toBe(researchConfig);
      expect(ranSkill).toBe(researchSkill);
    });

    it("an absent payload.skill defaults to card-to-pr (back-compat with pre-routing jobs)", async () => {
      const cardToPrSkill = { id: "card-to-pr" } as unknown as SkillStateMachine;
      let ranSkill: unknown;
      const fakeRun = vi.fn((_config: unknown) => (skill: unknown) => {
        ranSkill = skill;
        return Effect.succeed(okResult);
      });
      const { deps } = makeDeps({
        skills: { "card-to-pr": { config: {} as StateMachineConfig, skill: cardToPrSkill } },
        runStateMachine: fakeRun as unknown as CardExecutionJobDeps["runStateMachine"],
      });
      await seedExecution(deps.persistence, "exec-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: { night_id: "night-1" } } };

      await runCardExecutionJob(deps, job, undefined);

      expect(ranSkill).toBe(cardToPrSkill);
    });

    it("an unknown payload.skill marks the execution failed (blockReason unknown-skill) and never runs", async () => {
      const { deps, fakeRun } = makeDeps();
      await seedExecution(deps.persistence, "exec-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: { night_id: "night-1", skill: "card-nope" } } };

      await runCardExecutionJob(deps, job, undefined);

      const saved = await deps.persistence.findById("exec-1");
      expect(saved?.status).toBe("failed");
      expect(saved?.metadata?.blockReason).toBe("unknown-skill");
      expect(fakeRun).not.toHaveBeenCalled();
    });

    it("with no skills registered at all, logs and returns WITHOUT failing the execution", async () => {
      const { deps, fakeRun } = makeDeps({ skills: undefined });
      await seedExecution(deps.persistence, "exec-1");
      const job = { trigger: { type: "card-execution", executionId: "exec-1", payload: { skill: "card-to-pr" } } };

      await runCardExecutionJob(deps, job, undefined);

      const saved = await deps.persistence.findById("exec-1");
      expect(saved?.status).toBe("pending"); // untouched — global misconfig, not a per-card failure
      expect(fakeRun).not.toHaveBeenCalled();
    });
  });
});
