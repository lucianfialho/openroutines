/**
 * Trello board column validation + idempotent setup helpers.
 *
 * Used at boot (src/onboarding/index.ts) and by scripts/setup-trello-board.ts.
 * All network calls are plain Promise-based so they can be mocked in unit tests
 * without pulling in Effect or the connector's internal fetch.
 */

import type { CanonicalState } from "./index.js";

export interface TrelloCreds {
  key: string;
  token: string;
}

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloLabel {
  id: string;
  name: string;
}

export const DEDICATED_STATES: CanonicalState[] = ["queued", "working"];
export const SHARED_STATES: CanonicalState[] = ["backlog", "blocked", "review", "done"];

export const DEFAULT_LABEL_NAME = "OpenRoutines";
export const DEFAULT_LABEL_COLOR = "green";

export const TRELLO_API_BASE = "https://api.trello.com/1";

/**
 * Column-name matching is case-insensitive and accent-insensitive.
 * This fixes the bug where the board had "BACKLOG" but the manifest asked for
 * "Backlog", so the exact match failed while a human would clearly see the
 * column exists. The wizard still writes the real board name back into the
 * manifest — we only relax matching, not storage.
 */
export const normalizeListName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const authQuery = (creds: TrelloCreds): string =>
  `key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(creds.token)}`;

export const fetchBoardLists = async (
  boardId: string,
  creds: TrelloCreds,
  baseUrl: string = TRELLO_API_BASE
): Promise<TrelloList[]> => {
  const res = await fetch(
    `${baseUrl}/boards/${encodeURIComponent(boardId)}/lists?filter=open&fields=id,name&${authQuery(creds)}`
  );
  if (!res.ok) throw new Error(`Trello API ${res.status} on GET /boards/${boardId}/lists`);
  return res.json() as Promise<TrelloList[]>;
};

export const fetchBoardLabels = async (
  boardId: string,
  creds: TrelloCreds,
  baseUrl: string = TRELLO_API_BASE
): Promise<TrelloLabel[]> => {
  const res = await fetch(
    `${baseUrl}/boards/${encodeURIComponent(boardId)}/labels?filter=open&fields=id,name&${authQuery(creds)}`
  );
  if (!res.ok) throw new Error(`Trello API ${res.status} on GET /boards/${boardId}/labels`);
  return res.json() as Promise<TrelloLabel[]>;
};

export const createBoardList = async (
  boardId: string,
  name: string,
  creds: TrelloCreds,
  baseUrl: string = TRELLO_API_BASE
): Promise<TrelloList> => {
  const res = await fetch(`${baseUrl}/lists?${authQuery(creds)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, idBoard: boardId, pos: "bottom" }),
  });
  if (!res.ok) throw new Error(`Trello API ${res.status} on POST /lists`);
  return res.json() as Promise<TrelloList>;
};

export const createBoardLabel = async (
  boardId: string,
  name: string,
  color: string,
  creds: TrelloCreds,
  baseUrl: string = TRELLO_API_BASE
): Promise<TrelloLabel> => {
  const res = await fetch(`${baseUrl}/boards/${encodeURIComponent(boardId)}/labels?${authQuery(creds)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) throw new Error(`Trello API ${res.status} on POST /boards/${boardId}/labels`);
  return res.json() as Promise<TrelloLabel>;
};

export interface SharedColumnMismatch {
  state: CanonicalState;
  mappedName: string;
  similar?: string; // real board name that normalizes to the same value, if any
}

export interface BoardColumnValidationResult {
  ok: boolean;
  createdLists: string[];
  createdLabel?: string;
  missingShared: SharedColumnMismatch[];
  existingLists: TrelloList[];
}

export interface ValidateBoardColumnDeps {
  fetchLists?: (boardId: string) => Promise<TrelloList[]>;
  createList?: (boardId: string, name: string) => Promise<TrelloList>;
  fetchLabels?: (boardId: string) => Promise<TrelloLabel[]>;
  createLabel?: (boardId: string, name: string, color: string) => Promise<TrelloLabel>;
}

/**
 * Ensures dedicated columns exist (creating them idempotently) and reports any
 * shared columns whose mapped name does not exist exactly on the board.
 */
export const validateAndEnsureBoardColumns = async (
  boardId: string,
  stateMap: Record<CanonicalState, string>,
  labelName: string,
  deps: ValidateBoardColumnDeps
): Promise<BoardColumnValidationResult> => {
  const existingLists = await deps.fetchLists!(boardId);
  const exactNames = new Set(existingLists.map((l) => l.name));
  const normalizedMap = new Map(existingLists.map((l) => [normalizeListName(l.name), l.name]));

  const createdLists: string[] = [];
  for (const state of DEDICATED_STATES) {
    const desiredName = stateMap[state];
    if (!exactNames.has(desiredName)) {
      const created = await deps.createList!(boardId, desiredName);
      existingLists.push(created);
      exactNames.add(created.name);
      normalizedMap.set(normalizeListName(created.name), created.name);
      createdLists.push(created.name);
    }
  }

  let createdLabel: string | undefined;
  try {
    const existingLabels = await deps.fetchLabels!(boardId);
    if (!existingLabels.some((l) => l.name === labelName)) {
      const created = await deps.createLabel!(boardId, labelName, DEFAULT_LABEL_COLOR);
      createdLabel = created.name;
    }
  } catch {
    // Label creation is not fatal to boot; the connector will fail later if it
    // really needs the flag and it is absent. We still try because setup-trello
    // wants it created automatically.
  }

  const missingShared: SharedColumnMismatch[] = [];
  for (const state of SHARED_STATES) {
    const mappedName = stateMap[state];
    if (!exactNames.has(mappedName)) {
      missingShared.push({ state, mappedName, similar: normalizedMap.get(normalizeListName(mappedName)) });
    }
  }

  return {
    ok: missingShared.length === 0,
    createdLists,
    createdLabel,
    missingShared,
    existingLists,
  };
};

/**
 * Convenience wrapper that wires the real Trello API calls.
 */
export const validateAndEnsureBoardColumnsWithCreds = async (
  boardId: string,
  stateMap: Record<CanonicalState, string>,
  creds: TrelloCreds,
  labelName: string = DEFAULT_LABEL_NAME,
  baseUrl: string = TRELLO_API_BASE
): Promise<BoardColumnValidationResult> =>
  validateAndEnsureBoardColumns(boardId, stateMap, labelName, {
    fetchLists: (id) => fetchBoardLists(id, creds, baseUrl),
    createList: (id, name) => createBoardList(id, name, creds, baseUrl),
    fetchLabels: (id) => fetchBoardLabels(id, creds, baseUrl),
    createLabel: (id, name, color) => createBoardLabel(id, name, color, creds, baseUrl),
  });
