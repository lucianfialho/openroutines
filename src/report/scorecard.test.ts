/**
 * Weekly triage scorecard tests (F5 #167).
 *
 * buildWeeklyScorecard's aggregation is a GLOBAL query (no night_id/source_id
 * scoping key to isolate it, unlike morning-report.ts's per-night reads), so
 * the primary suite here is a mocked pool with a synthetic fixture — fast,
 * deterministic, and immune to whatever other test files concurrently write
 * into the shared `executions`/`tasks` tables. The one real-DB test uses a
 * far-future window (year 2050) instead of `night_id` to get the same
 * isolation against genuine SQL/schema mistakes a mock can't catch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { readFileSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { buildWeeklyScorecard, writeTriageFewShots, loadTriageFewShotsSection } from "./scorecard.js";
import { hasTestDb, makeTestPool, ensureSchema } from "../persistence/db.test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type MockRow = Record<string, unknown>;

const makeMockPool = (opts: { execRows: MockRow[]; retryRows?: MockRow[] }): Pool => {
  const query = async (sql: string) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT e.id")) return { rows: opts.execRows };
    if (text.startsWith("SELECT execution_id")) return { rows: opts.retryRows ?? [] };
    throw new Error(`unexpected query in test: ${text}`);
  };
  return { query } as unknown as Pool;
};

const execRow = (overrides: Partial<MockRow> = {}): MockRow => ({
  id: randomUUID(),
  source_id: "s",
  task_id: `t-${randomUUID()}`,
  repo: "acme-widgets",
  realized_complexity: null,
  alta_impl_escalated: false,
  started_at: new Date("2026-06-15T00:00:00Z"),
  proposed_complexity: null,
  type: "implementation",
  labels: [],
  ...overrides,
});

const tmpFewShotsPath = (): string => join(mkdtempSync(join(tmpdir(), "scorecard-test-")), "triage-fewshots.md");

describe("buildWeeklyScorecard — confusion matrix (AC1)", () => {
  it("5 executions (2 low->medium via retry+escalation, 3 matching) -> 2 in the Low×Medium cell, 3 on the diagonal", async () => {
    const execRows: MockRow[] = [
      execRow({ id: "e1", task_id: "t1", proposed_complexity: "low", realized_complexity: "medium", alta_impl_escalated: true }),
      execRow({ id: "e2", task_id: "t2", proposed_complexity: "low", realized_complexity: "medium", alta_impl_escalated: true }),
      execRow({ id: "e3", task_id: "t3", proposed_complexity: "medium", realized_complexity: "medium" }),
      execRow({ id: "e4", task_id: "t4", repo: "beta-app", type: "research", proposed_complexity: "high", realized_complexity: "high" }),
      execRow({ id: "e5", task_id: "t5", repo: "beta-app", type: "update", proposed_complexity: "lowest", realized_complexity: "lowest" }),
    ];
    const pool = makeMockPool({ execRows });

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    const lowMedium = report.confusionMatrix.find((c) => c.proposedComplexity === "low" && c.realizedComplexity === "medium");
    expect(lowMedium?.count).toBe(2);

    const diagonalTotal = report.confusionMatrix
      .filter((c) => c.proposedComplexity === c.realizedComplexity)
      .reduce((sum, c) => sum + c.count, 0);
    expect(diagonalTotal).toBe(3);
  });

  it("flags alta_impl_escalated=true cases the triage's altaImpl label didn't predict", async () => {
    const execRows: MockRow[] = [
      execRow({ id: "e1", task_id: "t1", proposed_complexity: "low", realized_complexity: "medium", alta_impl_escalated: true, labels: [] }),
      execRow({ id: "e2", task_id: "t2", proposed_complexity: "low", realized_complexity: "medium", alta_impl_escalated: true, labels: ["altaImpl"] }),
    ];
    const pool = makeMockPool({ execRows });

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    expect(report.unpredictedAltaImpl).toHaveLength(1);
    expect(report.unpredictedAltaImpl[0]).toMatchObject({ taskId: "t1" }); // t2 was predicted (labels has altaImpl) — excluded
  });

  it("ignores rows missing either side of the comparison (no crash, just excluded from the matrix)", async () => {
    const execRows: MockRow[] = [
      execRow({ task_id: "no-realized", proposed_complexity: "low", realized_complexity: null }),
      execRow({ task_id: "no-proposed", proposed_complexity: null, realized_complexity: "high" }),
    ];
    const pool = makeMockPool({ execRows });

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    expect(report.confusionMatrix).toEqual([]);
  });
});

describe("buildWeeklyScorecard — recurringErrors (AC2)", () => {
  it("a repo-prefix+type pattern underestimated >=2 times generates 1 entry with a non-empty suggestedFewShot", async () => {
    const execRows: MockRow[] = [
      execRow({ id: "e1", task_id: "t1", repo: "eai-garcom-agent", type: "implementation", proposed_complexity: "low", realized_complexity: "medium" }),
      execRow({ id: "e2", task_id: "t2", repo: "eai-prefeito-agent", type: "implementation", proposed_complexity: "low", realized_complexity: "high" }),
    ];
    const pool = makeMockPool({ execRows });

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    expect(report.recurringErrors).toHaveLength(1);
    expect(report.recurringErrors[0].pattern).toBe("eai:implementation");
    expect(report.recurringErrors[0].examples).toHaveLength(2);
    expect(report.recurringErrors[0].suggestedFewShot.length).toBeGreaterThan(0);
  });

  it("a single occurrence of a pattern does NOT generate a recurringErrors entry", async () => {
    const execRows: MockRow[] = [
      execRow({ task_id: "t1", repo: "foo-bar", type: "implementation", proposed_complexity: "low", realized_complexity: "highest" }),
    ];
    const pool = makeMockPool({ execRows });

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    expect(report.recurringErrors).toEqual([]);
  });

  it("does not treat an over-estimation (proposed higher than realized) as an underestimation pattern", async () => {
    const execRows: MockRow[] = [
      execRow({ task_id: "t1", repo: "foo-bar", type: "implementation", proposed_complexity: "high", realized_complexity: "low" }),
      execRow({ task_id: "t2", repo: "foo-bar", type: "implementation", proposed_complexity: "high", realized_complexity: "low" }),
    ];
    const pool = makeMockPool({ execRows });

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    expect(report.recurringErrors).toEqual([]);
  });
});

describe("buildWeeklyScorecard — retriedExecutions", () => {
  it("reports an execution whose run_states re-entered the same state (>1 attempt) as retries>0, keyed to its proposed complexity", async () => {
    const execRows: MockRow[] = [execRow({ id: "e1", task_id: "t1", proposed_complexity: "medium" })];
    const pool = makeMockPool({ execRows, retryRows: [{ execution_id: "e1", retries: "2" }] }); // pg returns bigint arithmetic as a string

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    expect(report.retriedExecutions).toEqual([{ sourceId: "s", taskId: "t1", proposedComplexity: "medium", retries: 2 }]);
  });
});

describe("triage-fewshots.md file (AC3: idempotent) + prompt seam (AC4)", () => {
  it("running buildWeeklyScorecard() twice on the same dataset writes byte-identical file content", async () => {
    const execRows: MockRow[] = [
      execRow({ id: "e1", task_id: "t1", repo: "eai-garcom-agent", type: "implementation", proposed_complexity: "low", realized_complexity: "medium" }),
      execRow({ id: "e2", task_id: "t2", repo: "eai-prefeito-agent", type: "implementation", proposed_complexity: "low", realized_complexity: "medium" }),
    ];
    const pool = makeMockPool({ execRows });
    const path = tmpFewShotsPath();

    await buildWeeklyScorecard(pool, { fewShotsPath: path });
    const first = readFileSync(path, "utf-8");
    await buildWeeklyScorecard(pool, { fewShotsPath: path });
    const second = readFileSync(path, "utf-8");

    expect(second).toBe(first);
    expect(first).toContain("eai-*");
  });

  it("keeps only the top-3 most recent recurring errors", async () => {
    const makePair = (repo: string, type: string, daysAgo: number): MockRow[] => [
      execRow({ task_id: `${repo}-a`, repo, type, proposed_complexity: "low", realized_complexity: "medium", started_at: new Date(Date.now() - daysAgo * 86_400_000) }),
      execRow({ task_id: `${repo}-b`, repo, type, proposed_complexity: "low", realized_complexity: "medium", started_at: new Date(Date.now() - daysAgo * 86_400_000) }),
    ];
    const execRows = [
      ...makePair("aaa-one", "implementation", 1),
      ...makePair("bbb-two", "implementation", 5),
      ...makePair("ccc-three", "implementation", 10),
      ...makePair("ddd-four", "implementation", 15),
    ];
    const pool = makeMockPool({ execRows });

    const report = await buildWeeklyScorecard(pool, { fewShotsPath: tmpFewShotsPath() });

    expect(report.recurringErrors).toHaveLength(4); // the report itself carries all patterns...
    const path = tmpFewShotsPath();
    writeTriageFewShots(path, report.recurringErrors.slice(0, 3));
    const written = readFileSync(path, "utf-8");
    // suggestedFewShot only ever embeds the repo-PREFIX glob (e.g. "aaa-*"),
    // never the full repo name ("aaa-one") — see repoPrefix()/buildRecurringErrors.
    expect(written).toContain("aaa-*");
    expect(written).not.toContain("ddd-*"); // ...but the file only keeps the 3 most recent
  });

  it("loadTriageFewShotsSection wraps the file's content when it exists", () => {
    const path = tmpFewShotsPath();
    writeTriageFewShots(path, [{ pattern: "eai:implementation", examples: [], suggestedFewShot: "handler de webhook em eai-* nunca é Low" }]);

    const section = loadTriageFewShotsSection(path);

    expect(section.startsWith("<few_shots_erros_recorrentes>")).toBe(true);
    expect(section).toContain("handler de webhook em eai-* nunca é Low");
    expect(section.trim().endsWith("</few_shots_erros_recorrentes>")).toBe(true);
  });

  it("loadTriageFewShotsSection returns '' without throwing when the file doesn't exist yet (first week, AC4)", () => {
    const missingPath = join(tmpdir(), `does-not-exist-${randomUUID()}.md`);
    expect(() => loadTriageFewShotsSection(missingPath)).not.toThrow();
    expect(loadTriageFewShotsSection(missingPath)).toBe("");
  });
});

describe.skipIf(!hasTestDb())("buildWeeklyScorecard (real DB, end-to-end SQL)", () => {
  const pool = makeTestPool();
  // ponytail: isolation via a far-future window (year 2050) instead of a
  // scoping key — this aggregation has none (it's intentionally global, per
  // #167) — so no other concurrently-running test file's NOW()-stamped rows
  // can ever land inside it. Cheaper than adding a scoping column nobody
  // else needs.
  const now = new Date("2050-06-20T00:00:00Z");
  const startedAt = new Date("2050-06-10T00:00:00Z");
  const sourceId = `scorecard-e2e-${randomUUID()}`;
  const execIds: string[] = [];

  beforeAll(async () => {
    await ensureSchema(pool);
    // run_states isn't part of db.test-helpers' SCHEMA_MIGRATIONS (that list
    // is owned by other suites) — applied directly here rather than editing
    // shared test infra for one file's needs.
    await pool.query(readFileSync(join(__dirname, "../persistence/migrations/004_run_states.sql"), "utf-8"));

    const insertExec = async (taskId: string, proposed: string, realized: string): Promise<string> => {
      const { rows } = await pool.query(
        `INSERT INTO executions (id, routine_id, trigger_type, skill_name, status, started_at, source_id, task_id, repo, realized_complexity)
         VALUES (gen_random_uuid(), 'r', 'card-execution', 'card-to-pr', 'completed', $1, $2, $3, 'eai-garcom-agent', $4) RETURNING id`,
        [startedAt, sourceId, taskId, realized]
      );
      const id = rows[0].id as string;
      execIds.push(id);
      await pool.query(
        `INSERT INTO tasks (source_id, task_id, title, state, type, complexity)
         VALUES ($1, $2, 'Card e2e', 'queued', 'implementation', $3)`,
        [sourceId, taskId, proposed]
      );
      return id;
    };

    const e1 = await insertExec("t1", "low", "medium");
    await insertExec("t2", "low", "medium");

    // e1 re-entered "implementation" twice -> 1 retry; single run_states row = 0 retries.
    await pool.query(
      `INSERT INTO run_states (execution_id, state_id, skill_id, status, started_at) VALUES ($1, 'implementation', 'card-to-pr', 'completed', NOW())`,
      [e1]
    );
    await pool.query(
      `INSERT INTO run_states (execution_id, state_id, skill_id, status, started_at) VALUES ($1, 'implementation', 'card-to-pr', 'completed', NOW())`,
      [e1]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM run_states WHERE execution_id = ANY($1::uuid[])`, [execIds]);
    await pool.query(`DELETE FROM executions WHERE source_id = $1`, [sourceId]);
    await pool.query(`DELETE FROM tasks WHERE source_id = $1`, [sourceId]);
    await pool.end();
  });

  it("reads the real join (executions x tasks x run_states) end-to-end", async () => {
    const report = await buildWeeklyScorecard(pool, { now, fewShotsPath: tmpFewShotsPath() });

    expect(report.confusionMatrix).toEqual([{ proposedComplexity: "low", realizedComplexity: "medium", count: 2 }]);
    expect(report.recurringErrors).toHaveLength(1);
    expect(report.recurringErrors[0].pattern).toBe("eai:implementation");
    expect(report.retriedExecutions).toEqual([{ sourceId, taskId: "t1", proposedComplexity: "low", retries: 1 }]);
  });
});
