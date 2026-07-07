import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_COLUMNS,
  type CanonicalState,
} from "./index.js";
import {
  normalizeListName,
  resolveListPick,
  validateAndEnsureBoardColumns,
  type TrelloList,
  type TrelloLabel,
} from "./trello-board.js";

const stateMap = DEFAULT_COLUMNS;
const emptyDeps = () => ({
  fetchLists: vi.fn(async () => [] as TrelloList[]),
  createList: vi.fn(async (_boardId: string, name: string) => ({ id: `id-${name}`, name })),
  fetchLabels: vi.fn(async () => [] as TrelloLabel[]),
  createLabel: vi.fn(async (_boardId: string, name: string) => ({ id: `label-${name}`, name })),
});

describe("normalizeListName", () => {
  it("is case and accent insensitive", () => {
    expect(normalizeListName("Backlog")).toBe(normalizeListName("BACKLOG"));
    expect(normalizeListName("Revisão")).toBe(normalizeListName("revisao"));
  });
});

describe("resolveListPick", () => {
  const lists: TrelloList[] = [
    { id: "1", name: "Backlog" },
    { id: "2", name: "Blocked" },
    { id: "3", name: "Revisão" },
  ];

  it("resolves a 1-based numeric index into the displayed list", () => {
    expect(resolveListPick("2", lists)).toEqual(lists[1]);
    expect(resolveListPick("3", lists)).toEqual(lists[2]);
  });

  it("resolves a name case/accent-insensitively", () => {
    expect(resolveListPick("revisao", lists)).toEqual(lists[2]);
    expect(resolveListPick("BACKLOG", lists)).toEqual(lists[0]);
  });

  it("returns undefined for an out-of-range index or an unmatched name", () => {
    expect(resolveListPick("9", lists)).toBeUndefined();
    expect(resolveListPick("0", lists)).toBeUndefined();
    expect(resolveListPick("Nonexistent", lists)).toBeUndefined();
  });
});

describe("validateAndEnsureBoardColumns", () => {
  it("creates missing dedicated columns and the flag label", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "l1", name: "Backlog" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.ok).toBe(true);
    expect(result.createdLists).toEqual(["OpenRoutines — Fila", "OpenRoutines — Working"]);
    expect(result.createdLabel).toBe("OpenRoutines");
    expect(result.createdLabels).toEqual([
      "OpenRoutines: Pesquisa",
      "OpenRoutines: Mapeamento",
      "OpenRoutines: Update",
      "Não agrupar",
    ]);
    expect(deps.createList).toHaveBeenCalledTimes(2);
    expect(deps.createList).toHaveBeenNthCalledWith(1, "board1", "OpenRoutines — Fila");
    expect(deps.createList).toHaveBeenNthCalledWith(2, "board1", "OpenRoutines — Working");
    expect(deps.createLabel).toHaveBeenCalledTimes(5); // flag + 4 classification labels
    expect(deps.createLabel).toHaveBeenCalledWith("board1", "OpenRoutines", "green");
    expect(deps.createLabel).toHaveBeenCalledWith("board1", "OpenRoutines: Pesquisa", "blue");
    expect(deps.createLabel).toHaveBeenCalledWith("board1", "Não agrupar", "red");
  });

  it("is idempotent and does not recreate existing dedicated lists/labels", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "q", name: "OpenRoutines — Fila" },
      { id: "w", name: "OpenRoutines — Working" },
      { id: "l1", name: "Backlog" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);
    deps.fetchLabels.mockResolvedValue([
      { id: "x", name: "OpenRoutines" },
      { id: "p", name: "OpenRoutines: Pesquisa" },
      { id: "m", name: "OpenRoutines: Mapeamento" },
      { id: "u", name: "OpenRoutines: Update" },
      { id: "n", name: "Não agrupar" },
    ]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.ok).toBe(true);
    expect(result.createdLists).toEqual([]);
    expect(result.createdLabel).toBeUndefined();
    expect(result.createdLabels).toEqual([]);
    expect(deps.createList).not.toHaveBeenCalled();
    expect(deps.createLabel).not.toHaveBeenCalled();
  });

  it("reports shared columns whose mapped name does not exist exactly", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "q", name: "OpenRoutines — Fila" },
      { id: "w", name: "OpenRoutines — Working" },
      { id: "l1", name: "BACKLOG" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);
    deps.fetchLabels.mockResolvedValue([{ id: "x", name: "OpenRoutines" }]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.ok).toBe(false);
    expect(result.missingShared).toEqual([
      { state: "backlog", mappedName: "Backlog", similar: "BACKLOG" },
    ]);
    expect(result.createdLists).toEqual([]);
  });

  it("reports a missing shared column without a similar match", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "q", name: "OpenRoutines — Fila" },
      { id: "w", name: "OpenRoutines — Working" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);
    deps.fetchLabels.mockResolvedValue([{ id: "x", name: "OpenRoutines" }]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.ok).toBe(false);
    expect(result.missingShared).toContainEqual({
      state: "backlog",
      mappedName: "Backlog",
      similar: undefined,
    });
  });

  it("passes when every mapped column exists exactly", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "l1", name: "Backlog" },
      { id: "q", name: "OpenRoutines — Fila" },
      { id: "w", name: "OpenRoutines — Working" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);
    deps.fetchLabels.mockResolvedValue([{ id: "x", name: "OpenRoutines" }]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.ok).toBe(true);
    expect(result.missingShared).toEqual([]);
    expect(result.createdLists).toEqual([]);
  });
});

describe("validateAndEnsureBoardColumns — normalized existence checks", () => {
  it("does not recreate dedicated lists or the flag label that already exist under a different case", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "q", name: stateMap.queued.toUpperCase() },
      { id: "w", name: stateMap.working.toLowerCase() },
      { id: "l1", name: "Backlog" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);
    deps.fetchLabels.mockResolvedValue([
      { id: "x", name: "OPENROUTINES" },
      { id: "p", name: "OpenRoutines: Pesquisa" },
      { id: "m", name: "OpenRoutines: Mapeamento" },
      { id: "u", name: "OpenRoutines: Update" },
      { id: "n", name: "Não agrupar" },
    ]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.createdLists).toEqual([]);
    expect(result.createdLabel).toBeUndefined();
    expect(deps.createList).not.toHaveBeenCalled();
    expect(deps.createLabel).not.toHaveBeenCalled();
  });

  it("does not recreate classification labels that already exist under a different case/accent", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "q", name: "OpenRoutines — Fila" },
      { id: "w", name: "OpenRoutines — Working" },
      { id: "l1", name: "Backlog" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);
    deps.fetchLabels.mockResolvedValue([
      { id: "x", name: "OpenRoutines" },
      { id: "p", name: "openroutines: pesquisa" },
      { id: "m", name: "OPENROUTINES: MAPEAMENTO" },
      { id: "u", name: "openroutines: update" },
      { id: "n", name: "nao agrupar" }, // no accent, still normalizes to the same value
    ]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.createdLabels).toEqual([]);
    expect(deps.createLabel).not.toHaveBeenCalled();
  });

  it("creates only the missing classification labels on partial overlap", async () => {
    const deps = emptyDeps();
    deps.fetchLists.mockResolvedValue([
      { id: "q", name: "OpenRoutines — Fila" },
      { id: "w", name: "OpenRoutines — Working" },
      { id: "l1", name: "Backlog" },
      { id: "l2", name: "Blocked" },
      { id: "l3", name: "Review" },
      { id: "l4", name: "Done" },
    ]);
    deps.fetchLabels.mockResolvedValue([
      { id: "x", name: "OpenRoutines" },
      { id: "p", name: "OpenRoutines: Pesquisa" },
    ]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.createdLabels).toEqual(["OpenRoutines: Mapeamento", "OpenRoutines: Update", "Não agrupar"]);
    expect(deps.createLabel).toHaveBeenCalledTimes(3);
  });
});
