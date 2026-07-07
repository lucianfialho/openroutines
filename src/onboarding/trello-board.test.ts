import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_COLUMNS,
  type CanonicalState,
} from "./index.js";
import {
  normalizeListName,
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
    expect(deps.createList).toHaveBeenCalledTimes(2);
    expect(deps.createList).toHaveBeenNthCalledWith(1, "board1", "OpenRoutines — Fila");
    expect(deps.createList).toHaveBeenNthCalledWith(2, "board1", "OpenRoutines — Working");
    expect(deps.createLabel).toHaveBeenCalledWith("board1", "OpenRoutines", "green");
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
    deps.fetchLabels.mockResolvedValue([{ id: "x", name: "OpenRoutines" }]);

    const result = await validateAndEnsureBoardColumns("board1", stateMap, "OpenRoutines", deps);

    expect(result.ok).toBe(true);
    expect(result.createdLists).toEqual([]);
    expect(result.createdLabel).toBeUndefined();
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
