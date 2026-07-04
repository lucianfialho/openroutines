/**
 * PostgreSQL Repo Learnings Repository
 *
 * Mined facts about a repo, deduped per (repo, normalized fato) — see
 * migration 018 for why the normalization lives in a generated column
 * instead of an app-side ON CONFLICT expression (F5 #166).
 */
import type { Pool } from "pg";
import type { RepoLearning, RepoLearningRepository } from "./types.js";

export const makePostgresRepoLearningRepository = (pool: Pool): RepoLearningRepository => {
  return {
    upsertByFato: async (repo, input) => {
      await pool.query(
        `INSERT INTO repo_learnings (repo, fato, evidencia, escopo, visto_em, freq)
         VALUES ($1, $2, $3, $4, ARRAY[NOW()], 1)
         ON CONFLICT (repo, fato_normalized) DO UPDATE SET
           freq = repo_learnings.freq + 1,
           visto_em = array_append(repo_learnings.visto_em, NOW()),
           evidencia = COALESCE(EXCLUDED.evidencia, repo_learnings.evidencia),
           escopo = COALESCE(EXCLUDED.escopo, repo_learnings.escopo)`,
        [repo, input.fato, input.evidencia ?? null, input.escopo ?? null]
      );
    },
    findTopByRepo: async (repo, n) => {
      const { rows } = await pool.query(
        `SELECT * FROM repo_learnings WHERE repo = $1 ORDER BY freq DESC LIMIT $2`,
        [repo, n]
      );
      return rows.map(rowToLearning);
    },
    findPromotable: async () => {
      const { rows } = await pool.query(
        `SELECT * FROM repo_learnings WHERE freq >= 3 AND promoted_to_profile = FALSE`
      );
      return rows.map(rowToLearning);
    },
    markPromoted: async (id) => {
      await pool.query(`UPDATE repo_learnings SET promoted_to_profile = TRUE WHERE id = $1`, [id]);
    },
  };
};

const rowToLearning = (row: Record<string, unknown>): RepoLearning => ({
  id: row.id as string,
  repo: row.repo as string,
  fato: row.fato as string,
  evidencia: (row.evidencia as string) ?? undefined,
  escopo: (row.escopo as string) ?? undefined,
  vistoEm: (row.visto_em as Date[]) ?? [],
  freq: Number(row.freq),
  promotedToProfile: Boolean(row.promoted_to_profile),
});
