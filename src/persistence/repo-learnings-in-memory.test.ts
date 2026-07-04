import { describe, it, expect } from "vitest";
import { makeInMemoryRepoLearningRepository } from "./repo-learnings-in-memory.js";

describe("makeInMemoryRepoLearningRepository", () => {
  it("upsertByFato dedupes a normalized repeat (lowercase+trim) into freq 2, one row", async () => {
    const repo = makeInMemoryRepoLearningRepository();

    await repo.upsertByFato("org/repo-a", { fato: "Prefers named exports", evidencia: "file1.ts" });
    await repo.upsertByFato("org/repo-a", { fato: "  prefers named exports  " });

    const top = await repo.findTopByRepo("org/repo-a", 10);
    expect(top).toHaveLength(1);
    expect(top[0].freq).toBe(2);
    expect(top[0].vistoEm).toHaveLength(2);
    // First-seen evidencia is kept when the repeat sighting doesn't supply a new one.
    expect(top[0].evidencia).toBe("file1.ts");
  });

  it("a new evidencia on a repeat sighting refreshes the stored value", async () => {
    const repo = makeInMemoryRepoLearningRepository();
    await repo.upsertByFato("org/repo-a", { fato: "Uses tabs not spaces", evidencia: "old.ts" });
    await repo.upsertByFato("org/repo-a", { fato: "uses tabs not spaces", evidencia: "new.ts" });

    const top = await repo.findTopByRepo("org/repo-a", 10);
    expect(top[0].evidencia).toBe("new.ts");
  });

  it("keeps facts isolated per repo even with the same normalized text", async () => {
    const repo = makeInMemoryRepoLearningRepository();
    await repo.upsertByFato("org/repo-a", { fato: "Same fact" });
    await repo.upsertByFato("org/repo-b", { fato: "same fact" });

    expect((await repo.findTopByRepo("org/repo-a", 10))[0].freq).toBe(1);
    expect((await repo.findTopByRepo("org/repo-b", 10))[0].freq).toBe(1);
  });

  it("findTopByRepo orders by freq desc and respects the limit", async () => {
    const repo = makeInMemoryRepoLearningRepository();
    await repo.upsertByFato("org/repo-a", { fato: "Rare fact" });
    await repo.upsertByFato("org/repo-a", { fato: "Common fact" });
    await repo.upsertByFato("org/repo-a", { fato: "common fact" });
    await repo.upsertByFato("org/repo-a", { fato: "common fact" });

    const top = await repo.findTopByRepo("org/repo-a", 1);
    expect(top).toHaveLength(1);
    expect(top[0].fato).toBe("Common fact");
    expect(top[0].freq).toBe(3);
  });

  it("findPromotable returns only freq>=3 and not yet promoted; markPromoted excludes it after", async () => {
    const repo = makeInMemoryRepoLearningRepository();
    await repo.upsertByFato("org/repo-a", { fato: "Frequent fact" });
    await repo.upsertByFato("org/repo-a", { fato: "frequent fact" });
    await repo.upsertByFato("org/repo-a", { fato: "frequent fact" });
    await repo.upsertByFato("org/repo-a", { fato: "Rare fact" });

    const promotable = await repo.findPromotable();
    expect(promotable).toHaveLength(1);
    expect(promotable[0].fato).toBe("Frequent fact");

    await repo.markPromoted(promotable[0].id!);
    expect(await repo.findPromotable()).toHaveLength(0);
  });
});
