import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeVerify } from "./verify.js";
import type { CardToPrDeps } from "./index.js";
import type { PreparationOutput } from "./preparation.js";
import { makeInMemoryActionLedgerRepository } from "../../persistence/action-ledger-in-memory.js";
import { makeInMemoryPrLinkRepository } from "../../persistence/pr-links-in-memory.js";
import type { VerifyResults } from "../../verify/run-commands.js";
import { runSast, emptySastResult } from "../../verify/sast.js";
import type { BaselineResults } from "../../verify/baseline.js";

// runSast shells out to semgrep/gitleaks/npm audit (F4 #155) — mocked so
// these stay unit tests with zero real subprocess/network calls regardless of
// what's on the runner's PATH. filterSastAgainstBaseline is left real (pure,
// no process spawning), same treatment as diffAgainstBaseline below.
vi.mock("../../verify/sast.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../verify/sast.js")>();
  return { ...actual, runSast: vi.fn() };
});

const preparationFixture = (overrides: Partial<PreparationOutput> = {}): PreparationOutput => ({
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
  beforeEach(() => {
    // Default: a clean SAST run. Tests exercising SAST-driven behavior
    // override with mockResolvedValueOnce.
    vi.mocked(runSast).mockReset().mockResolvedValue(emptySastResult());
  });

  it("AC3: a new failure is retryable at attempt 1, then stalls when the identical failure repeats at attempt 2", async () => {
    const runGit = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const runVerify = vi.fn(async () => failingBuildResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparation = preparationFixture();

    const r1 = await handler({ inputs, outputs: { preparation }, executionId: "e1", stateId: "verify" });
    expect(r1).toMatchObject({ passed: false, attempt: 1, stalled: false, retryable: true });
    expect((r1 as Record<string, unknown>).blockReason).toBeUndefined();

    const r2 = await handler({ inputs, outputs: { preparation, verify: r1 }, executionId: "e1", stateId: "verify" });
    expect(r2).toMatchObject({
      passed: false,
      attempt: 2,
      stalled: true,
      retryable: false,
      blockReason: "verify-failed",
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
    const preparation = preparationFixture();

    const r1 = await handler({ inputs, outputs: { preparation }, executionId: "e1", stateId: "verify" });
    const r2 = await handler({ inputs, outputs: { preparation, verify: r1 }, executionId: "e1", stateId: "verify" });

    expect(r2).toMatchObject({ attempt: 2, stalled: false, retryable: true });
  });

  it("AC4: a forbidden-path change reproves regardless of verify commands passing", async () => {
    const runGit = vi.fn(async () => ({ stdout: ".github/workflows/ci.yml\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparation = preparationFixture();

    const r = await handler({ inputs, outputs: { preparation }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({
      passed: false,
      forbiddenPathsTouched: [".github/workflows/ci.yml"],
      newFailures: [],
    });
  });

  it("AC4: a root-level dotfile and a .git/ path are both forbidden; a normal src file is not", async () => {
    const runGit = vi.fn(async (args: string[]) =>
      args.includes("--numstat")
        ? { stdout: "2\t0\t.env\n1\t1\tsrc/index.ts\n5\t0\t.git/config\n", stderr: "" }
        : { stdout: ".env\nsrc/index.ts\n.git/config\n", stderr: "" }
    );
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparation = preparationFixture();

    const r = await handler({ inputs, outputs: { preparation }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({
      passed: false,
      forbiddenPathsTouched: [".env", ".git/config"],
      diffLoc: 9, // real LOC (added+deleted from --numstat), not the 3-file count
    });
  });

  it("H4: a diff touching docs/openroutines/security-fp.md is forbidden — a demote-the-finding-you're-being-judged-on trick never reproves clean", async () => {
    const runGit = vi.fn(async () => ({ stdout: "docs/openroutines/security-fp.md\nsrc/index.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({
      passed: false,
      forbiddenPathsTouched: ["docs/openroutines/security-fp.md"],
    });
  });

  it("M8: diffLoc sums --numstat added+deleted across files, not the changed-file count", async () => {
    const runGit = vi.fn(async (args: string[]) =>
      args.includes("--numstat")
        ? { stdout: "10\t5\tsrc/a.ts\n0\t3\tsrc/b.ts\n", stderr: "" }
        : { stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" }
    );
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ diffLoc: 18 }); // (10+5) + (0+3), NOT changed.length (2)
  });

  it("M8: a binary file's '-\\t-\\tfile' numstat line contributes 0, never NaN", async () => {
    const runGit = vi.fn(async (args: string[]) =>
      args.includes("--numstat")
        ? { stdout: "-\t-\tassets/logo.png\n4\t1\tsrc/a.ts\n", stderr: "" }
        : { stdout: "assets/logo.png\nsrc/a.ts\n", stderr: "" }
    );
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ diffLoc: 5 });
  });

  it("forbids a .env at ANY depth (monorepo secrets), not just at the repo root", async () => {
    const runGit = vi.fn(async () => ({ stdout: "apps/api/.env\nsrc/index.ts\npackages/x/.env.local\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({
      passed: false,
      forbiddenPathsTouched: ["apps/api/.env", "packages/x/.env.local"],
    });
  });

  it("passes when verify commands pass and no forbidden path was touched", async () => {
    const runGit = vi.fn(async () => ({ stdout: "src/index.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparation = preparationFixture();

    const r = await handler({ inputs, outputs: { preparation }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: true, forbiddenPathsTouched: [], blockReason: undefined });
  });

  // --- F4 #155: SAST integration -------------------------------------------

  it("AC: a new secret from gitleaks reproves deterministically, even with verify/paths clean", async () => {
    const runGit = vi.fn(async () => ({ stdout: "src/index.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const secret = { file: "src/config.ts", line: 3, ruleId: "generic-api-key", matchRedacted: "[REDACTED:8chars]" };
    vi.mocked(runSast).mockResolvedValueOnce({ ...emptySastResult(), secretsFound: [secret] });
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: false, secretsFound: [secret] });
  });

  it("AC: a new high/critical prod dependency vulnerability reproves deterministically", async () => {
    const runGit = vi.fn(async () => ({ stdout: "package.json\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const vuln = { name: "left-pad", version: "<1.3.0", severity: "critical" as const, advisory: "GHSA-xxxx" };
    vi.mocked(runSast).mockResolvedValueOnce({
      ...emptySastResult(),
      dependencyAudit: { new: [{ name: "left-pad", version: "^1.0.0" }], vulnerable: [vuln] },
    });
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: false, dependencyAudit: { new: [{ name: "left-pad", version: "^1.0.0" }], vulnerable: [vuln] } });
  });

  it("AC: the same CVE on a dev-only dependency never reproves (npm's own --omit=dev already excludes it upstream)", async () => {
    const runGit = vi.fn(async () => ({ stdout: "package.json\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    // What runSast returns when the only vulnerable package is dev-only: npm
    // audit --omit=dev never puts it in the report, so vulnerable stays empty.
    vi.mocked(runSast).mockResolvedValueOnce({ ...emptySastResult(), dependencyAudit: { new: [], vulnerable: [] } });
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: true, dependencyAudit: { vulnerable: [] } });
  });

  it("AC: a finding already present in the night's SAST baseline is filtered out and never reproves", async () => {
    const runGit = vi.fn(async () => ({ stdout: "src/index.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const vuln = { name: "left-pad", version: "<1.3.0", severity: "high" as const, advisory: "GHSA-known" };
    const baselineResults: BaselineResults = {
      build: undefined,
      typecheck: undefined,
      lint: undefined,
      test: undefined,
      sast: { ...emptySastResult(), dependencyAudit: { new: [], vulnerable: [vuln] } },
    };
    vi.mocked(runSast).mockResolvedValueOnce({ ...emptySastResult(), dependencyAudit: { new: [], vulnerable: [vuln] } });
    const handler = makeVerify(baseDeps({ runGit, runVerify }));
    const preparation = preparationFixture({ baselineResults });

    const r = await handler({ inputs, outputs: { preparation }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: true, dependencyAudit: { vulnerable: [] } });
  });

  it("semgrep findings alone never flip passed to false — they feed the security lens, not this gate", async () => {
    const runGit = vi.fn(async () => ({ stdout: "src/index.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const finding = { ruleId: "prisma-raw-unsafe", file: "src/db.ts", line: 5, message: "m", severity: "ERROR" as const };
    vi.mocked(runSast).mockResolvedValueOnce({ ...emptySastResult(), semgrepFindings: [finding] });
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: true, semgrepFindings: [finding] });
  });

  it("a degraded SAST tool surfaces sastNotes without affecting passed", async () => {
    const runGit = vi.fn(async () => ({ stdout: "src/index.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    vi.mocked(runSast).mockResolvedValueOnce({
      ...emptySastResult(),
      notes: ["semgrep indisponível no PATH — etapa ignorada"],
    });
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ passed: true, sastNotes: ["semgrep indisponível no PATH — etapa ignorada"] });
  });

  it("recalculates isUI/dataChanges off the real diff (never the card's text)", async () => {
    const runGit = vi.fn(async () => ({
      stdout: "src/Button.tsx\nprisma/schema.prisma\nsrc/persistence/migrations/017_x.sql\n",
      stderr: "",
    }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({
      isUI: true,
      dataChanges: true,
      changedFiles: ["src/Button.tsx", "prisma/schema.prisma", "src/persistence/migrations/017_x.sql"],
    });
  });

  it("isUI/dataChanges are both false for a diff touching neither UI nor data files", async () => {
    const runGit = vi.fn(async () => ({ stdout: "src/util/helpers.ts\n", stderr: "" }));
    const runVerify = vi.fn(async () => passingResults);
    const handler = makeVerify(baseDeps({ runGit, runVerify }));

    const r = await handler({ inputs, outputs: { preparation: preparationFixture() }, executionId: "e1", stateId: "verify" });

    expect(r).toMatchObject({ isUI: false, dataChanges: false });
  });
});
