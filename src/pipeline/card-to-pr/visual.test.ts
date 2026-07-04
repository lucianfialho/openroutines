import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeVisual, parseGoldenRoutes, parseSsimReport, type VisualDeps, type VisualOutput } from "./visual.js";
import type { CardToPrDeps } from "./index.js";
import type { CompletionResponse } from "../../provider/types.js";
import type { ScriptContext } from "../../script/registry.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { RepoRegistry } from "../../repo-registry/schema.js";

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "mock",
  finishReason: "stop",
});

const registry: RepoRegistry = {
  repos: { "acme-widgets": { clonePath: "/tmp/c", githubRepo: "acme/widgets", baseBranch: "development", verify: {} } },
};

const okCompose = () => ({
  composeUp: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:4000", project: "or-e1" })),
  composeDown: vi.fn(async () => undefined),
});

const baseDeps = (visual: VisualDeps, taskSourceFor?: CardToPrDeps["taskSourceFor"]): CardToPrDeps => ({
  registry,
  githubToken: "gh",
  worktreeBase: "/tmp/wt",
  ledger: makeInMemoryActionLedgerRepository(),
  prLinks: makeInMemoryPrLinkRepository(),
  taskSourceFor: taskSourceFor ?? (() => undefined),
  visual,
});

const ctx = (visualAssertions: unknown[] = []): ScriptContext => ({
  inputs: { source_id: "s", task_id: "t1", title: "Card", description: "desc" },
  outputs: {
    preparation: { worktree: { path: "/tmp/wt/card-t1" } },
    plan: { visualAssertions },
  },
  executionId: "e1",
  stateId: "visual",
});

const run = async (deps: CardToPrDeps, c = ctx()): Promise<VisualOutput> =>
  (await makeVisual(deps)(c)) as unknown as VisualOutput;

describe("makeVisual (#160)", () => {
  it("SSIM regression fails fast: passed=false and NO LLM provider is ever called", async () => {
    const compose = okCompose();
    const agentProvider = { complete: vi.fn(() => Effect.succeed(resp("{}"))) };
    const visionProvider = { complete: vi.fn(() => Effect.succeed(resp("{}"))) };
    const runSsim = vi.fn(async () => [{ route: "/", score: 0.4, regressed: true }]);

    const out = await run(baseDeps({ agentProvider, visionProvider, runSsim, readGoldenRoutes: () => ["/"], ...compose }));

    expect(out.passed).toBe(false);
    expect(out.ssim).toEqual([{ route: "/", score: 0.4, regressed: true }]);
    expect(agentProvider.complete).not.toHaveBeenCalled();
    expect(visionProvider.complete).not.toHaveBeenCalled();
    expect(compose.composeDown).toHaveBeenCalledTimes(1);
  });

  it("surfaces an injected console.error from the Kimi navigation into consoleErrors[]", async () => {
    const compose = okCompose();
    const agentProvider = {
      complete: vi.fn(() =>
        Effect.succeed(
          resp(
            JSON.stringify({
              assertions: [{ id: "a1", verdict: "pass", confidence: 9 }],
              screenshots: ["/x/a1.png"],
              consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'x')"],
            })
          )
        )
      ),
    };
    const runSsim = vi.fn(async () => []);

    const out = await run(
      baseDeps({ agentProvider, runSsim, readGoldenRoutes: () => [], ...compose }),
      ctx([{ id: "a1", description: "shows the widget" }])
    );

    expect(out.consoleErrors).toContain("TypeError: Cannot read properties of undefined (reading 'x')");
    // A console.error is a hard fail — the PR evidence line reads "0 console.error".
    expect(out.passed).toBe(false);
  });

  it("escalates ONLY the low-confidence assertion to Sonnet vision (confidence:4 -> exactly 1 vision call)", async () => {
    const compose = okCompose();
    const agentProvider = {
      complete: vi.fn(() =>
        Effect.succeed(
          resp(
            JSON.stringify({
              assertions: [
                { id: "a1", verdict: "pass", confidence: 8 },
                { id: "a2", verdict: "fail", confidence: 4 },
              ],
              screenshots: ["/x/a1.png", "/x/a2.png"],
              consoleErrors: [],
            })
          )
        )
      ),
    };
    const visionProvider = { complete: vi.fn(() => Effect.succeed(resp(JSON.stringify({ verdict: "pass", confidence: 9 })))) };
    const runSsim = vi.fn(async () => []);

    const out = await run(
      baseDeps({
        agentProvider,
        visionProvider,
        runSsim,
        readGoldenRoutes: () => [],
        readScreenshot: () => "b64",
        ...compose,
      }),
      ctx([
        { id: "a1", description: "layout" },
        { id: "a2", description: "spacing" },
      ])
    );

    expect(visionProvider.complete).toHaveBeenCalledTimes(1);
    const a1 = out.assertions.find((a) => a.id === "a1")!;
    const a2 = out.assertions.find((a) => a.id === "a2")!;
    expect(a1.judgedBy).toBe("kimi");
    expect(a2.judgedBy).toBe("sonnet-vision");
    // Sonnet's verdict replaces Kimi's fail:4 with pass:9.
    expect(a2.verdict).toBe("pass");
    expect(a2.confidence).toBe(9);
    expect(out.passed).toBe(true);
  });

  it("a brand-fidelity assertion escalates to vision even at high confidence", async () => {
    const compose = okCompose();
    const agentProvider = {
      complete: vi.fn(() =>
        Effect.succeed(
          resp(JSON.stringify({ assertions: [{ id: "b1", verdict: "pass", confidence: 9 }], screenshots: ["/x/b1.png"], consoleErrors: [] }))
        )
      ),
    };
    const visionProvider = { complete: vi.fn(() => Effect.succeed(resp(JSON.stringify({ verdict: "pass", confidence: 10 })))) };

    const out = await run(
      baseDeps({ agentProvider, visionProvider, runSsim: async () => [], readGoldenRoutes: () => [], readScreenshot: () => "b64", ...compose }),
      ctx([{ id: "b1", description: "matches brand palette", kind: "brand-fidelity" }])
    );

    expect(visionProvider.complete).toHaveBeenCalledTimes(1);
    expect(out.assertions[0].judgedBy).toBe("sonnet-vision");
  });

  it("without a vision provider, a low-confidence Kimi verdict stands (degraded, no escalation)", async () => {
    const compose = okCompose();
    const agentProvider = {
      complete: vi.fn(() => Effect.succeed(resp(JSON.stringify({ assertions: [{ id: "a1", verdict: "pass", confidence: 3 }], screenshots: [], consoleErrors: [] })))),
    };

    const out = await run(
      baseDeps({ agentProvider, runSsim: async () => [], readGoldenRoutes: () => [], ...compose }),
      ctx([{ id: "a1", description: "x" }])
    );

    expect(out.assertions[0].judgedBy).toBe("kimi");
    expect(out.assertions[0].confidence).toBe(3);
  });

  it("runs compose down in finally even when a mid-phase step throws", async () => {
    const compose = okCompose();
    const agentProvider = { complete: vi.fn(() => Effect.succeed(resp("{}"))) };
    const runSsim = vi.fn(async () => {
      throw new Error("playwright blew up");
    });

    await expect(
      run(baseDeps({ agentProvider, runSsim, readGoldenRoutes: () => ["/"], ...compose }))
    ).rejects.toThrow(/playwright blew up/);
    expect(compose.composeDown).toHaveBeenCalledTimes(1);
    // The provider was never reached (SSIM ran first and threw).
    expect(agentProvider.complete).not.toHaveBeenCalled();
  });

  it("on pass, attaches the screenshots to the card", async () => {
    const compose = okCompose();
    const agentProvider = {
      complete: vi.fn(() =>
        Effect.succeed(resp(JSON.stringify({ assertions: [{ id: "a1", verdict: "pass", confidence: 9 }], screenshots: ["/x/a1.png"], consoleErrors: [] })))
      ),
    };
    const attachScreenshots = vi.fn(async () => undefined);

    const out = await run(
      baseDeps({ agentProvider, runSsim: async () => [], readGoldenRoutes: () => [], attachScreenshots, ...compose }),
      ctx([{ id: "a1", description: "x" }])
    );

    expect(out.passed).toBe(true);
    expect(attachScreenshots).toHaveBeenCalledWith("t1", ["/x/a1.png"]);
  });
});

describe("parseGoldenRoutes", () => {
  it("extracts routes under the 'Rotas douradas' heading and stops at the next heading", () => {
    const md = [
      "## Stack",
      "- Next.js",
      "## Rotas douradas",
      "- `/` — home",
      "- /dashboard (main screen)",
      "* `/settings/profile`",
      "## Gotchas",
      "- /not-a-route-here",
    ].join("\n");
    expect(parseGoldenRoutes(md)).toEqual(["/", "/dashboard", "/settings/profile"]);
  });
});

describe("parseSsimReport", () => {
  it("marks a spec regressed when its screenshot assertion did not pass", () => {
    const report = {
      suites: [
        {
          specs: [
            { title: "/", ok: true, tests: [{ results: [{ status: "passed" }] }] },
            { title: "/pricing", ok: false, tests: [{ results: [{ status: "failed" }] }] },
          ],
        },
      ],
    };
    expect(parseSsimReport(report)).toEqual([
      { route: "/", score: 1, regressed: false },
      { route: "/pricing", score: 0, regressed: true },
    ]);
  });
});
