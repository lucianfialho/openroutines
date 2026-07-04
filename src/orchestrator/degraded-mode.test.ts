/**
 * Degraded-mode gate tests (F5 #163, D11) — the 5 acceptance criteria from
 * the issue, plus the unblock poll's own idempotency/skip guarantees its
 * docstring claims.
 */
import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import {
  checkProfileAndBlock,
  runDegradedModeUnblockPoll,
  type DegradedModeDeps,
  type DegradedModeUnblockDeps,
} from "./degraded-mode.js";
import { makeInMemoryPollStateRepository } from "../persistence/poll-state-in-memory.js";
import type { RepoRegistry } from "../repo-registry/schema.js";
import type { Task, TaskSource, TaskState } from "../task-source/types.js";
import type { CreateCardInput } from "../connector/trello.js";
import { sendTelegramAlert } from "../notify/telegram.js";

// D11/blockReason repo-sem-profile is explicitly NOT a seguranca* reason
// (10-ESTADOS-DAS-TAREFAS.md) — degraded-mode.ts never imports this module,
// so this mock+assertion is the regression guard: it fails loudly the day
// someone wires an alert call into this gate.
vi.mock("../notify/telegram.js", () => ({
  sendTelegramAlert: vi.fn(async () => {}),
  isSecurityBlockReason: (r: string | undefined) => !!r && r.startsWith("seguranca"),
}));

const SOURCE = "trello-main";
const REPO = "acme-widgets";

const registry: RepoRegistry = {
  repos: {
    [REPO]: {
      clonePath: "/tmp/acme-widgets",
      githubRepo: "acme/acme-widgets",
      baseBranch: "develop",
      verify: { build: "npm run build", test: "npm test" },
      critical: false,
    },
  },
};

const cardBody = (incluido: string[] = ["algum-arquivo.ts"]): string =>
  [
    "# Conceito",
    "Fazer algo",
    "",
    "## Repositório",
    REPO,
    "",
    "## Objetivo",
    "Entregar algo",
    "",
    "## Escopo",
    "- Incluído:",
    ...incluido.map((f) => `  - ${f}`),
    "- Fora de escopo:",
    "  - Resto",
    "",
    "## Critérios de aceite",
    "- [ ] AC1",
  ].join("\n");

const makeTask = (id: string, over: Partial<Task> = {}): Task => ({
  sourceId: SOURCE,
  id,
  title: "Some card",
  body: cardBody(),
  url: `https://trello.com/c/${id}`,
  state: "queued",
  type: "implementation",
  complexity: "medium",
  labels: [],
  assignees: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

/** Fake TaskSource — listQueue is scriptable per state, everything else a plain spy. */
const makeTaskSource = (queueByState: Partial<Record<TaskState, Task[]>> = {}, tasksById: Record<string, Task> = {}) => {
  const listQueue = vi.fn((state: TaskState) => Effect.succeed(queueByState[state] ?? []));
  const getTask = vi.fn((id: string) => {
    const t = tasksById[id];
    if (!t) throw new Error(`no fixture task for id ${id}`);
    return Effect.succeed(t);
  });
  const comment = vi.fn((_id: string, _body: string) => Effect.succeed(undefined));
  const moveTo = vi.fn((_id: string, _state: TaskState) => Effect.succeed(undefined));
  const taskSource = { listQueue, getTask, comment, moveTo } as unknown as TaskSource;
  return { taskSource, listQueue, getTask, comment, moveTo };
};

describe("checkProfileAndBlock (F5 #163)", () => {
  it("AC: a Medium card in a repo without REPO-PROFILE.md blocks, creates ONE Mapping card, links both ways, and never alerts Telegram", async () => {
    const card = makeTask("card-1", { complexity: "medium" });
    const { taskSource, comment, moveTo } = makeTaskSource(); // every state empty -> no existing Mapping card
    const createCard = vi.fn(async (_input: CreateCardInput) => ({ cardId: "map-1", url: "https://trello.com/c/map-1" }));
    const linkCards = vi.fn(async () => {});
    const deps: DegradedModeDeps = { registry, taskSource, createCard, linkCards, hasProfile: () => false };

    const result = await checkProfileAndBlock(card, deps);

    expect(result).toEqual({ blocked: true, mappingCardId: "map-1" });
    expect(createCard).toHaveBeenCalledTimes(1);
    expect(createCard.mock.calls[0][0]).toMatchObject({
      labels: expect.arrayContaining(["OpenRoutines: Mapeamento"]),
    });
    expect(createCard.mock.calls[0][0].description).toContain(`## Repositório\n${REPO}`);
    expect(linkCards).toHaveBeenCalledTimes(1);
    expect(linkCards).toHaveBeenCalledWith({ id: "card-1", url: card.url }, { id: "map-1", url: "https://trello.com/c/map-1" });
    expect(moveTo).toHaveBeenCalledWith("card-1", "blocked");
    expect(comment).toHaveBeenCalledTimes(1);
    expect(comment.mock.calls[0][1]).toContain("repo-sem-profile");
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it("AC: a Lowest card touching only README.md does NOT block, even without a profile", async () => {
    const card = makeTask("card-2", { complexity: "lowest", body: cardBody(["README.md"]) });
    const { taskSource, comment, moveTo } = makeTaskSource();
    const createCard = vi.fn(async () => ({ cardId: "map-1", url: "https://trello.com/c/map-1" }));
    const linkCards = vi.fn(async () => {});
    const deps: DegradedModeDeps = { registry, taskSource, createCard, linkCards, hasProfile: () => false };

    const result = await checkProfileAndBlock(card, deps);

    expect(result).toEqual({ blocked: false });
    expect(createCard).not.toHaveBeenCalled();
    expect(linkCards).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it.each(["research", "mapping"] as const)("AC: an OpenRoutines: %s card never blocks, profile or not", async (type) => {
    const card = makeTask("card-3", { type, complexity: "medium" });
    const { taskSource, comment, moveTo } = makeTaskSource();
    const createCard = vi.fn(async () => ({ cardId: "map-1", url: "https://trello.com/c/map-1" }));
    const linkCards = vi.fn(async () => {});
    const deps: DegradedModeDeps = { registry, taskSource, createCard, linkCards, hasProfile: () => false };

    const result = await checkProfileAndBlock(card, deps);

    expect(result).toEqual({ blocked: false });
    expect(createCard).not.toHaveBeenCalled();
    expect(linkCards).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it("AC: a 2nd card for the same repo links onto the EXISTING open Mapping card instead of creating a second one", async () => {
    const mappingCard = makeTask("map-existing", { type: "mapping", url: "https://trello.com/c/map-existing" });
    const card = makeTask("card-4", { complexity: "medium" });
    const { taskSource, moveTo } = makeTaskSource({ queued: [mappingCard] });
    const createCard = vi.fn(async () => ({ cardId: "should-not-be-created", url: "https://trello.com/c/x" }));
    const linkCards = vi.fn(async () => {});
    const deps: DegradedModeDeps = { registry, taskSource, createCard, linkCards, hasProfile: () => false };

    const result = await checkProfileAndBlock(card, deps);

    expect(result).toEqual({ blocked: true, mappingCardId: "map-existing" });
    expect(createCard).not.toHaveBeenCalled();
    expect(linkCards).toHaveBeenCalledWith(
      { id: "card-4", url: card.url },
      { id: "map-existing", url: "https://trello.com/c/map-existing" }
    );
    expect(moveTo).toHaveBeenCalledWith("card-4", "blocked");
  });

  it("a repo already carrying docs/REPO-PROFILE.md never blocks", async () => {
    const card = makeTask("card-5", { complexity: "medium" });
    const { taskSource, comment, moveTo } = makeTaskSource();
    const createCard = vi.fn();
    const linkCards = vi.fn();
    const deps: DegradedModeDeps = { registry, taskSource, createCard, linkCards, hasProfile: () => true };

    const result = await checkProfileAndBlock(card, deps);

    expect(result).toEqual({ blocked: false });
    expect(createCard).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });
});

describe("runDegradedModeUnblockPoll (F5 #163)", () => {
  it("AC: a Mapping card in Done unblocks BOTH its linked Blocked cards in a single poll cycle", async () => {
    const mapping = makeTask("map-1", { type: "mapping", state: "done" });
    const blocked1 = makeTask("blocked-1", { state: "blocked" });
    const blocked2 = makeTask("blocked-2", { state: "blocked" });
    const { taskSource, comment, moveTo } = makeTaskSource(
      { done: [mapping] },
      { "blocked-1": blocked1, "blocked-2": blocked2 }
    );
    const readLinkedCards = vi.fn(async () => ["blocked-1", "blocked-2"]);
    const deps: DegradedModeUnblockDeps = {
      sourceId: SOURCE,
      taskSource,
      pollState: makeInMemoryPollStateRepository(),
      readLinkedCards,
    };

    const summary = await runDegradedModeUnblockPoll(deps);

    expect(summary).toEqual({ mappingCardsSeen: 1, cardsUnblocked: 2 });
    expect(moveTo).toHaveBeenCalledWith("blocked-1", "queued");
    expect(moveTo).toHaveBeenCalledWith("blocked-2", "queued");
    expect(comment).toHaveBeenCalledTimes(2);
    expect(comment.mock.calls.every((c) => String(c[1]).includes("destravado automaticamente"))).toBe(true);
  });

  it("skips a linked card that is no longer Blocked (already moved by a human or a previous run)", async () => {
    const mapping = makeTask("map-1", { type: "mapping", state: "done" });
    const stillBlocked = makeTask("blocked-1", { state: "blocked" });
    const alreadyMoved = makeTask("blocked-2", { state: "review" });
    const { taskSource, comment, moveTo } = makeTaskSource(
      { done: [mapping] },
      { "blocked-1": stillBlocked, "blocked-2": alreadyMoved }
    );
    const readLinkedCards = vi.fn(async () => ["blocked-1", "blocked-2"]);
    const deps: DegradedModeUnblockDeps = {
      sourceId: SOURCE,
      taskSource,
      pollState: makeInMemoryPollStateRepository(),
      readLinkedCards,
    };

    const summary = await runDegradedModeUnblockPoll(deps);

    expect(summary).toEqual({ mappingCardsSeen: 1, cardsUnblocked: 1 });
    expect(moveTo).toHaveBeenCalledWith("blocked-1", "queued");
    expect(moveTo).not.toHaveBeenCalledWith("blocked-2", "queued");
    expect(comment).toHaveBeenCalledTimes(1);
  });

  it("a second poll tick never re-unblocks the same linked card (claimUnseen dedupe)", async () => {
    const mapping = makeTask("map-1", { type: "mapping", state: "done" });
    const blocked1 = makeTask("blocked-1", { state: "blocked" });
    const { taskSource, comment, moveTo } = makeTaskSource({ done: [mapping] }, { "blocked-1": blocked1 });
    const readLinkedCards = vi.fn(async () => ["blocked-1"]);
    const pollState = makeInMemoryPollStateRepository();
    const deps: DegradedModeUnblockDeps = { sourceId: SOURCE, taskSource, pollState, readLinkedCards };

    await runDegradedModeUnblockPoll(deps);
    const secondSummary = await runDegradedModeUnblockPoll(deps);

    expect(secondSummary).toEqual({ mappingCardsSeen: 1, cardsUnblocked: 0 });
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledTimes(1);
  });
});
