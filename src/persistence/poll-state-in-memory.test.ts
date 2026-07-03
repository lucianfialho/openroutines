import { describe, it, expect } from "vitest";
import { makeInMemoryPollStateRepository } from "./poll-state-in-memory.js";

describe("makeInMemoryPollStateRepository", () => {
  it("should return undefined cursor before it is ever set", async () => {
    const repo = makeInMemoryPollStateRepository();
    expect(await repo.getCursor("trello-main")).toBeUndefined();
  });

  it("should round-trip setCursor/getCursor", async () => {
    const repo = makeInMemoryPollStateRepository();
    await repo.setCursor("trello-main", "cursor-1");
    expect(await repo.getCursor("trello-main")).toBe("cursor-1");

    await repo.setCursor("trello-main", "cursor-2");
    expect(await repo.getCursor("trello-main")).toBe("cursor-2");
  });

  it("should round-trip markSeen/hasSeen", async () => {
    const repo = makeInMemoryPollStateRepository();
    expect(await repo.hasSeen("trello-main", "card-1")).toBe(false);

    await repo.markSeen("trello-main", "card-1");
    expect(await repo.hasSeen("trello-main", "card-1")).toBe(true);
    expect(await repo.hasSeen("trello-main", "card-2")).toBe(false);
  });

  it("should keep cursors and seen state isolated per sourceId", async () => {
    const repo = makeInMemoryPollStateRepository();
    await repo.setCursor("trello-main", "cursor-a");
    await repo.setCursor("github-main", "cursor-b");
    await repo.markSeen("trello-main", "card-1");

    expect(await repo.getCursor("trello-main")).toBe("cursor-a");
    expect(await repo.getCursor("github-main")).toBe("cursor-b");
    expect(await repo.hasSeen("github-main", "card-1")).toBe(false);
  });
});
