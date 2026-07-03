import { describe, it, expect, vi } from "vitest";
import { makeVerify } from "./verify.js";
import type { CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { VerifyResults } from "../../verify/run-commands.js";

const preparacaoFixture = (overrides: Partial<PreparacaoOutput> = {}): PreparacaoOutput => ({
  branchProtected: true,
  worktree: { path: "/tmp/or-verify-test-wt", branch: "openroutines/card-t1" },
  baseSha: "base-sha",
  baselineResults: null,
  repo: {
    githubRepo: "acme/widgets",
    baseBranch: "development",
    clonePath: "/tmp/or-verify-test-clone",
    slug: "acme-widgets",
    verify: { build: "npm run build", test: "npm test" },
  },
  ...overrides,
});

const baseDeps = (overrides: Partial<CardToPrDeps> = {}): CardToPrDeps => ({
  registry: { repos: {} },
  githubToken: "gh_test",
  worktreeBase: "/tmp/or-verify-test-worktrees",
  ledger: makeInMemoryActionLedgerRepository(),
  prLinks: makeInMemoryPrLinkRepository(),
  taskSourceFor: () => undefined,
  ...overrides,
});

const inputs = { source_id: "s", task_id: "t", repo: "r", title: "T", description: "D" };

const passingResults: VerifyResults = {
  build: { passed: true },
  typecheck: undefined,
  lint: undefined,
  test: { passed: true },
};

const failingBuildResults: VerifyResults = {
  build: { passed: false, notes: "boom" },
  typecheck: undefined,
  lint: undefined,
  test: { passed: true },
};

describe("makeVerify", () => {
  it("AC3: a new failure is retryable at attempt 1, then stalls when the identical failure repeats at attempt 2", async () => {
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const runVerify = vi.fn(async () => failingBuildResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparacao = preparacaoFixture();

    const r1 = await handler({ inputs, outputs: { preparacao }, executionId: "e1", stateId: "verify" });
    expect(r1).toMatchObject({ passed: false, attempt: 1, stalled: false, retryable: true });
    expect((r1 as Record<string, unknown>).blockReason).toBeUndefined();

    const r2 = await handler({ inputs, outputs: { preparacao, verify: r1 }, executionId: "e1", stateId: "verify" });
    expect(r2).toMatchObject({
      passed: false,
      attempt: 2,
      stalled: true,
      retryable: false,
      blockReason: "verify-falhou",
    });

    expect(runVerify).toHaveBeenCalledTimes(2);
  });

  it("does not stall when the 2nd attempt's failure signature differs from the 1st", async () => {
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    let call = 0;
    const runVerify = vi.fn(async () => {
      call++;
      // 1st attempt fails build, 2nd attempt fails a different step (test) —
      // different failureSignature, so attempt 2 must not be marked stalled.
      return call === 1
        ? failingBuildResults
        : ({ build: { passed: true }, typecheck: undefined, lint: undefined, test: { passed: false } } as VerifyResults);
    });
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparacao = preparacaoFixture();

    const r1 = await handler({ inputs, outputs: { preparacao }, executionId: "e1", stateId: "verify" });
    const r2 = await handler({ inputs, outputs: { preparacao, verify: r1 }, executionId: "e1", stateId: "verify" });

    expect(r2).toMatchObject({ attempt: 2, stalled: false, retryable: true });
  });

  it("AC4: a forbidden-path change reproves regardless of verify commands passing", async () => {
    const runGit = vi.fn(async () => ({ stdout: ".github/workflows/ci.yml\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparacao = preparacaoFixture();

    const r = await handler({ inputs, outputs: { preparacao }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({
      passed: false,
      forbiddenPathsTouched: [".github/workflows/ci.yml"],
      newFailures: [],
    });
  });

  it("AC4: a root-level dotfile and a .git/ path are both forbidden; a normal src file is not", async () => {
    const runGit = vi.fn(async () => ({ stdout: ".env\nsrc/index.ts\n.git/config\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparacao = preparacaoFixture();

    const r = await handler({ inputs, outputs: { preparacao }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({
      passed: false,
      forbiddenPathsTouched: [".env", ".git/config"],
      diffLoc: 3,
    });
  });

  it("passes when verify commands pass and no forbidden path was touched", async () => {
    const runGit = vi.fn(async () => ({ stdout: "src/index.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparacao = preparacaoFixture();

    const r = await handler({ inputs, outputs: { preparacao }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: true, forbiddenPathsTouched: [], blockReason: undefined });
  });
});
