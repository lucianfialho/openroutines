#!/usr/bin/env node
/**
 * One-shot, idempotent setup of the Trello board's OpenRoutines lists and
 * labels (.openroutines/02-FLUXO-TRELLO.md). Reads board id + credentials
 * from task-sources.yaml (issue #2) instead of a second config surface.
 *
 * Run: tsx scripts/setup-trello-board.ts [sourceId]
 * (sourceId only needed when more than one "trello" entry is configured)
 */

import { fileURLToPath } from "url";
import { loadTaskSources } from "../src/task-source/loader.js";
import type { TaskSourceEntry } from "../src/task-source/schema.js";

const TARGET_LISTS = ["OpenRoutines — Fila", "OpenRoutines — Working"];

// Color choice is free (not a functional requirement) — one distinct color
// per label so the board reads clearly out of the box.
const LABEL_COLORS: Record<string, string> = {
  OpenRoutines: "green",
  "OpenRoutines: Pesquisa": "blue",
  "OpenRoutines: Mapeamento": "yellow",
  "OpenRoutines: Update": "orange",
  "Não agrupar": "red",
};
const TARGET_LABELS = Object.keys(LABEL_COLORS);

export const planBoardSetup = (
  existingLists: string[],
  existingLabels: string[]
): { listsToCreate: string[]; labelsToCreate: string[] } => ({
  listsToCreate: TARGET_LISTS.filter((name) => !existingLists.includes(name)),
  labelsToCreate: TARGET_LABELS.filter((name) => !existingLabels.includes(name)),
});

// --- Trello wiring (network side effects; not covered by the unit test) ---

interface TrelloItem {
  id: string;
  name: string;
}

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const resolveEntry = (entries: TaskSourceEntry[], requestedId: string | undefined): TaskSourceEntry => {
  if (entries.length === 0) {
    return fail(
      'No "trello" entry found in task-sources.yaml. Add one (see task-sources.yaml.example) before running this script.'
    );
  }
  if (entries.length === 1) return entries[0];
  if (!requestedId) {
    return fail(
      `Multiple trello entries in task-sources.yaml (${entries.map((e) => e.id).join(", ")}). ` +
        `Pass one: tsx scripts/setup-trello-board.ts <id>`
    );
  }
  return entries.find((e) => e.id === requestedId) ?? fail(`No trello entry with id "${requestedId}" found.`);
};

const trelloRequest = async <T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  credentials: { key: string; token: string }
): Promise<T> => {
  const query = new URLSearchParams({ ...params, key: credentials.key, token: credentials.token });
  const res = await fetch(`https://api.trello.com/1${path}?${query.toString()}`, { method });
  if (!res.ok) {
    throw new Error(`${method} ${path} failed with ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
};

const printResolved = (label: string, targets: string[], items: TrelloItem[]) => {
  console.log(`${label}:`);
  for (const name of targets) {
    console.log(`  ${name} -> ${items.find((i) => i.name === name)?.id ?? "?"}`);
  }
};

const main = async () => {
  const entries = loadTaskSources()
    .map((s) => s.entry)
    .filter((e) => e.type === "trello");
  const entry = resolveEntry(entries, process.argv[2]);

  const boardId = entry.containers.board;
  if (!boardId) fail(`Trello entry "${entry.id}" is missing containers.board in task-sources.yaml.`);

  const keyEnv = entry.auth.key;
  const tokenEnv = entry.auth.token;
  const key = keyEnv ? process.env[keyEnv] : undefined;
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (!key || !token) {
    fail(
      `Trello entry "${entry.id}" is missing credentials: set ${keyEnv ?? "auth.key"} and ` +
        `${tokenEnv ?? "auth.token"} in your environment.`
    );
  }
  // Non-null assertion: the guard above already fails fast on either being
  // empty — TS's never-narrowing doesn't propagate through this object
  // literal into trelloRequest's typed parameter, so assert what we just checked.
  const credentials = { key: key!, token: token! };

  const existingLists = await trelloRequest<TrelloItem[]>(
    "GET",
    `/boards/${boardId}/lists`,
    { filter: "open", fields: "id,name" },
    credentials
  );
  const existingLabels = await trelloRequest<TrelloItem[]>(
    "GET",
    `/boards/${boardId}/labels`,
    { filter: "open", fields: "id,name" },
    credentials
  );

  const { listsToCreate, labelsToCreate } = planBoardSetup(
    existingLists.map((l) => l.name),
    existingLabels.map((l) => l.name)
  );

  for (const name of listsToCreate) {
    const created = await trelloRequest<TrelloItem>(
      "POST",
      "/lists",
      { name, idBoard: boardId, pos: "bottom" },
      credentials
    );
    existingLists.push(created);
  }

  for (const name of labelsToCreate) {
    const created = await trelloRequest<TrelloItem>(
      "POST",
      `/boards/${boardId}/labels`,
      { name, color: LABEL_COLORS[name] },
      credentials
    );
    existingLabels.push(created);
  }

  printResolved("Lists", TARGET_LISTS, existingLists);
  printResolved("Labels", TARGET_LABELS, existingLabels);
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
