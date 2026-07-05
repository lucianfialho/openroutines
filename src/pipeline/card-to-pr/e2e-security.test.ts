/**
 * card-to-pr SECURITY-GATE E2E (F4 #154) — the anti-regression contract.
 *
 * Drives the REAL .gates/skills/card-to-pr/skill.yaml through the REAL
 * runStateMachine / runFanout with the REAL makeSecurityJudgeProvider wired
 * into the providerRegistry: the judge parses the REAL review-security.md
 * render (verify/contestacao blocks, critical-area detection, adjudication),
 * and ONLY the inner claude-api LLM is faked (the makeInnerProvider seam that
 * security-judge.test.ts uses). The other lenses/agents are thin fakes.
 *
 * Against the hollow gate (10 commits back the fixture's providerRegistry
 * resolved "security-judge" by NAME and returned fixed JSON, so the judge's
 * parsers never saw the rendered template) every assertion below fails: there
 * was no inner call at all, no critical-area routing, no adjudication chain.
 *
 * H8 (tier escalation on the rework flow) is already covered by
 * rework.e2e.test.ts — not duplicated here.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import type { Pool } from "pg";
import { Effect } from "effect";
import { runStateMachine } from "../../engine/state-machine.js";
import { makeScriptRegistry } from "../../script/registry.js";
import { parseSkillStateMachine } from "../../skill/parser.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import { registerCardToPrHandlers, cardToPrFanoutAggregators, type CardToPrDeps } from "./index.js";
import {
  makeSecurityJudgeProvider,
  DEFAULT_JUDGE_MODEL,
} from "../../provider/security-judge.js";
import type { CompletionRequest, CompletionResponse } from "../../provider/types.js";
import type { ProviderAdapter, ProviderRegistry } from "../../provider/registry.js";
import type { Routine } from "../../routine/types.js";
import type { TriggerEvent } from "../../routine/matcher.js";
import type { ExecutionRecord } from "../../persistence/types.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";
import type { TaskSource } from "../../task-source/types.js";

const routine: Routine = { id: "r", triggers: [{ type: "task_source" }], pipeline: { skill: "card-to-pr" } } as Routine;

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
});

// --- inner judge fake (the makeInnerProvider seam — mirrors security-judge.test.ts) ---

interface RecordedCall {
  model: string;
  request: CompletionRequest;
  /** system + messages + prompt flattened — exactly what the judge saw. */
  text: string;
}
type Responder = (call: RecordedCall) => string | { content: string; model?: string };

const flatten = (request: CompletionRequest): string =>
  [request.system ?? "", ...(request.messages ?? []).map((m) => m.content), request.prompt ?? ""].join("\n");

/** Records every inner call and echoes the REQUESTED model (anti-bypass passes). */
const mockInner =
  (respond: Responder, calls: RecordedCall[]) =>
  (config: { apiKey: string; baseURL?: string; model: string }): ProviderAdapter => ({
    complete: (request: CompletionRequest) =>
      Effect.sync((): CompletionResponse => {
        const call: RecordedCall = { model: config.model, request, text: flatten(request) };
        calls.push(call);
        const r = respond(call);
        const content = typeof r === "string" ? r : r.content;
        const model = typeof r === "string" ? config.model : (r.model ?? config.model);
        return { content, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model, finishReason: "stop" };
      }),
  });

// The judge's round-1 prompt embeds <dados_revisao>; round-2 adds <achado>;
// adjudication adds <evidencia_contestacao>. Same discriminators as the unit test.
const isRound1 = (c: RecordedCall) => c.text.includes("<dados_revisao") && !c.text.includes("<achado>");
const isRound2 = (c: RecordedCall) => c.text.includes("<achado>") && !c.text.includes("<evidencia_contestacao");
const isAdjudication = (c: RecordedCall) => c.text.includes("<evidencia_contestacao");

const finding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "f1",
  description: "SQL injection via unescaped card title",
  category: "injection",
  file: "src/db/query.ts",
  line: 12,
  confidence: 9,
  ...over,
});
const round1 = (findings: Array<Record<string, unknown>>): string => JSON.stringify({ findings });
const genuine = JSON.stringify({ verdict: "genuine", reasoning: "exploit path confirmed" });

// --- prompt-hygiene helper (H5) --------------------------------------------------
// The template leaves an UNRESOLVED {{outputs.X}} as literal text (template.ts).
// Two are documented, intended first-pass warts (same ones rework.e2e.test.ts
// accepts): implementation's {{outputs.verify}} before any verify ran, and the
// correctness lens' {{outputs.refutation}} before any refutation ran. Everything
// else being resolved is the real anti-regression signal for the OUTER prompts;
// the security judge's INNER prompts must have ZERO {{outputs. (it strips the
// <contestacao_refutacao> block in normal mode and builds its own adjudication
// prompt), which is the gate's teeth.
const KNOWN_FIRST_PASS_WARTS = ["{{outputs.verify}}", "{{outputs.refutation}}"];
const stripKnownWarts = (s: string): string =>
  KNOWN_FIRST_PASS_WARTS.reduce((acc, w) => acc.split(w).join(""), s);

// --- shared harness --------------------------------------------------------------

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/or-sec-e2e-clone",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
  },
};

const makeRepo = () => {
  const store = new Map<string, ExecutionRecord>();
  store.set("exec1", {
    id: "exec1",
    routineId: "r",
    triggerType: "task_source",
    skillName: "card-to-pr",
    status: "pending",
    startedAt: new Date(),
  });
  return { save: async (rec: ExecutionRecord) => void store.set(rec.id, rec), findById: async (id: string) => store.get(id), findByRoutine: async () => [], findAll: async () => [] };
};

const event: TriggerEvent = {
  type: "task_source",
  payload: {
    source_id: "trello-main",
    task_id: "card1",
    repo: "acme-widgets",
    title: "Fix the bug",
    description: "Card description",
    night_id: "night-1",
  },
} as TriggerEvent;

// plan/implementation outputs reused verbatim from e2e.test.ts (estimatedLoc
// omitted on purpose — the schema-validate integer quirk documented there).
const planoJson = JSON.stringify({
  summary: "Add the missing validation",
  files: ["src/foo.ts"],
  testStrategy: "unit tests around the new validation",
  dataChanges: [],
  needsArchGate: false,
  risks: [],
});
const implementacaoJson = JSON.stringify({
  filesTouched: ["src/foo.ts"],
  commits: ["abc123 fix: add validation"],
  notes: "done",
  openDecisions: [],
});

interface HarnessOpts {
  /** Inner judge behavior (round-1/round-2/adjudication). */
  respond: Responder;
  /** Drives verify.changedFiles -> criticalArea via the REAL verify script. */
  changedFiles: string[];
  /** claude-cli refutation response (contest vs. correct). Default: contest. */
  refutacaoReply?: (prompt: string) => string;
  budgetGate?: (ctx: { phase: string; tier: string; executionId: string }) => Promise<{ granted: boolean; reservationId?: string }>;
}

const makeHarness = (opts: HarnessOpts) => {
  const innerCalls: RecordedCall[] = [];
  const outerPrompts: Array<{ key: string; prompt: string }> = [];
  const moveToCalls: Array<[string, string]> = [];
  const sendAlert = vi.fn(async (_msg: string) => {});
  const budgetCalls: Array<{ phase: string; tier: string; executionId: string }> = [];

  const runGit = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args[0] === "rev-parse") return { stdout: "deadbeefcafebabe1234\n", stderr: "" };
    if (args[0] === "diff" && args[1] === "--name-only")
      return { stdout: opts.changedFiles.length ? `${opts.changedFiles.join("\n")}\n` : "", stderr: "" };
    return { stdout: "", stderr: "" }; // fetch / worktree add / diff --numstat
  };
  const runVerify = async () => ({ build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: true } });
  const getBaseline = async () => ({
    baseSha: "deadbeefcafebabe1234",
    results: { build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: true } },
  });

  const createdPr = { url: "https://github.com/acme/widgets/pull/7", number: 7, branch: "openroutines/card-card1" };
  const makeGithub = (() => ({
    getOpenPrByBranch: () => Effect.succeed(undefined),
    createPullRequest: () => Effect.succeed({ pr: createdPr }),
  })) as unknown as CardToPrDeps["makeGithub"];

  const taskSource = {
    moveTo: (id: string, state: string) => {
      moveToCalls.push([id, state]);
      return Effect.succeed(undefined);
    },
    comment: () => Effect.succeed(undefined),
  } as unknown as TaskSource;

  const prLinks = makeInMemoryPrLinkRepository();

  const deps: CardToPrDeps = {
    pool: {} as unknown as Pool,
    registry,
    githubToken: "gh_test",
    worktreeBase: `/tmp/or-sec-e2e-wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ledger: makeInMemoryActionLedgerRepository(),
    prLinks,
    taskSourceFor: (sourceId) => (sourceId === "trello-main" ? taskSource : undefined),
    makeGithub,
    checkProtection: async () => ({ protected: true }),
    runGit,
    runVerify,
    getBaseline,
    sendAlert,
  };

  const scriptRegistry = makeScriptRegistry();
  registerCardToPrHandlers(scriptRegistry, deps);

  // ONE judge instance shared across every review pass — its inner fake
  // accumulates into innerCalls.
  const judge = makeSecurityJudgeProvider({
    claudeApi: { apiKey: "sk-test" },
    makeInnerProvider: mockInner(opts.respond, innerCalls),
  });

  const refutacaoReply =
    opts.refutacaoReply ??
    ((_prompt: string) => JSON.stringify({ status: "contestado", evidencia: "EVIDENCIA_MARKER: input sanitizado", correcoes: [] }));

  const mkOuter = (key: string, reply: (prompt: string) => string) =>
    ({
      complete: (req: { messages?: Array<{ role: string; content: string }>; prompt?: string }) => {
        const prompt = req.messages?.[req.messages.length - 1]?.content ?? req.prompt ?? "";
        outerPrompts.push({ key, prompt });
        return Effect.succeed(resp(reply(prompt)));
      },
    }) as unknown as ProviderAdapter;

  const providerRegistry: ProviderRegistry = {
    resolve: (name, model) => {
      const key = `${String(name)}:${model ?? ""}`;
      if (String(name) === "security-judge") return judge;
      if (String(name) === "kimi-cli")
        return mkOuter(key, () => JSON.stringify({ approved: true, gaps: [] })); // correctness lens: clean
      if (String(name) === "claude-cli")
        return mkOuter(key, (prompt) => {
          if (prompt.includes("Explore o repositório")) return planoJson;
          if (prompt.includes("Implemente o plan")) return implementacaoJson;
          return refutacaoReply(prompt); // refutation.md
        });
      throw new Error(`security e2e fixture: unexpected provider '${key}'`);
    },
  };

  const config = {
    provider: { complete: () => Effect.succeed(resp("{}")) },
    providerRegistry,
    repository: makeRepo(),
    scriptRegistry,
    fanoutAggregators: cardToPrFanoutAggregators,
    ...(opts.budgetGate
      ? {
          budgetGate: (ctx: { phase: string; tier: string; executionId: string }) => {
            budgetCalls.push(ctx);
            return opts.budgetGate!(ctx);
          },
        }
      : {}),
  };

  const run = () =>
    Effect.runPromise(
      runStateMachine(config as Parameters<typeof runStateMachine>[0])(
        parseSkillStateMachine(readFileSync(".gates/skills/card-to-pr/skill.yaml", "utf-8")),
        routine,
        event,
        "exec1"
      )
    );

  return { run, innerCalls, outerPrompts, moveToCalls, sendAlert, prLinks, budgetCalls };
};

/** Asserts H5 across a finished run: judge saw only resolved content; outer
 * prompts carry only the two documented first-pass warts. */
const assertNoUnresolvedPlaceholders = (h: { innerCalls: RecordedCall[]; outerPrompts: Array<{ prompt: string }> }) => {
  expect(h.innerCalls.length).toBeGreaterThan(0); // the REAL judge actually ran (hollow gate: 0)
  for (const c of h.innerCalls) expect(c.text).not.toContain("{{outputs."); // gate always parses resolved content
  for (const p of h.outerPrompts) expect(stripKnownWarts(p.prompt)).not.toContain("{{outputs.");
};

// --- H1: critical-area routing off the REAL render ------------------------------

describe("security-gate E2E — critical-area routing (H1)", () => {
  it("verify.changedFiles touching src/auth/* runs Opus round-1 and reaches PR (critical area, single judge)", async () => {
    const h = makeHarness({ respond: () => round1([]), changedFiles: ["src/auth/login.ts"] });
    const r = await h.run();

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");
    const opusCalls = h.innerCalls.filter((c) => c.model === DEFAULT_JUDGE_MODEL);
    expect(opusCalls.filter(isRound1)).toHaveLength(1);
    // Clean judge -> approved -> handed to Review, PR opened.
    expect(h.moveToCalls).toContainEqual(["card1", "review"]);
    expect(await h.prLinks.findByTask("trello-main", "card1")).toHaveLength(1);
    assertNoUnresolvedPlaceholders(h);
  });

  it("neutral changedFiles (src/report/*) also run a single Opus round-1 and reach PR", async () => {
    const h = makeHarness({ respond: () => round1([]), changedFiles: ["src/report/x.ts"] });
    const r = await h.run();

    expect(r.success).toBe(true);
    expect(h.innerCalls.filter((c) => c.model === DEFAULT_JUDGE_MODEL && isRound1(c))).toHaveLength(1);
    expect(h.moveToCalls).toContainEqual(["card1", "review"]);
    assertNoUnresolvedPlaceholders(h);
  });
});

// --- H2: full adjudication chain -------------------------------------------------

describe("security-gate E2E — adjudication chain (H2)", () => {
  it("blocking finding -> gap -> refutation contests -> review re-runs in ADJUDICATION mode with the contest evidence visible -> demoted -> pipeline reaches pr", async () => {
    const EVIDENCIA = "EVIDENCIA_MARKER_H2: input já é sanitizado em src/db/sanitize.ts";
    const h = makeHarness({
      changedFiles: ["src/db/query.ts"], // non-critical: single Opus judge, simpler chain
      // Round 1 finds a genuine confidence-9 finding; adjudication DEMOTES it.
      respond: (c) => {
        if (isAdjudication(c)) return JSON.stringify({ decision: "adjudicado-libera", reasoning: "evidência procede" });
        if (isRound2(c)) return genuine;
        return round1([finding({ confidence: 9 })]);
      },
      refutacaoReply: () => JSON.stringify({ status: "contestado", evidencia: EVIDENCIA, correcoes: [] }),
    });
    const r = await h.run();

    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");

    // The inner fake received a real adjudication call: adjudication SYSTEM
    // prompt ("tribunal") with the contest evidence AND the contested finding
    // rendered into it — proof {{outputs.refutation}}/{{outputs.review.gaps}}
    // resolved on the second pass and reached the judge's parser.
    const adjudicationCalls = h.innerCalls.filter(isAdjudication);
    expect(adjudicationCalls).toHaveLength(1);
    expect(adjudicationCalls[0].request.system).toContain("tribunal");
    expect(adjudicationCalls[0].text).toContain(EVIDENCIA);
    expect(adjudicationCalls[0].text).toContain("SQL injection via unescaped card title");

    // adjudicado-libera -> approved -> card handed to Review (not blocked).
    expect(h.moveToCalls).toContainEqual(["card1", "review"]);
    expect(h.moveToCalls).not.toContainEqual(["card1", "blocked"]);
    expect(await h.prLinks.findByTask("trello-main", "card1")).toHaveLength(1);
    assertNoUnresolvedPlaceholders(h);
  });
});

// --- H3: planted security failure, never fixed (card F4 acceptance #1) -----------

describe("security-gate E2E — planted vuln exhausts refutation (H3)", () => {
  it("inner always re-finds the blocking finding -> review->refutation exhausts max_retries:2 -> blocked with blockReason 'security-exhausted' (Telegram alert fires)", async () => {
    const h = makeHarness({
      changedFiles: ["src/db/query.ts"],
      // Stubborn judge: round-1 always re-finds it, round-2 always genuine, and
      // (defensively) adjudication would keep blocking too. The finding stays
      // status:"open" every normal-mode pass, so it is a contestable gap each
      // time the review re-runs.
      respond: (c) => {
        if (isAdjudication(c)) return JSON.stringify({ decision: "adjudicado-bloqueia", reasoning: "não refutado" });
        if (isRound2(c)) return genuine;
        return round1([finding({ confidence: 9 })]);
      },
      // Implementer claims to "corrigir", but the fake implementation is a no-op
      // so the vuln persists -> each review re-runs in NORMAL mode and re-finds
      // it, driving the review->refutation edge to exhaustion.
      refutacaoReply: () => JSON.stringify({ status: "corrigir", evidencia: "", correcoes: ["escapar input"] }),
    });
    const r = await h.run();

    // blocked -> done is a clean terminal path.
    expect(r.success).toBe(true);
    expect(r.logs.join(" ")).toContain("Reached terminal state: done");

    // 3 review passes (edge fires at count 1, 2, then exhausts at 3).
    expect(h.innerCalls.filter(isRound1)).toHaveLength(3);

    // Card blocked, NOT handed to Review; blockReason is the security-exhaustion
    // one (prefix "security*" => the Telegram alert funnel fires).
    expect(h.moveToCalls).toContainEqual(["card1", "blocked"]);
    expect(h.moveToCalls).not.toContainEqual(["card1", "review"]);
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    expect(h.sendAlert.mock.calls[0][0]).toContain("security-exhausted");
    assertNoUnresolvedPlaceholders(h);
  }, 20000);
});

// --- H6: per-lens budget reservation inside the real fanout ----------------------

describe("security-gate E2E — per-lens budget reservation (H6)", () => {
  it("a budgetGate spy sees >=1 reservation per EXECUTED lens (correctness + security), data skipped since dataChanges=false", async () => {
    const budgetGate = vi.fn(async ({ tier }: { phase: string; tier: string }) => ({ granted: true, reservationId: `res-${tier}` }));
    const h = makeHarness({ respond: () => round1([]), changedFiles: ["src/report/x.ts"], budgetGate });
    const r = await h.run();

    expect(r.success).toBe(true);
    // tier = lens.model ?? lens.provider (state-machine.ts runFanout).
    const revisaoReservations = h.budgetCalls.filter((c) => c.phase === "review");
    expect(revisaoReservations).toContainEqual({ phase: "review", tier: "kimi-k2.6", executionId: "exec1" }); // correctness
    expect(revisaoReservations).toContainEqual({ phase: "review", tier: "claude-opus-4-8", executionId: "exec1" }); // security
    // data lens (claude-sonnet-5) is skipped by its when: -> no review reservation for it.
    expect(revisaoReservations.filter((c) => c.tier === "claude-sonnet-5")).toHaveLength(0);
  });
});
