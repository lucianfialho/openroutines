/**
 * Real-Postgres test harness (F3).
 *
 * The concurrency primitives (cycle lock, atomic claim, anti-TOCTOU budget
 * reservation) only mean anything against a real transactional database — a
 * mocked `pg` cannot enforce FOR UPDATE row locks or UNIQUE constraints. These
 * tests are therefore gated on TEST_DATABASE_URL: they run with real evidence
 * when a Postgres is present (local dev, the target machine) and skip cleanly in
 * a mock-only CI.
 *
 *   TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/ortest npm test
 */
import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = (): boolean => Boolean(TEST_DB_URL);

export const makeTestPool = (): Pool =>
  new Pool({ connectionString: TEST_DB_URL, max: 16 });

// Only the migrations these tests depend on, in FK order. The gate subsystem's
// migrations (004/007 → gates/run_states) are owned elsewhere and irrelevant here.
const SCHEMA_MIGRATIONS = [
  "001_executions.sql",
  "009_tasks.sql",
  "010_action_ledger.sql",
  "011_night_coordinator.sql",
  "012_verify_baselines.sql",
  "013_pr_links.sql",
  "014_pr_links_rework.sql",
  "015_pr_links_risk.sql",
  "016_tier_circuit_state.sql",
  "017_pr_feedback.sql",
  "018_repo_learnings.sql",
  "019_card_steering.sql",
  "020_day_budget.sql",
  "021_execution_complexity_fields.sql",
];

export const ensureSchema = async (pool: Pool): Promise<void> => {
  for (const file of SCHEMA_MIGRATIONS) {
    const sql = readFileSync(join(__dirname, "migrations", file), "utf-8");
    await pool.query(sql);
  }
};

let seq = 0;
/**
 * Unique valid DATE per call. Vitest runs test files in PARALLEL processes, so a
 * per-process counter alone collides across files on night_runs.date (UNIQUE).
 * A random day-offset over a ~5000-year span makes cross-process collision
 * negligible; +seq guarantees within-process uniqueness even on a repeated draw.
 */
export const uniqueDate = (): string => {
  seq += 1;
  const base = Date.UTC(2100, 0, 1);
  const dayOffset = Math.floor(Math.random() * 1_800_000) + seq;
  return new Date(base + dayOffset * 86_400_000).toISOString().slice(0, 10);
};

/** Minimal execution row so budget_reservations/action_ledger FKs resolve. */
export const insertExecution = async (
  pool: Pool,
  id: string,
  opts: { nightId?: string; repo?: string; status?: string } = {}
): Promise<void> => {
  await pool.query(
    `INSERT INTO executions (id, routine_id, trigger_type, skill_name, status, started_at, night_id, repo)
     VALUES ($1, 'test-routine', 'test', 'card-to-pr', $2, NOW(), $3, $4)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, night_id = EXCLUDED.night_id, repo = EXCLUDED.repo`,
    [id, opts.status ?? "running", opts.nightId ?? null, opts.repo ?? null]
  );
};

/** FK-safe teardown of everything a night created (parallel-test friendly — scoped by nightId). */
export const cleanupNight = async (pool: Pool, nightId: string): Promise<void> => {
  await pool.query(`DELETE FROM budget_reservations WHERE night_id = $1`, [nightId]);
  await pool.query(`DELETE FROM action_ledger WHERE execution_id IN (SELECT id FROM executions WHERE night_id = $1)`, [nightId]);
  await pool.query(`DELETE FROM verify_baselines WHERE night_id = $1`, [nightId]);
  await pool.query(`UPDATE tasks SET claimed_by_night_id = NULL WHERE claimed_by_night_id = $1`, [nightId]);
  await pool.query(`DELETE FROM executions WHERE night_id = $1`, [nightId]);
  await pool.query(`DELETE FROM night_runs WHERE id = $1`, [nightId]);
};
