/**
 * Trello Connector (bespoke TaskSource adapter, issue #142)
 *
 * Talks to the Trello REST API directly — Trello has no official CLI, and
 * the `trello-cli` skill available for manual/operator use doesn't cover
 * custom fields (.openroutines/02-FLUXO-TRELLO.md), so this is a deliberate,
 * documented exception to ADR 0001's CLI-first default, not an accidental
 * one. Every call hits `manifest.baseUrl` (defaults to
 * `https://api.trello.com/1`) with `key`/`token` as query params — Trello
 * has no auth header.
 *
 * Bespoke rather than manifest-driven (src/task-source/rest-executor.ts)
 * because writing Complexidade/Prioridade is a two-step flow — resolve the
 * custom field definition, then PUT the item — that the generic
 * one-request-per-method executor doesn't model. Name -> id resolution
 * (lists, labels, custom fields) reuses createNameCache
 * (src/task-source/name-cache.ts) rather than reimplementing it.
 *
 * Known risk (not addressed here, out of scope per issue #142): Trello caps
 * requests at 300/10s per key and 100/10s per token — the token is the real
 * ceiling, every call here uses the same one. No client-side backoff is
 * implemented; see the `watchNew` comment below.
 */

import { Effect } from "effect";
import { createNameCache } from "../task-source/name-cache.js";
import { TaskSourceError, TASK_COMPLEXITIES } from "../task-source/types.js";
import type {
  Task,
  TaskArtifact,
  TaskClassification,
  TaskComplexity,
  TaskSource,
  TaskSourceMethodName,
  TaskState,
  TaskType,
} from "../task-source/types.js";
import type { ConnectorManifest } from "../task-source/schema.js";

export interface TrelloConfig {
  manifest: ConnectorManifest; // .gates/connectors/trello/connector.yaml, already validated
  sourceId: string;
  boardId: string; // task-sources.yaml: containers.board
  apiKey: string; // already resolved from env, not the var name
  apiToken: string;
}

type Params = Record<string, string>;

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  shortUrl: string;
  labels: Array<{ name: string }>;
  idMembers: string[];
  dateLastActivity: string;
  idList?: string;
  customFieldItems?: Array<{
    idCustomField: string;
    idValue?: string;
    value?: { text?: string; number?: string };
  }>;
}

interface TrelloAction {
  id: string;
  data: { card?: { id: string }; list?: { id: string }; listAfter?: { id: string } };
}

// Custom field defs don't fit name-cache's plain name->id contract (a
// dropdown's options need their own id+text too) — the "id" stored per name
// is this whole definition, JSON-serialized (name-cache only stores strings).
interface CustomFieldDef {
  id: string;
  options?: Array<{ id: string; value: { text: string } }>;
}

export const makeTrelloTaskSource = (config: TrelloConfig): TaskSource => {
  const baseUrl = config.manifest.baseUrl ?? "https://api.trello.com/1";
  const nameCache = createNameCache();

  const authQuery = (): Params => ({ key: config.apiKey, token: config.apiToken });

  const toQueryString = (params: Params): string => {
    const entries = Object.entries(params);
    return entries.length === 0
      ? ""
      : `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
  };

  // Plain-Promise fetch: doubles as the name-cache `load()` callback (which
  // must return a bare Promise, never an Effect) and as the body of
  // `request` below (wrapped in Effect.tryPromise there for TaskSource
  // methods, which need the operation tagged onto any failure).
  const fetchJson = async (
    path: string,
    query: Params,
    init?: { method?: string; body?: unknown }
  ): Promise<unknown> => {
    const url = `${baseUrl}${path}${toQueryString({ ...authQuery(), ...query })}`;
    const method = init?.method ?? "GET";
    const options: RequestInit = { method };
    if (init?.body instanceof FormData) {
      options.body = init.body;
    } else if (init?.body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(init.body);
    }
    const res = await fetch(url, options);
    const text = await res.text();
    if (!res.ok) {
      throw new TaskSourceError(`${method} ${path} failed with status ${res.status}`, undefined, text);
    }
    return text ? JSON.parse(text) : undefined;
  };

  const request = (
    operation: TaskSourceMethodName,
    path: string,
    query: Params = {},
    init?: { method?: string; body?: unknown }
  ): Effect.Effect<unknown, TaskSourceError> =>
    Effect.tryPromise({
      try: () => fetchJson(path, query, init),
      catch: (err) =>
        err instanceof TaskSourceError
          ? new TaskSourceError(err.message, operation, err.cause)
          : new TaskSourceError(`${init?.method ?? "GET"} ${path} failed`, operation, err),
    });

  // name-cache loaders. Lists/labels are Trello List/Board reads, so
  // `filter=open` is mandatory (never trust the API default — hard rule,
  // .openroutines/02-FLUXO-TRELLO.md).
  const fetchNameIdMap = async (path: string): Promise<Record<string, string>> => {
    const raw = (await fetchJson(path, { filter: "open", fields: "id,name" })) as Array<{ id: string; name: string }>;
    return Object.fromEntries(raw.map((item) => [item.name, item.id]));
  };
  const fetchLists = (): Promise<Record<string, string>> => fetchNameIdMap(`/boards/${config.boardId}/lists`);
  const fetchLabels = (): Promise<Record<string, string>> => fetchNameIdMap(`/boards/${config.boardId}/labels`);

  // Custom field definitions have no open/closed state, so no filter here —
  // matches the literal endpoint in issue #142 (unlike lists/labels above).
  const fetchCustomFields = async (): Promise<Record<string, string>> => {
    const raw = (await fetchJson(`/boards/${config.boardId}/customFields`, {})) as Array<{
      id: string;
      name: string;
      options?: Array<{ id: string; value: { text: string } }>;
    }>;
    return Object.fromEntries(
      raw.map((field) => [field.name, JSON.stringify({ id: field.id, options: field.options })])
    );
  };

  const resolveCustomField = (name: string): Effect.Effect<CustomFieldDef, TaskSourceError> =>
    Effect.gen(function* () {
      const json = yield* nameCache.resolve("customField", name, fetchCustomFields);
      return JSON.parse(json) as CustomFieldDef;
    });

  // Shared by both directions of custom-field text matching: Trello's real
  // option labels ("Lowest", "Not sure") and the canonical machine values
  // (TaskComplexity's "lowest", "not_sure") differ only in case/spacing.
  const normalizeKey = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const normalizeComplexity = (text: string): TaskComplexity | undefined => {
    const key = normalizeKey(text);
    return (TASK_COMPLEXITIES as readonly string[]).includes(key) ? (key as TaskComplexity) : undefined;
  };

  // Trello card ids are Mongo ObjectIds — the first 4 bytes (8 hex chars)
  // encode the unix creation timestamp, so createdAt needs no extra field.
  const createdAtFromId = (id: string): Date => new Date(parseInt(id.slice(0, 8), 16) * 1000);

  const taskTypeFromLabels = (labelNames: string[]): TaskType => {
    const typeMap: Partial<Record<TaskType, string>> = config.manifest.classification?.type ?? {};
    for (const [type, labelName] of Object.entries(typeMap) as Array<[TaskType, string]>) {
      if (labelNames.includes(labelName)) return type;
    }
    return "implementation"; // absence of a type label, per .openroutines/02-FLUXO-TRELLO.md
  };

  const baseFields = (card: TrelloCard): Omit<Task, "state" | "complexity" | "priority"> => {
    const labelNames = card.labels.map((l) => l.name);
    return {
      sourceId: config.sourceId,
      id: card.id,
      title: card.name,
      body: card.desc,
      url: card.shortUrl,
      type: taskTypeFromLabels(labelNames),
      labels: labelNames,
      assignees: card.idMembers,
      createdAt: createdAtFromId(card.id),
      updatedAt: new Date(card.dateLastActivity),
      raw: card,
    };
  };

  // Derives the canonical state from an idList by scanning the full name->id
  // map (one cached "list" load, shared with moveTo/listQueue) against
  // manifest.state. Uses resolveMap, not per-name resolve: the 4 shared
  // columns (Backlog/Blocked/Review/Done) live outside the system's control
  // and may be archived/renamed at any time — with filter=open a closed
  // column simply drops from the map. A per-name resolve would Effect.fail on
  // the first missing column and abort getTask entirely (even for a card in a
  // perfectly healthy column); scanning the map just skips the absentee.
  const stateForList = (idList: string): Effect.Effect<TaskState, TaskSourceError> =>
    Effect.gen(function* () {
      const listMap = yield* nameCache.resolveMap("list", fetchLists);
      for (const [state, columnName] of Object.entries(config.manifest.state) as Array<[TaskState, string]>) {
        if (listMap[columnName] === idList) return state;
      }
      return "backlog";
    });

  const itemTextForField = (
    items: NonNullable<TrelloCard["customFieldItems"]>,
    def: CustomFieldDef
  ): string | undefined => {
    const item = items.find((i) => i.idCustomField === def.id);
    if (!item) return undefined;
    if (item.idValue && def.options) {
      return def.options.find((o) => o.id === item.idValue)?.value.text;
    }
    return item.value?.text ?? item.value?.number;
  };

  const readClassification = (
    items: NonNullable<TrelloCard["customFieldItems"]>
  ): Effect.Effect<{ complexity?: TaskComplexity; priority?: string }, TaskSourceError> =>
    Effect.gen(function* () {
      const out: { complexity?: TaskComplexity; priority?: string } = {};
      const complexityField = config.manifest.classification?.complexity?.field;
      if (complexityField) {
        const def = yield* resolveCustomField(complexityField);
        const text = itemTextForField(items, def);
        if (text !== undefined) out.complexity = normalizeComplexity(text);
      }
      const priorityField = config.manifest.classification?.priority?.field;
      if (priorityField) {
        const def = yield* resolveCustomField(priorityField);
        const text = itemTextForField(items, def);
        if (text !== undefined) out.priority = text;
      }
      return out;
    });

  const listQueue = (state: TaskState): Effect.Effect<Task[], TaskSourceError> =>
    Effect.gen(function* () {
      const idList = yield* nameCache.resolve("list", config.manifest.state[state] ?? "", fetchLists);
      const raw = (yield* request("listQueue", `/lists/${encodeURIComponent(idList)}/cards`, {
        filter: "open",
        fields: "id,name,desc,shortUrl,labels,idMembers,dateLastActivity",
      })) as TrelloCard[];
      return raw.map((card) => ({ ...baseFields(card), state }));
    });

  const getTask = (id: string): Effect.Effect<Task, TaskSourceError> =>
    Effect.gen(function* () {
      const card = (yield* request("getTask", `/cards/${encodeURIComponent(id)}`, {
        filter: "open",
        fields: "id,name,desc,shortUrl,labels,idMembers,idList,dateLastActivity",
        customFieldItems: "true",
      })) as TrelloCard;
      const state = yield* stateForList(card.idList ?? "");
      const classification = yield* readClassification(card.customFieldItems ?? []);
      return { ...baseFields(card), state, ...classification };
    });

  const comment = (id: string, body: string): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      yield* request(
        "comment",
        `/cards/${encodeURIComponent(id)}/actions/comments`,
        { text: body },
        { method: "POST" }
      );
    });

  const attachArtifact = (id: string, artifact: TaskArtifact): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      const mimeType = artifact.mimeType ?? "text/plain";
      const form = new FormData();
      form.append("file", new Blob([artifact.content], { type: mimeType }), artifact.filename);
      form.append("name", artifact.filename);
      form.append("mimeType", mimeType);
      yield* request(
        "attachArtifact",
        `/cards/${encodeURIComponent(id)}/attachments`,
        {},
        { method: "POST", body: form }
      );
    });

  const moveTo = (id: string, state: TaskState): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      const idList = yield* nameCache.resolve("list", config.manifest.state[state] ?? "", fetchLists);
      yield* request("moveTo", `/cards/${encodeURIComponent(id)}`, { idList }, { method: "PUT" });
    });

  // Removes every OTHER declared type label actually present on the card,
  // then adds the target's (skipped for "implementation", which has none).
  const setType = (id: string, target: TaskType): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      const typeMap: Partial<Record<TaskType, string>> = config.manifest.classification?.type ?? {};
      const card = (yield* request("setClassification", `/cards/${encodeURIComponent(id)}`, {
        filter: "open",
        fields: "labels",
      })) as { labels: Array<{ name: string }> };
      const currentNames = new Set(card.labels.map((l) => l.name));

      for (const [type, labelName] of Object.entries(typeMap) as Array<[TaskType, string]>) {
        if (type === target || !currentNames.has(labelName)) continue;
        const idLabel = yield* nameCache.resolve("label", labelName, fetchLabels);
        yield* request(
          "setClassification",
          `/cards/${encodeURIComponent(id)}/idLabel/${encodeURIComponent(idLabel)}`,
          {},
          { method: "DELETE" }
        );
      }

      const targetLabelName = typeMap[target];
      if (targetLabelName) {
        const idLabel = yield* nameCache.resolve("label", targetLabelName, fetchLabels);
        yield* request(
          "setClassification",
          `/cards/${encodeURIComponent(id)}/idLabels`,
          { value: idLabel },
          { method: "POST" }
        );
      }
    });

  // Two steps: resolve the field definition, then PUT the item — {idValue}
  // for a dropdown field (matched by normalized option text), else
  // {value:{text}}.
  const setCustomFieldValue = (
    id: string,
    fieldName: string | undefined,
    value: string
  ): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      if (!fieldName) return;
      const def = yield* resolveCustomField(fieldName);
      const option = def.options?.find((o) => normalizeKey(o.value.text) === normalizeKey(value));
      const body = option ? { idValue: option.id } : { value: { text: value } };
      yield* request(
        "setClassification",
        `/cards/${encodeURIComponent(id)}/customField/${encodeURIComponent(def.id)}/item`,
        {},
        { method: "PUT", body }
      );
    });

  const setClassification = (id: string, classification: TaskClassification): Effect.Effect<void, TaskSourceError> =>
    Effect.gen(function* () {
      if (classification.type !== undefined) {
        yield* setType(id, classification.type);
      }
      if (classification.complexity !== undefined) {
        yield* setCustomFieldValue(id, config.manifest.classification?.complexity?.field, classification.complexity);
      }
      if (classification.priority !== undefined) {
        yield* setCustomFieldValue(id, config.manifest.classification?.priority?.field, classification.priority);
      }
    });

  // ponytail: no client-side rate-limit backoff — Trello allows 300 req/10s
  // per key, 100 req/10s per token (the real ceiling; every call here shares
  // one token). Fine at today's single-board poll volume; add a
  // serialized/backoff transport if a heavy night trips it — that's a
  // generic transport concern (same class as provider backoff, F1), not
  // specific to this adapter.
  const watchNew = (cursor: string | null): Effect.Effect<{ tasks: Task[]; cursor: string }, TaskSourceError> =>
    Effect.gen(function* () {
      if (cursor === null) {
        const tasks = yield* listQueue("queued");
        return { tasks, cursor: new Date().toISOString() };
      }

      const queuedListId = yield* nameCache.resolve("list", config.manifest.state.queued ?? "", fetchLists);
      const actions = (yield* request("watchNew", `/boards/${config.boardId}/actions`, {
        filter: "createCard,updateCard:idList",
        since: cursor,
        limit: "1000",
        fields: "id,date,data",
      })) as TrelloAction[];

      if (actions.length === 0) {
        return { tasks: [], cursor };
      }

      const cardIds: string[] = [];
      const seen = new Set<string>();
      for (const action of actions) {
        const listId = action.data.list?.id ?? action.data.listAfter?.id;
        const cardId = action.data.card?.id;
        if (listId === queuedListId && cardId && !seen.has(cardId)) {
          seen.add(cardId);
          cardIds.push(cardId);
        }
      }

      const tasks: Task[] = [];
      for (const cardId of cardIds) {
        tasks.push(yield* getTask(cardId));
      }

      // Trello returns board actions newest-first by default.
      return { tasks, cursor: actions[0].id };
    });

  return { listQueue, getTask, comment, attachArtifact, moveTo, setClassification, watchNew };
};
