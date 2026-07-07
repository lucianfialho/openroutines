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

/**
 * Classification labels (card type + "don't group" hint) created idempotently
 * at boot in addition to the flag label above, and by
 * scripts/setup-trello-board.ts — single source for both. Color choice is
 * free (not a functional requirement) — one distinct color per label so the
 * board reads clearly out of the box.
 */
export const CLASSIFICATION_LABEL_COLORS: Record<string, string> = {
  "OpenRoutines: Pesquisa": "blue",
  "OpenRoutines: Mapeamento": "yellow",
  "OpenRoutines: Update": "orange",
  "Não agrupar": "red",
};

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

/**
 * Resolves a wizard answer to one of `lists`: either a 1-based index into the
 * numbered list as displayed to the user, or a name matched via
 * normalizeListName (case/accent-insensitive). Returns undefined when the
 * answer matches neither; callers decide the fallback (treat as a literal
 * new name, or reject). Shared by runOnboarding and runRemapWizard so both
 * wizards accept the same input.
 */
export const resolveListPick = (answer: string, lists: TrelloList[]): TrelloList | undefined => {
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= lists.length) return lists[index - 1];
  const normalized = normalizeListName(answer);
  return lists.find((l) => normalizeListName(l.name) === normalized);
};

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
  /** Classification labels created this run (Pesquisa/Mapeamento/Update/Nao agrupar). */
  createdLabels: string[];
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
 * Ensures dedicated columns and every label (flag + classification) exist
 * (creating them idempotently, matched case/accent-insensitively so a column
 * or label that already exists under a different case never gets a
 * duplicate), and reports any shared columns whose mapped name does not
 * exist exactly on the board.
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
    if (!normalizedMap.has(normalizeListName(desiredName))) {
      const created = await deps.createList!(boardId, desiredName);
      existingLists.push(created);
      exactNames.add(created.name);
      normalizedMap.set(normalizeListName(created.name), created.name);
      createdLists.push(created.name);
    }
  }

  let createdLabel: string | undefined;
  const createdLabels: string[] = [];
  try {
    const existingLabels = await deps.fetchLabels!(boardId);
    const normalizedLabels = new Map(existingLabels.map((l) => [normalizeListName(l.name), l.name]));

    if (!normalizedLabels.has(normalizeListName(labelName))) {
      const created = await deps.createLabel!(boardId, labelName, DEFAULT_LABEL_COLOR);
      createdLabel = created.name;
      normalizedLabels.set(normalizeListName(created.name), created.name);
    }

    for (const [name, color] of Object.entries(CLASSIFICATION_LABEL_COLORS)) {
      if (!normalizedLabels.has(normalizeListName(name))) {
        const created = await deps.createLabel!(boardId, name, color);
        normalizedLabels.set(normalizeListName(created.name), created.name);
        createdLabels.push(created.name);
      }
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
    createdLabels,
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
