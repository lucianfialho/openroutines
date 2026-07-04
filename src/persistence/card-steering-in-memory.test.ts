import { describe, it, expect } from "vitest";
import { makeInMemoryCardSteeringRepository } from "./card-steering-in-memory.js";
import type { CardSteering } from "./types.js";

const makeSteering = (overrides: Partial<CardSteering> = {}): CardSteering => ({
  sourceId: "trello-main",
  taskId: "card-1",
  authorTrelloId: "member-1",
  text: "Use the v2 endpoint instead",
  applied: false,
  ...overrides,
});

describe("makeInMemoryCardSteeringRepository", () => {
  it("saves and returns it from findUnapplied", async () => {
    const repo = makeInMemoryCardSteeringRepository();
    await repo.save(makeSteering());

    const found = await repo.findUnapplied();
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe("Use the v2 endpoint instead");
    expect(found[0].applied).toBe(false);
  });

  it("findUnapplied scopes to (sourceId, taskId) when given", async () => {
    const repo = makeInMemoryCardSteeringRepository();
    await repo.save(makeSteering({ taskId: "card-1" }));
    await repo.save(makeSteering({ taskId: "card-2" }));

    const found = await repo.findUnapplied("trello-main", "card-1");
    expect(found).toHaveLength(1);
    expect(found[0].taskId).toBe("card-1");
  });

  it("markApplied flips applied and stores effectType; findUnapplied stops returning it", async () => {
    const repo = makeInMemoryCardSteeringRepository();
    await repo.save(makeSteering());
    const [row] = await repo.findUnapplied();

    await repo.markApplied(row.id!, "reverted-approach");

    expect(await repo.findUnapplied()).toHaveLength(0);
  });
});
