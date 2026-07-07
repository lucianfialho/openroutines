#!/usr/bin/env node
/**
 * One-shot, idempotent setup of the Trello board's OpenRoutines lists and
 * labels (.openroutines/02-FLUXO-TRELLO.md). Reads board id + credentials
 * from task-sources.yaml (issue #2) instead of a second config surface.
 *
 * Run: tsx scripts/setup-trello-board.ts [sourceId]
 * (sourceId only needed when more than one "trello" entry is configured)
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import { loadTaskSources } from "../src/task-source/loader.js";
import type { TaskSourceEntry } from "../src/task-source/schema.js";
import {
  CLASSIFICATION_LABEL_COLORS,
  DEFAULT_LABEL_COLOR,
  DEFAULT_LABEL_NAME,
  createBoardLabel,
  createBoardList,
  fetchBoardLabels,
  fetchBoardLists,
  type TrelloCreds,
  type TrelloLabel,
  type TrelloList,
} from "../src/onboarding/trello-board.js";

const TARGET_LISTS = ["OpenRoutines — Fila", "OpenRoutines — Working"];

// Single source of truth for label names/colors: src/onboarding/trello-board.ts
// (the same constants back the idempotent creation at boot).
const LABEL_COLORS: Record<string, string> = {
  [DEFAULT_LABEL_NAME]: DEFAULT_LABEL_COLOR,
  ...CLASSIFICATION_LABEL_COLORS,
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

const printResolved = (label: string, targets: string[], items: (TrelloList | TrelloLabel)[]) => {
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
  const credentials: TrelloCreds = { key, token };

  const existingLists = await fetchBoardLists(boardId, credentials);
  const existingLabels = await fetchBoardLabels(boardId, credentials);

  const { listsToCreate, labelsToCreate } = planBoardSetup(
    existingLists.map((l) => l.name),
    existingLabels.map((l) => l.name)
  );

  for (const name of listsToCreate) {
    const created = await createBoardList(boardId, name, credentials);
    existingLists.push(created);
  }

  for (const name of labelsToCreate) {
    const created = await createBoardLabel(boardId, name, LABEL_COLORS[name], credentials);
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
