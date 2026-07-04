import { describe, it, expect } from "vitest";
import { makeInMemoryPrFeedbackRepository } from "./pr-feedback-in-memory.js";
import type { PrFeedback } from "./types.js";

const makeFeedback = (overrides: Partial<PrFeedback> = {}): PrFeedback => ({
  repo: "org/repo-a",
  prNumber: 42,
  sourceId: "trello-main",
  taskId: "card-1",
  kind: "review-comment",
  content: "Please rename this variable",
  ...overrides,
});

describe("makeInMemoryPrFeedbackRepository", () => {
  it("saves and finds by repo, newest first", async () => {
    const repo = makeInMemoryPrFeedbackRepository();
    await repo.save(makeFeedback({ content: "first", createdAt: new Date("2024-01-01") }));
    await repo.save(makeFeedback({ content: "second", createdAt: new Date("2024-01-02") }));
    await repo.save(makeFeedback({ repo: "org/other", content: "unrelated" }));

    const found = await repo.findByRepo("org/repo-a");
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.content)).toEqual(["second", "first"]);
  });

  it("finds since a given date, oldest first", async () => {
    const repo = makeInMemoryPrFeedbackRepository();
    await repo.save(makeFeedback({ content: "old", createdAt: new Date("2024-01-01") }));
    await repo.save(makeFeedback({ content: "new", createdAt: new Date("2024-06-01") }));

    const found = await repo.findSince(new Date("2024-03-01"));
    expect(found).toHaveLength(1);
    expect(found[0].content).toBe("new");
  });

  it("allows pr_number to be absent (steering before a PR exists)", async () => {
    const repo = makeInMemoryPrFeedbackRepository();
    await repo.save(makeFeedback({ kind: "steering", prNumber: undefined, content: "do it this way" }));

    const found = await repo.findByRepo("org/repo-a");
    expect(found[0].prNumber).toBeUndefined();
    expect(found[0].kind).toBe("steering");
  });

  it("defaults createdAt when the caller doesn't supply one", async () => {
    const repo = makeInMemoryPrFeedbackRepository();
    await repo.save(makeFeedback({ createdAt: undefined }));
    const found = await repo.findByRepo("org/repo-a");
    expect(found[0].createdAt).toBeInstanceOf(Date);
  });
});
