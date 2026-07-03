import { describe, it, expect } from "vitest";
import { planBoardSetup } from "./setup-trello-board.js";

describe("planBoardSetup", () => {
  it("plans all target lists and labels when none exist yet", () => {
    const result = planBoardSetup(["Backlog", "Review"], ["Bug"]);
    expect(result.listsToCreate).toEqual(["OpenRoutines — Fila", "OpenRoutines — Working"]);
    expect(result.labelsToCreate).toEqual([
      "OpenRoutines",
      "OpenRoutines: Pesquisa",
      "OpenRoutines: Mapeamento",
      "OpenRoutines: Update",
      "Não agrupar",
    ]);
  });

  it("is idempotent: plans nothing once every target already exists", () => {
    const result = planBoardSetup(
      ["Backlog", "OpenRoutines — Fila", "OpenRoutines — Working"],
      ["OpenRoutines", "OpenRoutines: Pesquisa", "OpenRoutines: Mapeamento", "OpenRoutines: Update", "Não agrupar"]
    );
    expect(result).toEqual({ listsToCreate: [], labelsToCreate: [] });
  });

  it("plans only what's missing on partial overlap, exact case-sensitive match", () => {
    const result = planBoardSetup(
      ["OpenRoutines — Fila"],
      ["OpenRoutines", "openroutines: pesquisa" /* wrong case, doesn't count as a match */]
    );
    expect(result.listsToCreate).toEqual(["OpenRoutines — Working"]);
    expect(result.labelsToCreate).toEqual([
      "OpenRoutines: Pesquisa",
      "OpenRoutines: Mapeamento",
      "OpenRoutines: Update",
      "Não agrupar",
    ]);
  });
});
