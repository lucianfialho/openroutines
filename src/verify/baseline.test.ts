import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasTestDb, makeTestPool, ensureSchema, uniqueDate, cleanupNight } from "../persistence/db.test-helpers.js";
import { acquireNightLock } from "../night-coordinator/lock.js";
import type { RepoConfig } from "../repo-registry/schema.js";
import { getOrCreateBaseline } from "./baseline.js";
import { emptySastResult, type SastResult } from "./sast.js";

// execFile is wrapped (not fully faked) so getOrCreateBaseline still does REAL
// git/echo work against a real temp repo — we only need the call count, per
// AC2 ("segunda chamada não reexecuta os comandos — spy de execFile com 0
// chamadas"). execFile has its own promisify.custom (bundles stdout+stderr);
// a transparent wrapper would lose it, so the wrapped callback re-bundles it
// by hand for the promisified callers in baseline.ts/run-commands.ts.
const state = vi.hoisted(() => ({ execFileCalls: 0 }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], options: any, callback: any) => {
      state.execFileCalls++;
      return (actual as any).execFile(file, args, options, (err: any, stdout: any, stderr: any) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          callback(err);
        } else {
          callback(null, { stdout, stderr });
        }
      });
    },
  };
});

/** A real one-commit git repo, so checkout + rev-parse in baseline.ts do real work. */
const makeTempRepo = (): { dir: string; branch: string } => {
  const dir = mkdtempSync(join(tmpdir(), "or-verify-baseline-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "hi");
  execFileSync("git", ["add", "f.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim();
  return { dir, branch };
};

const makeRepoConfig = (clonePath: string, baseBranch: string, verify: RepoConfig["verify"]): RepoConfig => ({
  clonePath,
  githubRepo: "test-org/test-repo",
  baseBranch,
  verify,
});

describe.skipIf(!hasTestDb())("getOrCreateBaseline (real DB)", () => {
  const pool = makeTestPool();
  const created: string[] = [];
  const tempDirs: string[] = [];
  // These tests are about the build/test baseline machinery, not SAST — stub
  // runSast so they never spawn a real semgrep/gitleaks/npm audit (no
  // real network calls in tests) and stay fast/deterministic.
  const stubRunSast = async (): Promise<SastResult> => emptySastResult();

  beforeEach(() => {
    state.execFileCalls = 0;
  });

  afterAll(async () => {
    for (const id of created) await cleanupNight(pool, id);
    await pool.end();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("first call runs verify against the base branch and persists 1 row (AC1); second call reuses it without re-running anything (AC2)", async () => {
    await ensureSchema(pool);
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    expect(lock).not.toBeNull();
    const nightId = lock!.nightId;
    created.push(nightId);

    const { dir, branch } = makeTempRepo();
    tempDirs.push(dir);
    const repoConfig = makeRepoConfig(dir, branch, { build: "echo build-ok", test: "echo test-ok" });
    const repo = "verify-baseline-repo";

    const first = await getOrCreateBaseline({ pool, runSast: stubRunSast }, { repo, nightId, repoConfig });
    expect(first.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.results.build?.passed).toBe(true);
    expect(first.results.test?.passed).toBe(true);
    expect(state.execFileCalls).toBeGreaterThan(0); // checkout + rev-parse + build + test

    const { rows } = await pool.query(
      "SELECT * FROM verify_baselines WHERE repo = $1 AND night_id = $2",
      [repo, nightId]
    );
    expect(rows).toHaveLength(1);

    state.execFileCalls = 0;
    const second = await getOrCreateBaseline({ pool, runSast: stubRunSast }, { repo, nightId, repoConfig });
    expect(state.execFileCalls).toBe(0); // cached — no checkout, no verify commands
    expect(second).toEqual(first);
  });

  it("a simulated race for the same (repo, nightId) yields exactly 1 row and no unhandled unique-violation (AC5)", async () => {
    await ensureSchema(pool);
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    expect(lock).not.toBeNull();
    const nightId = lock!.nightId;
    created.push(nightId);

    // Two independent clones of the same commit so the two concurrent
    // `git checkout` calls never touch the same working directory (a genuine
    // git-level lock race, confirmed separately — not what this test is
    // about; see the shared-clone NOTE in baseline.ts).
    const { dir: origin, branch } = makeTempRepo();
    tempDirs.push(origin);
    const dirA = mkdtempSync(join(tmpdir(), "or-verify-baseline-clone-"));
    const dirB = mkdtempSync(join(tmpdir(), "or-verify-baseline-clone-"));
    tempDirs.push(dirA, dirB);
    execFileSync("git", ["clone", "-q", origin, dirA]);
    execFileSync("git", ["clone", "-q", origin, dirB]);

    const repo = "verify-baseline-race-repo";
    const configA = makeRepoConfig(dirA, branch, { build: "echo a", test: "echo a" });
    const configB = makeRepoConfig(dirB, branch, { build: "echo b", test: "echo b" });

    const [a, b] = await Promise.all([
      getOrCreateBaseline({ pool, runSast: stubRunSast }, { repo, nightId, repoConfig: configA }),
      getOrCreateBaseline({ pool, runSast: stubRunSast }, { repo, nightId, repoConfig: configB }),
    ]);

    // Both callers converge on the SAME winner row — proves the loser re-read
    // instead of keeping its own locally-computed (and different) results.
    expect(a).toEqual(b);

    const { rows } = await pool.query(
      "SELECT * FROM verify_baselines WHERE repo = $1 AND night_id = $2",
      [repo, nightId]
    );
    expect(rows).toHaveLength(1);
  });

  it("F4 #155: captures a SAST snapshot alongside build/test on first call and persists it in the same results JSONB", async () => {
    await ensureSchema(pool);
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    expect(lock).not.toBeNull();
    const nightId = lock!.nightId;
    created.push(nightId);

    const { dir, branch } = makeTempRepo();
    tempDirs.push(dir);
    const repoConfig = makeRepoConfig(dir, branch, { build: "echo build-ok", test: "echo test-ok" });
    const repo = "verify-baseline-sast-repo";
    const fakeSast: SastResult = {
      ...emptySastResult(),
      semgrepFindings: [{ ruleId: "prisma-raw-unsafe", file: "a.ts", line: 1, message: "m", severity: "ERROR" }],
    };

    const first = await getOrCreateBaseline(
      { pool, runSast: async () => fakeSast },
      { repo, nightId, repoConfig }
    );
    expect(first.results.sast).toEqual(fakeSast);

    // Cached read (2nd call) must return the same persisted snapshot without
    // calling runSast again — a distinct fake would prove that if it fired.
    const second = await getOrCreateBaseline(
      { pool, runSast: async () => ({ ...emptySastResult(), notes: ["should never be seen"] }) },
      { repo, nightId, repoConfig }
    );
    expect(second.results.sast).toEqual(fakeSast);
  });

  it("F4 #155: a pre-#155 baseline row with no sast key reads back as sast: undefined, not a crash", async () => {
    await ensureSchema(pool);
    const lock = await acquireNightLock(pool, uniqueDate(), { budgetCapUsd: 30, prCap: 6 });
    expect(lock).not.toBeNull();
    const nightId = lock!.nightId;
    created.push(nightId);

    const repo = "verify-baseline-legacy-repo";
    // Bypasses getOrCreateBaseline entirely to simulate a row written before
    // #155 added the sast field — old results JSONB has no "sast" key at all.
    await pool.query(
      `INSERT INTO verify_baselines (repo, night_id, base_sha, results) VALUES ($1, $2, $3, $4)`,
      [repo, nightId, "0".repeat(40), JSON.stringify({ build: { passed: true }, test: { passed: true } })]
    );

    const { dir, branch } = makeTempRepo();
    tempDirs.push(dir);
    const repoConfig = makeRepoConfig(dir, branch, { build: "echo build-ok", test: "echo test-ok" });

    const baseline = await getOrCreateBaseline({ pool, runSast: stubRunSast }, { repo, nightId, repoConfig });

    expect(baseline.results.sast).toBeUndefined();
    expect(baseline.results.build?.passed).toBe(true);
  });
});
