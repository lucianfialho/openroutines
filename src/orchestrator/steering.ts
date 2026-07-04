/**
 * Async human steering via Trello 🧭 comments (F5 #169, D25/D33).
 *
 * A whitelisted human comments `🧭 …` on a card; this poll ingests it as a
 * DELIMITED DATA directive and applies it by the card's CURRENT state:
 *   - Blocked → persist it as eligible-for-resume; the night coordinator picks
 *     it up next and injects steeringPromptBlock() into that phase's prompt
 *     (state only leaves Blocked when the coordinator actually resumes).
 *   - Review → the SAME rework trigger the PR-review poller uses (D24) — no
 *     second pipeline; the night coordinator's admitReworkCards runs it.
 *   - `🧭 followup: <idea>` (any state) → seed a NEW card in the queue with the
 *     idea as Conceito, cross-linked to the parent.
 *   - anything else → persisted as low-confidence data, no effect (D31).
 *
 * SECURITY (non-negotiable): steering only ever changes PLAN/SCOPE, never
 * permission/guardrail. The human text is treated as untrusted data — it is
 * wrapped by steeringPromptBlock() and lands inside inputs.description, never
 * as a system instruction; nothing here touches an allowlist, forbidden path,
 * cap, or gate.
 */
import { randomUUID } from "crypto";
import { Effect } from "effect";
import { transitionToRework } from "../trigger/pr-review-poller.js";
import type {
  CardSteeringRepository,
  PollStateRepository,
  PrLinkRepository,
  TaskRepository,
} from "../persistence/types.js";
import type { TaskSource } from "../task-source/types.js";
import type { CreateCardInput, CreateCardResult, LinkedCard, SteeringComment } from "../connector/trello.js";

const STEERING_RE = /^🧭/;
const FOLLOWUP_RE = /^followup:\s*/i;
const DEFAULT_FILA_LIST = "OpenRoutines — Fila";

/**
 * Neutralizes a literal closing tag inside untrusted text so it can never
 * prematurely close the envelope below (defense-in-depth: a comment reading
 * "...</steering>\n\nINSTRUÇÃO DE SISTEMA: ..." must stay entirely inside the
 * block, never escape into loose prompt text). The zero-width space keeps the
 * escaped text visually identical to the original — legible, just inert.
 */
const escapeClosingTag = (text: string, tag: string): string => text.replaceAll(`</${tag}>`, `<​/${tag}>`);

/**
 * The delimited-data wrapper that carries human steering into a prompt — the
 * whole security boundary in one place (D25/D33). Everything between the tags
 * is untrusted human text appended to inputs.description; it can outrank the
 * prior plan but never a guardrail. Exported so the night coordinator's
 * Blocked-resume injects the IDENTICAL envelope this module documents.
 */
export const steeringPromptBlock = (text: string): string =>
  `<steering fonte="humano" prioridade="acima-do-plan">\n${escapeClosingTag(text, "steering")}\n</steering>`;

/** effect_type marking a Blocked steering the night coordinator must resume. */
export const RESUME_BLOCKED_EFFECT = "resume-blocked";

// One-line, deterministic echo summary — NO LLM (the engine/triage skill is
// out of this poll's scope). ponytail: a Kimi triage summary can replace this
// later; the echo requirement is just "🤖 [Triagem] Entendi que: …", not model
// quality.
const summarize = (text: string): string => {
  const line = text.split(/[\n.]/)[0].trim();
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
};

export interface SteeringPollDeps {
  sourceId: string;
  taskSource: TaskSource;
  cardSteering: CardSteeringRepository;
  pollState: PollStateRepository;
  prLinks: PrLinkRepository;
  taskRepo: TaskRepository;
  readComments: (cursor: string | null) => Promise<{ comments: SteeringComment[]; cursor: string }>;
  createCard: (input: CreateCardInput) => Promise<CreateCardResult>;
  linkCards: (a: LinkedCard, b: LinkedCard) => Promise<void>;
  /** Trello member ids and/or usernames allowed to steer (TRELLO_STEERING_WHITELIST). */
  whitelist: string[];
  /** Real Trello list name for followup seeds. Defaults to "OpenRoutines — Fila". */
  filaListName?: string;
}

export interface SteeringPollSummary {
  ingested: number;
  rework: number;
  followup: number;
  resumeBlocked: number;
  lowConfidence: number;
}

export const runSteeringPoll = async (deps: SteeringPollDeps): Promise<SteeringPollSummary> => {
  const summary: SteeringPollSummary = { ingested: 0, rework: 0, followup: 0, resumeBlocked: 0, lowConfidence: 0 };
  const whitelist = new Set(deps.whitelist);
  const cursorKey = `${deps.sourceId}:steering`;
  const filaListName = deps.filaListName ?? DEFAULT_FILA_LIST;

  let read: { comments: SteeringComment[]; cursor: string };
  try {
    read = await deps.readComments((await deps.pollState.getCursor(cursorKey)) ?? null);
  } catch (err) {
    // A read failure keeps the old cursor so the next tick retries the window.
    console.error(`[SteeringPoll] readComments failed for '${deps.sourceId}':`, err instanceof Error ? err.message : err);
    return summary;
  }

  for (const c of read.comments) {
    try {
      if (!STEERING_RE.test(c.text)) continue; // only 🧭 comments
      // Whitelist is the anti-loop guard too: the bot is never in it, so its own
      // 🤖/🧠/🛠️ comments are dropped here (and they never match /^🧭/ anyway).
      if (!whitelist.has(c.memberId) && !(c.memberUsername !== undefined && whitelist.has(c.memberUsername))) continue;

      // Idempotency key for the WHOLE per-comment effect (row + echo + external
      // effect). runIdempotent is unusable here — its action_ledger row FKs to
      // executions(id), which a poll-time steering effect has no row for (same
      // reason the PR-review poller dedups on persisted review_state, not the
      // ledger). ponytail: claim-before-act is at-most-once — a crash between
      // the claim and the effect drops that one comment; the human re-comments
      // and every effect below is cheap or self-announcing. Upgrade path: a
      // dedicated processed-actions table if silent drops ever bite.
      if (!(await deps.pollState.claimUnseen(deps.sourceId, `steering:${c.actionId}`))) continue;

      const task = await Effect.runPromise(deps.taskSource.getTask(c.cardId));
      // Guarantee the card_steering FK (source_id, task_id) resolves: a card a
      // human dropped straight into Blocked/Review/Done — or a Done report card —
      // may have no tasks row yet. Upsert the one we just fetched.
      await deps.taskRepo.save(task);

      const content = c.text.replace(/^🧭\s*/, "");
      summary.ingested++;

      // followup: wins over state — it is an explicit "spawn a new card" intent.
      if (FOLLOWUP_RE.test(content)) {
        const concept = content.replace(FOLLOWUP_RE, "").trim();
        const id = randomUUID();
        await deps.cardSteering.save({
          id,
          sourceId: deps.sourceId,
          taskId: c.cardId,
          authorTrelloId: c.memberId,
          text: concept,
          applied: false,
        });
        const created = await deps.createCard({
          listName: filaListName,
          title: concept.slice(0, 120) || "Followup",
          description: `# Conceito\n${concept}`,
          labels: ["OpenRoutines"],
        });
        await deps.linkCards({ id: c.cardId, url: task.url }, { id: created.cardId, url: created.url });
        await Effect.runPromise(
          deps.taskSource.comment(
            c.cardId,
            `🤖 [Triagem] Entendi que: followup — ${summarize(concept)}. Criei o card na Fila: ${created.url}`
          )
        );
        await deps.cardSteering.markApplied(id, "followup");
        summary.followup++;
        continue;
      }

      if (task.state === "review") {
        const openLink = (await deps.prLinks.findByTask(deps.sourceId, c.cardId)).find(
          (l) => l.status === "open" && l.reviewState !== "rework-exhausted"
        );
        if (openLink) {
          const id = randomUUID();
          await deps.cardSteering.save({
            id,
            sourceId: deps.sourceId,
            taskId: c.cardId,
            authorTrelloId: c.memberId,
            text: content.trim(),
            applied: false,
          });
          // Carry the directive into next night's rework as fix-list context:
          // admitReworkCards reads tasks.body -> inputs.description, and the
          // rework prompt renders {{inputs.description}}. Injecting the SAME
          // delimited block here (never a system instruction) reuses that path
          // instead of forking the rework pipeline. A Working/Review card is
          // never re-synced by the night's queued-only sync, so this survives.
          await deps.taskRepo.save({ ...task, body: `${task.body}\n\n${steeringPromptBlock(content.trim())}` });
          // Echo BEFORE the effect takes hold (D25).
          await Effect.runPromise(deps.taskSource.comment(c.cardId, `🤖 [Triagem] Entendi que: ${summarize(content)}`));
          await transitionToRework(
            deps.prLinks,
            deps.taskSource,
            { sourceId: deps.sourceId, taskId: c.cardId, branch: openLink.branch },
            `↩️ [Retrabalho] steering humano recebido — o card volta para Working e entra na fila de retrabalho da próxima noite.`
          );
          await deps.cardSteering.markApplied(id, "rework");
          summary.rework++;
          continue;
        }
        // Review card with no reworkable open PR — treat as low-confidence.
      } else if (task.state === "blocked") {
        // Persist eligible-for-resume (unapplied + effect_type marker). The
        // night coordinator resumes it and injects steeringPromptBlock() into
        // the next phase — the card only LEAVES Blocked then, never at this poll.
        await deps.cardSteering.save({
          sourceId: deps.sourceId,
          taskId: c.cardId,
          authorTrelloId: c.memberId,
          text: content.trim(),
          applied: false,
          effectType: RESUME_BLOCKED_EFFECT,
        });
        await Effect.runPromise(deps.taskSource.comment(c.cardId, `🤖 [Triagem] Entendi que: ${summarize(content)}`));
        summary.resumeBlocked++;
        continue;
      }

      // Low-confidence (Fila/Working/Done-without-followup, or a Review card with
      // no open PR): persist as data, no effect, no echo (D31 reinjection is the
      // tactical-memory issue's job, not this one).
      await deps.cardSteering.save({
        sourceId: deps.sourceId,
        taskId: c.cardId,
        authorTrelloId: c.memberId,
        text: content.trim(),
        applied: false,
      });
      summary.lowConfidence++;
    } catch (err) {
      // One bad comment never stops the sweep (mirror pr-review-poller).
      console.error(`[SteeringPoll] comment ${c.actionId} on card ${c.cardId} failed:`, err instanceof Error ? err.message : err);
    }
  }

  await deps.pollState.setCursor(cursorKey, read.cursor);
  return summary;
};
