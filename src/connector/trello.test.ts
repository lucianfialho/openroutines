import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { Effect } from "effect";
import { makeTrelloTaskSource } from "./trello.js";
import type { TrelloConfig } from "./trello.js";
import { parseConnectorManifest } from "../task-source/parser.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const manifestYaml = `
name: trello
transport: rest
baseUrl: https://api.trello.com/1
auth:
  scheme: query
  params: { key: key, token: token }
container:
  kind: list
  flag:
    kind: label
    name: OpenRoutines
state:
  backlog: Backlog
  queued: "OpenRoutines — Fila"
  working: "OpenRoutines — Working"
  blocked: Blocked
  review: Review
  done: Done
classification:
  type:
    research: "OpenRoutines: Pesquisa"
    mapping: "OpenRoutines: Mapeamento"
    update: "OpenRoutines: Update"
  complexity: { field: Complexidade }
  priority: { field: Prioridade }
`;

const config: TrelloConfig = {
  manifest: parseConnectorManifest(manifestYaml),
  sourceId: "trello-main",
  boardId: "board-1",
  apiKey: "key123",
  apiToken: "token456",
};

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const callUrl = (fetchMock: ReturnType<typeof vi.fn>, index: number): URL =>
  new URL(fetchMock.mock.calls[index][0] as string);

const callInit = (fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit =>
  fetchMock.mock.calls[index][1] as RequestInit;

const rawCard = {
  id: "5f1a2b3c4d5e6f7081920a1b",
  name: "Fix bug",
  desc: "details",
  shortUrl: "https://trello.com/c/abc123",
  labels: [{ name: "OpenRoutines" }],
  idMembers: ["member-1"],
  dateLastActivity: "2026-06-01T12:00:00.000Z",
};

describe("makeTrelloTaskSource — listQueue", () => {
  it("resolves idList by name once and reuses the cache on a second call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [{ id: "list-fila", name: "OpenRoutines — Fila" }]))
      .mockResolvedValueOnce(jsonResponse(200, [rawCard]))
      .mockResolvedValueOnce(jsonResponse(200, [rawCard]));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    const first = await Effect.runPromise(source.listQueue("queued"));
    const second = await Effect.runPromise(source.listQueue("queued"));

    // 1 list lookup (cached across both calls) + 2 card fetches, not 2 list lookups.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callUrl(fetchMock, 0).pathname).toBe("/1/boards/board-1/lists");
    expect(callUrl(fetchMock, 0).searchParams.get("filter")).toBe("open");
    expect(callUrl(fetchMock, 1).pathname).toBe("/1/lists/list-fila/cards");
    expect(callUrl(fetchMock, 1).searchParams.get("filter")).toBe("open");
    expect(callUrl(fetchMock, 1).searchParams.get("fields")).toBe(
      "id,name,desc,shortUrl,labels,idMembers,dateLastActivity"
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: rawCard.id, title: "Fix bug", state: "queued", type: "implementation" });
  });
});

describe("makeTrelloTaskSource — getTask", () => {
  it("maps customFieldItems to complexity/priority as text (not id) and idList to the canonical state", async () => {
    const cardId = "5f1a2b3c4d5e6f7081920a1b";
    const cardResponse = {
      id: cardId,
      name: "Investigate flaky test",
      desc: "details",
      shortUrl: "https://trello.com/c/xyz789",
      labels: [{ name: "OpenRoutines" }, { name: "OpenRoutines: Pesquisa" }],
      idMembers: [],
      idList: "list-working",
      dateLastActivity: "2026-06-15T08:00:00.000Z",
      customFieldItems: [
        { idCustomField: "cf-complexity", idValue: "opt-medium" },
        { idCustomField: "cf-priority", value: { text: "Alta" } },
      ],
    };
    const listsResponse = [
      { id: "list-backlog", name: "Backlog" },
      { id: "list-fila", name: "OpenRoutines — Fila" },
      { id: "list-working", name: "OpenRoutines — Working" },
    ];
    const customFieldsResponse = [
      {
        id: "cf-complexity",
        name: "Complexidade",
        options: [
          { id: "opt-lowest", value: { text: "Lowest" } },
          { id: "opt-medium", value: { text: "Medium" } },
          { id: "opt-notsure", value: { text: "Not sure" } },
        ],
      },
      { id: "cf-priority", name: "Prioridade" },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, cardResponse))
      .mockResolvedValueOnce(jsonResponse(200, listsResponse))
      .mockResolvedValueOnce(jsonResponse(200, customFieldsResponse));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    const task = await Effect.runPromise(source.getTask(cardId));

    expect(task.state).toBe("working");
    expect(task.type).toBe("research");
    expect(task.complexity).toBe("medium"); // resolved from idValue -> "Medium" text -> normalized, not "opt-medium"
    expect(task.priority).toBe("Alta"); // plain text field, used verbatim

    expect(callUrl(fetchMock, 0).pathname).toBe(`/1/cards/${cardId}`);
    expect(callUrl(fetchMock, 0).searchParams.get("filter")).toBe("open");
    expect(callUrl(fetchMock, 0).searchParams.get("customFieldItems")).toBe("true");
  });

  it("still resolves state when a shared column is archived/missing from the board (no abort)", async () => {
    // "Blocked" (a team-shared column outside OpenRoutines' control) has been
    // archived, so filter=open drops it from the lists map. The card sits in
    // "Done" — which is declared AFTER "blocked" in manifest.state order, so a
    // per-name resolve would have failed on the missing "Blocked" before ever
    // reaching "Done" and thrown for a perfectly valid card.
    const cardId = "5f1a2b3c4d5e6f7081920a1b";
    const cardResponse = {
      id: cardId,
      name: "Shipped feature",
      desc: "details",
      shortUrl: "https://trello.com/c/done1",
      labels: [{ name: "OpenRoutines" }],
      idMembers: [],
      idList: "list-done",
      dateLastActivity: "2026-06-20T08:00:00.000Z",
      customFieldItems: [],
    };
    const listsWithoutBlocked = [
      { id: "list-backlog", name: "Backlog" },
      { id: "list-fila", name: "OpenRoutines — Fila" },
      { id: "list-working", name: "OpenRoutines — Working" },
      { id: "list-review", name: "Review" },
      { id: "list-done", name: "Done" },
    ];
    const customFieldsResponse = [
      { id: "cf-complexity", name: "Complexidade" },
      { id: "cf-priority", name: "Prioridade" },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, cardResponse))
      .mockResolvedValueOnce(jsonResponse(200, listsWithoutBlocked))
      .mockResolvedValueOnce(jsonResponse(200, customFieldsResponse));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    const task = await Effect.runPromise(source.getTask(cardId));

    expect(task.state).toBe("done");
  });
});

describe("makeTrelloTaskSource — comment", () => {
  it("sends the correct text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    await Effect.runPromise(source.comment("card-1", "hello world"));

    expect(callUrl(fetchMock, 0).pathname).toBe("/1/cards/card-1/actions/comments");
    expect(callUrl(fetchMock, 0).searchParams.get("text")).toBe("hello world");
    expect(callInit(fetchMock, 0).method).toBe("POST");
  });
});

describe("makeTrelloTaskSource — moveTo", () => {
  it("PUTs with the resolved idList", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [{ id: "list-review", name: "Review" }]))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    await Effect.runPromise(source.moveTo("card-1", "review"));

    expect(callUrl(fetchMock, 1).pathname).toBe("/1/cards/card-1");
    expect(callUrl(fetchMock, 1).searchParams.get("idList")).toBe("list-review");
    expect(callInit(fetchMock, 1).method).toBe("PUT");
  });
});

describe("makeTrelloTaskSource — setClassification", () => {
  it("complexity: resolves the field then PUTs the item, in order, using idValue for a dropdown", async () => {
    const customFieldsResponse = [
      {
        id: "cf-complexity",
        name: "Complexidade",
        options: [
          { id: "opt-low", value: { text: "Low" } },
          { id: "opt-medium", value: { text: "Medium" } },
        ],
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, customFieldsResponse))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    await Effect.runPromise(source.setClassification("card-1", { complexity: "medium" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Call 0: resolve the field definition. No filter — custom field defs have no open/closed state.
    expect(callUrl(fetchMock, 0).pathname).toBe("/1/boards/board-1/customFields");
    expect(callUrl(fetchMock, 0).searchParams.has("filter")).toBe(false);
    // Call 1: PUT the item, dropdown match -> idValue, not {value:{text}}.
    expect(callUrl(fetchMock, 1).pathname).toBe("/1/cards/card-1/customField/cf-complexity/item");
    expect(callInit(fetchMock, 1).method).toBe("PUT");
    expect(JSON.parse(callInit(fetchMock, 1).body as string)).toEqual({ idValue: "opt-medium" });
  });

  it("type: removes the previous type label (that's actually on the card) before adding the new one", async () => {
    const labelsResponse = [
      { id: "label-research", name: "OpenRoutines: Pesquisa" },
      { id: "label-mapping", name: "OpenRoutines: Mapeamento" },
      { id: "label-update", name: "OpenRoutines: Update" },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { labels: [{ name: "OpenRoutines" }, { name: "OpenRoutines: Pesquisa" }] }))
      .mockResolvedValueOnce(jsonResponse(200, labelsResponse))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    await Effect.runPromise(source.setClassification("card-1", { type: "mapping" }));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callUrl(fetchMock, 0).pathname).toBe("/1/cards/card-1");
    expect(callUrl(fetchMock, 0).searchParams.get("filter")).toBe("open");
    expect(callUrl(fetchMock, 1).pathname).toBe("/1/boards/board-1/labels");
    expect(callUrl(fetchMock, 1).searchParams.get("filter")).toBe("open");

    // Remove (the "Pesquisa" label actually present) happens before add.
    expect(callInit(fetchMock, 2).method).toBe("DELETE");
    expect(callUrl(fetchMock, 2).pathname).toBe("/1/cards/card-1/idLabel/label-research");
    expect(callInit(fetchMock, 3).method).toBe("POST");
    expect(callUrl(fetchMock, 3).pathname).toBe("/1/cards/card-1/idLabels");
    expect(callUrl(fetchMock, 3).searchParams.get("value")).toBe("label-mapping");

    // "Update" was never on the card, so it's never resolved/deleted.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("idLabel/label-update"))).toBe(false);
  });
});

describe("makeTrelloTaskSource — watchNew", () => {
  it("watchNew(null) returns every task currently in the queue, with no /actions call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [{ id: "list-fila", name: "OpenRoutines — Fila" }]))
      .mockResolvedValueOnce(jsonResponse(200, [rawCard]));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    const result = await Effect.runPromise(source.watchNew(null));

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe(rawCard.id);
    expect(typeof result.cursor).toBe("string");
    expect(result.cursor.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/actions"))).toBe(true);
  });

  it("watchNew(cursor) only returns tasks from actions landing in the queued list", async () => {
    const actionsResponse = [
      { id: "action-3", data: { card: { id: "card-c" }, list: { id: "list-fila" } } }, // createCard into queued
      { id: "action-2", data: { card: { id: "card-b" }, listAfter: { id: "list-working" } } }, // moved elsewhere
      { id: "action-1", data: { card: { id: "card-a" }, listAfter: { id: "list-fila" } } }, // moved into queued
    ];
    const cardCFixture = {
      id: "card-c",
      name: "C",
      desc: "",
      shortUrl: "https://trello.com/c/c",
      labels: [],
      idMembers: [],
      idList: "list-fila",
      dateLastActivity: "2026-06-20T00:00:00.000Z",
      customFieldItems: [],
    };
    const cardAFixture = { ...cardCFixture, id: "card-a", name: "A", shortUrl: "https://trello.com/c/a" };
    const customFieldsResponse = [
      { id: "cf-complexity", name: "Complexidade" },
      { id: "cf-priority", name: "Prioridade" },
    ];

    // The "list" kind cache is shared across every name lookup for the life of
    // this source instance — this first response has to carry every column
    // getTask's stateForList might check, not just "queued"'s, or a later
    // lookup (e.g. "Backlog") would find the cache already warm but missing it.
    const fullListsResponse = [
      { id: "list-backlog", name: "Backlog" },
      { id: "list-fila", name: "OpenRoutines — Fila" },
      { id: "list-working", name: "OpenRoutines — Working" },
      { id: "list-blocked", name: "Blocked" },
      { id: "list-review", name: "Review" },
      { id: "list-done", name: "Done" },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, fullListsResponse)) // resolve queued idList
      .mockResolvedValueOnce(jsonResponse(200, actionsResponse))
      .mockResolvedValueOnce(jsonResponse(200, cardCFixture)) // getTask(card-c)
      .mockResolvedValueOnce(jsonResponse(200, customFieldsResponse))
      .mockResolvedValueOnce(jsonResponse(200, cardAFixture)); // getTask(card-a)
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    const result = await Effect.runPromise(source.watchNew("cursor-old"));

    expect(result.tasks.map((t) => t.id)).toEqual(["card-c", "card-a"]);
    expect(result.tasks.some((t) => t.id === "card-b")).toBe(false);
    expect(result.cursor).toBe("action-3"); // newest action id, Trello returns actions newest-first

    expect(callUrl(fetchMock, 1).pathname).toBe("/1/boards/board-1/actions");
    expect(callUrl(fetchMock, 1).searchParams.get("filter")).toBe("createCard,updateCard:idList");
    expect(callUrl(fetchMock, 1).searchParams.get("since")).toBe("cursor-old");
    expect(callUrl(fetchMock, 1).searchParams.get("limit")).toBe("1000");
  });

  it("watchNew(cursor) with no new actions returns the received cursor unchanged", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [{ id: "list-fila", name: "OpenRoutines — Fila" }]))
      .mockResolvedValueOnce(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);

    const source = makeTrelloTaskSource(config);
    const result = await Effect.runPromise(source.watchNew("cursor-old"));

    expect(result).toEqual({ tasks: [], cursor: "cursor-old" });
  });
});

describe("connector.yaml", () => {
  it("the real .gates/connectors/trello/connector.yaml is valid per parseConnectorManifest", () => {
    const yaml = readFileSync(new URL("../../.gates/connectors/trello/connector.yaml", import.meta.url), "utf-8");
    const manifest = parseConnectorManifest(yaml);

    expect(manifest.name).toBe("trello");
    expect(manifest.transport).toBe("rest");
    expect(manifest.baseUrl).toBe("https://api.trello.com/1");
    expect(manifest.auth).toEqual({ scheme: "query", params: { key: "key", token: "token" } });
    expect(manifest.container).toEqual({ kind: "list", flag: { kind: "label", name: "OpenRoutines" } });
    expect(manifest.state).toEqual({
      backlog: "Backlog",
      queued: "OpenRoutines — Fila",
      working: "OpenRoutines — Working",
      blocked: "Blocked",
      review: "Review",
      done: "Done",
    });
    expect(manifest.classification?.type).toEqual({
      research: "OpenRoutines: Pesquisa",
      mapping: "OpenRoutines: Mapeamento",
      update: "OpenRoutines: Update",
    });
    expect(manifest.classification?.complexity).toEqual({ field: "Complexidade" });
    expect(manifest.classification?.priority).toEqual({ field: "Prioridade" });
    expect(manifest.capabilities).toEqual(["customFields", "twoStepClassification"]);
  });
});
