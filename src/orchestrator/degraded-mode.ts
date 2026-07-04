/**
 * Degraded-mode gate — repos without docs/REPO-PROFILE.md (F5 #163, D11).
 *
 * D11 (.openroutines/08-DECISOES-E-RISCOS.md): "repo sem Repo Profile bloqueia
 * implementação (agenda mapeamento primeiro); exceção só pra Lowest". Without
 * a profile the agent re-explores the repo from scratch (expensive) and gets
 * convention wrong — "erro nº1" of manual sessions. Two independent halves:
 *
 *   - `checkProfileAndBlock` — the TRIAGE-time gate (before night-run, so a
 *     missing profile never burns night budget in Preparação). Skips
 *     Pesquisa/Mapeamento cards (read-only, need no profile) and Lowest cards
 *     that structurally declare they only touch an allowlisted path (README/
 *     docs/i18n — same "never decided by card prose" determinism principle
 *     Verify's own scope gate uses). Otherwise: find-or-create ONE open
 *     Mapping card for the repo (never duplicates), cross-link it to the
 *     blocked card (makeTrelloLinkCards), move the original to Blocked. No
 *     Telegram alert — `repo-missing-profile` is not a `security*` blockReason
 *     (.openroutines/10-ESTADOS-DAS-TAREFAS.md), so this module never imports
 *     notify/telegram.ts at all.
 *
 *     NOT WIRED to a runtime call site by this change: there is no "triagem"
 *     poll/skill in this codebase yet (grepped — F2 in the roadmap named the
 *     Trello connector+poller, not a classification routine; night-coordinator's
 *     own comment confirms "no triage routine sets [altaImpl] yet"). Exported
 *     ready to call once that runtime exists — see the handoff for the open
 *     decision on exactly where.
 *
 *   - `runDegradedModeUnblockPoll` — DOES get a runtime wire-up (this issue's
 *     scope covers it): reacts to a Mapping card reaching Done (the signal
 *     available today for "profile merged" — no pr_links row exists for a
 *     Mapping card's docs PR, pipeline/mapping/pr-docs.ts never creates one
 *     and is out of scope here, so this reads board state instead of polling
 *     GitHub). Reads back the cards cross-linked onto it (via the SAME
 *     attachments checkProfileAndBlock wrote — no new persistence/schema) and
 *     moves every still-Blocked one back to the queue, all cards for one
 *     Mapping card in the SAME poll call.
 */
import { existsSync } from "fs";
import { join } from "path";
import { Effect } from "effect";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { PollStateRepository } from "../persistence/types.js";
import type { Task, TaskSource, TaskState } from "../task-source/types.js";
import type { CreateCardInput, CreateCardResult, LinkedCard } from "../connector/trello.js";
import { resolveRepoForClaim } from "../night-coordinator/run.js";
import { QUEUE_LIST_NAME } from "./work-generation.js";

const MAPPING_LABEL = "OpenRoutines: Mapeamento";
/** Lists a Mapping card can be open in — scanned to avoid ever creating a second one for the same repo. */
const MAPPING_SCAN_STATES: TaskState[] = ["queued", "working", "review"];

const UNBLOCK_COMMENT = "🤖 [Triagem] Repo Profile mesclado — card destravado automaticamente";

// ---- Repo Profile existence (preflight/preparation's own pattern) -----------

/**
 * docs/REPO-PROFILE.md existence on the registry's local clone — the exact
 * read `pipeline/research/preparation.ts`'s `readRepoProfile` and
 * `pipeline/card-to-pr/visual.ts` already use, reused here as a cheap
 * existence check (no content read needed at triage time, unlike those two).
 */
export const hasRepoProfile = (clonePath: string): boolean => existsSync(join(clonePath, "docs", "REPO-PROFILE.md"));

// ---- Lowest-complexity allowlist exception (D11's "exceção só pra Lowest") --

// ponytail: narrow on purpose — D11 exists because running "in the dark" is
// the #1 manual-session error; a broad "config" matcher would exempt files
// that carry real logic. Expand only with a concrete false-block case, not
// speculatively.
const ALLOWLIST_EXTENSIONS = [".md"];
const ALLOWLIST_PATH_HINTS = ["i18n/", "locales/", "strings.json", "strings.ts"];

const isAllowlistedFile = (path: string): boolean => {
  const lower = path.toLowerCase();
  return ALLOWLIST_EXTENSIONS.some((ext) => lower.endsWith(ext)) || ALLOWLIST_PATH_HINTS.some((hint) => lower.includes(hint));
};

const isSubBullet = (line: string): boolean => /^\s{2,}-\s+/.test(line);

/** The card template's (02-FLUXO-TRELLO.md) "## Escopo" -> "- Incluído:" sub-bullets — the only structured, deterministic place a card names touched paths BEFORE any diff exists. */
const extractIncludedBullets = (body: string): string[] => {
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^-\s*inclu[ií]do:\s*$/i.test(l.trim()));
  if (startIdx === -1) return [];
  const bullets: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (!isSubBullet(lines[i])) break;
    bullets.push(lines[i].replace(/^\s{2,}-\s+/, "").trim());
  }
  return bullets;
};

const FILE_TOKEN_RE = /([\w./-]+\.[a-zA-Z0-9]+)\b/;

/**
 * Deterministic Lowest exception (D11: "o dano possível não justifica o
 * ciclo"). Never reads Conceito/Objetivo prose — only the structured Escopo >
 * Incluído bullets, and only when EVERY bullet names an allowlisted file.
 * ponytail: one file token per bullet; a bullet naming several files only
 * checks the first — fine for the narrow typo/i18n use case this targets, not
 * a full path parser. No parseable bullet (or any non-allowlisted one) keeps
 * the gate blocking — unknown scope is never exempt.
 */
export const touchesOnlyAllowlistedPaths = (body: string): boolean => {
  const bullets = extractIncludedBullets(body);
  if (bullets.length === 0) return false;
  return bullets.every((b) => {
    const match = FILE_TOKEN_RE.exec(b);
    return match !== null && isAllowlistedFile(match[1]);
  });
};

// ---- Resolve a Task's repo slug (night-coordinator's own claim-time logic) --

const toRepoLookup = (task: Pick<Task, "sourceId" | "id" | "body" | "labels">) => ({
  sourceId: task.sourceId,
  taskId: task.id,
  body: task.body,
  labels: task.labels,
});

/** Same labels-first-then-Repositório-field resolution night-coordinator/run.ts uses to claim a card — reused, not re-derived. */
export const resolveTaskRepoSlug = (registry: RepoRegistry, task: Task): string | undefined =>
  resolveRepoForClaim(registry)(toRepoLookup(task));

// ---- Find-or-create the repo's Mapping card ---------------------------------

export interface MappingCardRef {
  id: string;
  url: string;
}

/** Scans Fila/Working/Review for an already-open Mapping card of `repoSlug` — never create a second one. */
export const findExistingMappingCard = async (
  taskSource: TaskSource,
  registry: RepoRegistry,
  repoSlug: string
): Promise<MappingCardRef | undefined> => {
  for (const state of MAPPING_SCAN_STATES) {
    const tasks = await Effect.runPromise(taskSource.listQueue(state));
    for (const t of tasks) {
      if (t.type === "mapping" && resolveTaskRepoSlug(registry, t) === repoSlug) {
        return { id: t.id, url: t.url };
      }
    }
  }
  return undefined;
};

const buildMappingCardBody = (repo: string): string =>
  [
    "# Conceito",
    `O repositório ${repo} ainda não tem \`docs/REPO-PROFILE.md\` — um card de implementação foi blocked até o mapeamento existir (D11).`,
    "",
    "## Repositório",
    repo,
    "",
    "## Objetivo",
    `Gerar o Repo Profile (\`docs/REPO-PROFILE.md\` + perfil visual quando aplicável) de ${repo}.`,
    "",
    "## Escopo",
    "- Incluído:",
    "  - Levantamento read-only do repositório e geração do Repo Profile",
    "- Fora de escopo:",
    "  - Qualquer mudança fora de docs/**",
    "",
    "## Critérios de aceite",
    "- [ ] `docs/REPO-PROFILE.md` existe e cobre o núcleo auditável do template",
    "",
    "## Notas técnicas",
    "Card criado automaticamente pelo gate de modo degradado (issue #163) — os cards de implementação linkados a este são destravados automaticamente quando este PR for mesclado.",
  ].join("\n");

const blockedComment = (mappingUrl: string): string =>
  [
    "⛔ [Bloqueio]",
    "Motivo: repo-missing-profile",
    `O que falta: o repositório não tem \`docs/REPO-PROFILE.md\` — mapeamento agendado: ${mappingUrl}`,
    "Próximo passo: aguardar o merge do PR de mapeamento — este card volta para a Fila automaticamente.",
  ].join("\n");

// ---- checkProfileAndBlock (triage-time gate) --------------------------------

export interface DegradedModeDeps {
  registry: RepoRegistry;
  taskSource: TaskSource;
  createCard: (input: CreateCardInput) => Promise<CreateCardResult>;
  linkCards: (a: LinkedCard, b: LinkedCard) => Promise<void>;
  /** Injectable for tests; defaults to the real fs check above. */
  hasProfile?: (clonePath: string) => boolean;
  /** Real Trello list name for a newly-created Mapping card. Defaults to "OpenRoutines — Fila". */
  queueListName?: string;
}

export interface DegradedModeResult {
  blocked: boolean;
  mappingCardId?: string;
}

/**
 * The gate itself. Caller is responsible for at-most-once semantics (e.g. a
 * pollState.claimUnseen on the card id) once a runtime triage caller exists —
 * this function has no idempotency of its own (find-or-create already avoids
 * duplicate Mapping cards, but a double-call still re-links and re-comments).
 */
export const checkProfileAndBlock = async (card: Task, deps: DegradedModeDeps): Promise<DegradedModeResult> => {
  // Read-only card types never need a profile (.openroutines/02-FLUXO-TRELLO.md).
  if (card.type === "research" || card.type === "mapping") return { blocked: false };

  const repoSlug = resolveTaskRepoSlug(deps.registry, card);
  if (!repoSlug) return { blocked: false }; // unresolvable repo is a different gate's concern (blockReason repo-unresolvable)

  const repoConfig = deps.registry.repos[repoSlug];
  const hasProfile = deps.hasProfile ?? hasRepoProfile;
  if (hasProfile(repoConfig.clonePath)) return { blocked: false };

  if (card.complexity === "lowest" && touchesOnlyAllowlistedPaths(card.body)) return { blocked: false };

  const existing = await findExistingMappingCard(deps.taskSource, deps.registry, repoSlug);
  let mapping: MappingCardRef;
  if (existing) {
    mapping = existing;
  } else {
    const result = await deps.createCard({
      listName: deps.queueListName ?? QUEUE_LIST_NAME,
      title: `Mapeamento: ${repoSlug}`,
      description: buildMappingCardBody(repoSlug),
      labels: ["OpenRoutines", MAPPING_LABEL],
    });
    mapping = { id: result.cardId, url: result.url };
  }

  await deps.linkCards({ id: card.id, url: card.url }, mapping);
  await Effect.runPromise(deps.taskSource.moveTo(card.id, "blocked"));
  await Effect.runPromise(deps.taskSource.comment(card.id, blockedComment(mapping.url)));

  return { blocked: true, mappingCardId: mapping.id };
};

// ---- runDegradedModeUnblockPoll (reacts to Mapping card -> Done) -----------

export interface DegradedModeUnblockDeps {
  sourceId: string;
  taskSource: TaskSource;
  pollState: PollStateRepository;
  /** Reads back the ids/shortLinks cross-linked onto a card (makeTrelloReadLinkedCards). */
  readLinkedCards: (cardId: string) => Promise<string[]>;
}

export interface DegradedModeUnblockSummary {
  mappingCardsSeen: number;
  cardsUnblocked: number;
}

/**
 * Every Mapping card currently in Done is re-scanned every tick (a cheap
 * Trello read) — idempotency lives per LINKED card (`claimUnseen` keyed by
 * the linked card's own id), not per Mapping card: a crash after unblocking
 * card A but before card B leaves B claimable next tick while A is never
 * re-acted on (mirrors task-source-poller's per-task claim granularity).
 */
export const runDegradedModeUnblockPoll = async (deps: DegradedModeUnblockDeps): Promise<DegradedModeUnblockSummary> => {
  const summary: DegradedModeUnblockSummary = { mappingCardsSeen: 0, cardsUnblocked: 0 };

  let doneCards: Task[];
  try {
    doneCards = await Effect.runPromise(deps.taskSource.listQueue("done"));
  } catch (err) {
    console.error(`[DegradedModeUnblock] listQueue('done') failed for '${deps.sourceId}':`, err instanceof Error ? err.message : err);
    return summary;
  }

  const mappingCards = doneCards.filter((t) => t.type === "mapping");
  summary.mappingCardsSeen = mappingCards.length;

  for (const mapping of mappingCards) {
    let linkedIds: string[];
    try {
      linkedIds = await deps.readLinkedCards(mapping.id);
    } catch (err) {
      console.error(`[DegradedModeUnblock] readLinkedCards failed for mapping card ${mapping.id}:`, err instanceof Error ? err.message : err);
      continue;
    }

    for (const linkedId of linkedIds) {
      try {
        if (!(await deps.pollState.claimUnseen(deps.sourceId, `degraded-unblock:${linkedId}`))) continue;
        const linked = await Effect.runPromise(deps.taskSource.getTask(linkedId));
        if (linked.state !== "blocked") continue; // human already moved it, or already unblocked
        await Effect.runPromise(deps.taskSource.moveTo(linkedId, "queued"));
        await Effect.runPromise(deps.taskSource.comment(linkedId, UNBLOCK_COMMENT));
        summary.cardsUnblocked++;
      } catch (err) {
        // One bad linked card never stops its siblings under the same Mapping card.
        console.error(`[DegradedModeUnblock] failed to unblock linked card ${linkedId} (mapping ${mapping.id}):`, err instanceof Error ? err.message : err);
      }
    }
  }

  return summary;
};
