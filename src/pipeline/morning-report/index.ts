/**
 * morning-report script handlers (F4 #159).
 *
 * Wires the 3 deterministic (`type: script`) states of
 * `.gates/skills/morning-report/skill.yaml` into a ScriptRegistry, following
 * the same shape as card-to-pr's index.ts (registerCardToPrHandlers): deps
 * injected as closures, one seam per external effect so tests never need a
 * real Postgres/Trello.
 *
 *   coletar_dados     -> resolves today's night_runs row, calls gatherMorningReportData
 *   montar_relatorio  -> calls renderMorningReportCard
 *   publicar_card     -> creates (once/day, guarded by night_runs.report_card_id)
 *                        or reuses the digest card, posts the body as a comment
 */
import { Effect } from "effect";
import type { Pool } from "pg";
import type { ScriptHandler, ScriptRegistry } from "../../script/registry.js";
import type { TaskSource } from "../../task-source/types.js";
import { dateInTz } from "../../night-coordinator/run.js";
import { gatherMorningReportData, renderMorningReportCard, MORNING_REPORT_PREFIX, type MorningReportData } from "../../report/morning-report.js";

/**
 * TaskSource (src/task-source/types.ts) manages EXISTING cards only
 * (listQueue/comment/moveTo/...) — there is no createCard primitive, and the
 * report needs exactly one brand-new card a day, so this is a single raw
 * Trello POST rather than a new TaskSource capability. Resolves the target
 * list by name (one GET), same shape as trello.ts's own list lookup.
 */
export interface TrelloCreateCardConfig {
  boardId: string;
  listName: string;
  apiKey: string;
  apiToken: string;
}

/** ponytail: reuses the existing "Done" column; a dedicated report list isn't worth new connector.yaml surface today. */
export const MORNING_REPORT_TRELLO_LIST = "Done";

export const makeTrelloCreateCard =
  (cfg: TrelloCreateCardConfig) =>
  async (title: string): Promise<{ id: string; url: string }> => {
    const auth = `key=${encodeURIComponent(cfg.apiKey)}&token=${encodeURIComponent(cfg.apiToken)}`;
    const listsRes = await fetch(`https://api.trello.com/1/boards/${encodeURIComponent(cfg.boardId)}/lists?filter=open&fields=id,name&${auth}`);
    if (!listsRes.ok) throw new Error(`morning-report: failed to resolve Trello lists (${listsRes.status})`);
    const lists = (await listsRes.json()) as Array<{ id: string; name: string }>;
    const list = lists.find((l) => l.name === cfg.listName);
    if (!list) throw new Error(`morning-report: Trello list '${cfg.listName}' not found on board ${cfg.boardId}`);
    const cardRes = await fetch(
      `https://api.trello.com/1/cards?idList=${encodeURIComponent(list.id)}&name=${encodeURIComponent(title)}&${auth}`,
      { method: "POST" }
    );
    if (!cardRes.ok) throw new Error(`morning-report: failed to create Trello card (${cardRes.status})`);
    const card = (await cardRes.json()) as { id: string; shortUrl: string };
    return { id: card.id, url: card.shortUrl };
  };

export interface MorningReportDeps {
  pool: Pool;
  /** Coordinator timezone (same value as night-coordinator's `tz`) — resolves "today" for the night_runs lookup. */
  tz: string;
  taskSourceFor: (sourceId: string) => TaskSource | undefined;
  /** Which configured TaskSource receives the digest comment. */
  sourceId: string;
  /** Creates a brand-new Trello card; called at most once per night_runs row (guarded by report_card_id). */
  createCard: (title: string) => Promise<{ id: string; url?: string }>;
  /** slug -> "owner/name" (repo-registry) for building real PR URLs in the report. */
  resolveGithubRepo?: (slug: string) => string | undefined;
  now?: () => Date;
}

interface ColetarDadosOutput {
  nightId: string | null;
  data?: MorningReportData;
}

export const makeColetarDados = (deps: MorningReportDeps): ScriptHandler => async () => {
  const now = deps.now ?? (() => new Date());
  const date = dateInTz(now(), deps.tz);
  const { rows } = await deps.pool.query(`SELECT id FROM night_runs WHERE date = $1`, [date]);
  const nightId = (rows[0]?.id as string | undefined) ?? null;
  if (!nightId) {
    return { nightId: null };
  }
  const data = await gatherMorningReportData(deps.pool, nightId, { resolveGithubRepo: deps.resolveGithubRepo });
  return { nightId, data };
};

const NO_NIGHT_BODY = `${MORNING_REPORT_PREFIX}\n\nNenhuma execução noturna encontrada para hoje (a rotina de 01:00 não rodou ou ainda não terminou).`;

export const makeMontarRelatorio = (): ScriptHandler => async (ctx) => {
  const coletado = ctx.outputs.coletar_dados as ColetarDadosOutput;
  if (!coletado.nightId || !coletado.data) {
    return { title: "📊 Relatório matinal", body: NO_NIGHT_BODY };
  }
  return renderMorningReportCard(coletado.data);
};

export const makePublicarCard = (deps: MorningReportDeps): ScriptHandler => async (ctx) => {
  const montado = ctx.outputs.montar_relatorio as { title: string; body: string };
  const coletado = ctx.outputs.coletar_dados as ColetarDadosOutput;

  // Idempotency guard: night_runs.report_card_id is set at most once per
  // night (re-running the routine the same day reuses the same card instead
  // of creating a duplicate). On a night with no night_runs row at all there
  // is no guard key to persist against — a rare ops scenario (the whole app
  // was down all night); see report/morning-report.ts's own docstring for
  // the related metadata gap.
  // ponytail: a repeated MANUAL trigger on such a day can create more than
  // one placeholder card — acceptable, the daily cron only fires once.
  let cardId: string | undefined;
  if (coletado.nightId) {
    const { rows } = await deps.pool.query(`SELECT report_card_id FROM night_runs WHERE id = $1`, [coletado.nightId]);
    cardId = (rows[0]?.report_card_id as string | null) ?? undefined;
  }

  if (!cardId) {
    const created = await deps.createCard(montado.title);
    cardId = created.id;
    if (coletado.nightId) {
      await deps.pool.query(`UPDATE night_runs SET report_card_id = $1 WHERE id = $2`, [cardId, coletado.nightId]);
    }
  }

  const ts = deps.taskSourceFor(deps.sourceId);
  if (ts) {
    // A duplicate comment on a re-run is acceptable — same idempotency
    // philosophy as card-to-pr/pr.ts's handoff comment: the card identity is
    // the guarded part, not every individual comment.
    await Effect.runPromise(ts.comment(cardId, montado.body));
  }

  return { cardId, published: Boolean(ts) };
};

export const registerMorningReportHandlers = (reg: ScriptRegistry, deps: MorningReportDeps): void => {
  reg.register("morning-report-coletar-dados", makeColetarDados(deps));
  reg.register("morning-report-montar-relatorio", makeMontarRelatorio());
  reg.register("morning-report-publicar-card", makePublicarCard(deps));
};
