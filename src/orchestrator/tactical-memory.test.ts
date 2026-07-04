import { describe, it, expect } from "vitest";
import {
  findSimilarMergedCards,
  makeSimilarCards,
  mapEscopoToSection,
  promoteRecurringLearnings,
  type OpenProfilePrArgs,
  type SimilarCardsDeps,
} from "./tactical-memory.js";
import { makeInMemoryRepository } from "../persistence/in-memory.js";
import { makeInMemoryPrLinkRepository } from "../persistence/pr-links-in-memory.js";
import { makeInMemoryTaskRepository } from "../persistence/task-in-memory.js";
import { makeInMemoryRepoLearningRepository } from "../persistence/repo-learnings-in-memory.js";
import type { Task } from "../task-source/types.js";
import type { RunState } from "../persistence/types.js";

const task = (over: Partial<Task>): Task =>
  ({ sourceId: "trello", id: "t", title: "", labels: [], ...over } as Task);

/**
 * Seed a completed, merged card in the history: one execution + one merged
 * pr_link + one task snapshot (+ optional plano run-state carrying a summary).
 */
const seedMergedCard = async (
  deps: {
    executions: ReturnType<typeof makeInMemoryRepository>;
    prLinks: ReturnType<typeof makeInMemoryPrLinkRepository>;
    tasks: ReturnType<typeof makeInMemoryTaskRepository>;
    runStates?: RunState[];
  },
  args: { execId: string; taskId: string; repo: string; title: string; labels: string[]; prNumber: number; summary?: string; at?: Date }
) => {
  await deps.executions.save({
    id: args.execId,
    routineId: "r",
    triggerType: "card-execution",
    skillName: "card-to-pr",
    status: "completed",
    sourceId: "trello",
    taskId: args.taskId,
    startedAt: args.at ?? new Date(),
  });
  await deps.prLinks.create({ sourceId: "trello", taskId: args.taskId, repo: args.repo, prNumber: args.prNumber, branch: `b/${args.taskId}`, status: "merged" });
  await deps.tasks.save(task({ id: args.taskId, title: args.title, labels: args.labels }));
  if (args.summary !== undefined && deps.runStates) {
    deps.runStates.push({ executionId: args.execId, stateId: "plano", skillId: "card-to-pr", output: { summary: args.summary }, status: "completed", startedAt: new Date() });
  }
};

const makeDeps = () => {
  const executions = makeInMemoryRepository();
  const prLinks = makeInMemoryPrLinkRepository();
  const tasks = makeInMemoryTaskRepository();
  const runStates: RunState[] = [];
  const deps: SimilarCardsDeps = {
    executions,
    prLinks,
    tasks,
    runStates: { findByExecution: async (executionId) => runStates.filter((s) => s.executionId === executionId) },
  };
  return { executions, prLinks, tasks, runStates, deps };
};

describe("findSimilarMergedCards", () => {
  it("returns the 2 most similar merged cards (label + title-keyword overlap), titles + PR links + summary", async () => {
    const h = makeDeps();
    await seedMergedCard(h, { execId: "e1", taskId: "c1", repo: "org/repo", title: "Add rate limiting to login", labels: ["backend", "security"], prNumber: 11, summary: "token bucket per IP" });
    await seedMergedCard(h, { execId: "e2", taskId: "c2", repo: "org/repo", title: "Rate limiting for signup", labels: ["backend"], prNumber: 12 });
    await seedMergedCard(h, { execId: "e3", taskId: "c3", repo: "org/repo", title: "Totally unrelated typo fix", labels: ["docs"], prNumber: 13 });

    const result = await findSimilarMergedCards(
      { title: "Rate limiting on password reset", labels: ["backend", "security"] },
      "org/repo",
      h.deps,
      2
    );

    expect(result).toHaveLength(2);
    // c1 shares both labels + "rate"/"limiting" keywords → ranks first.
    expect(result[0].title).toBe("Add rate limiting to login");
    expect(result[0].prUrl).toBe("https://github.com/org/repo/pull/11");
    expect(result[0].summary).toBe("token bucket per IP");
    expect(result.map((r) => r.title)).not.toContain("Totally unrelated typo fix");
  });

  it("returns [] when the repo has no merged history (empty precedent block, no error)", async () => {
    const h = makeDeps();
    expect(await findSimilarMergedCards({ title: "anything" }, "org/empty", h.deps)).toEqual([]);
  });

  it("ignores merged PRs of a different repo and non-merged PRs", async () => {
    const h = makeDeps();
    await seedMergedCard(h, { execId: "e1", taskId: "c1", repo: "org/other", title: "Rate limiting", labels: ["backend"], prNumber: 1 });
    // open (not merged) PR in the target repo
    await h.executions.save({ id: "e2", routineId: "r", triggerType: "card-execution", skillName: "card-to-pr", status: "completed", sourceId: "trello", taskId: "c2", startedAt: new Date() });
    await h.prLinks.create({ sourceId: "trello", taskId: "c2", repo: "org/repo", prNumber: 2, branch: "b2", status: "open" });
    await h.tasks.save(task({ id: "c2", title: "Rate limiting here", labels: ["backend"] }));

    expect(await findSimilarMergedCards({ title: "Rate limiting", labels: ["backend"] }, "org/repo", h.deps)).toEqual([]);
  });

  it("never returns the current card as its own precedent", async () => {
    const h = makeDeps();
    await seedMergedCard(h, { execId: "e1", taskId: "self", repo: "org/repo", title: "Add caching layer", labels: ["backend"], prNumber: 5 });
    const result = await findSimilarMergedCards({ title: "Add caching layer", labels: ["backend"], sourceId: "trello", taskId: "self" }, "org/repo", h.deps);
    expect(result).toEqual([]);
  });

  it("deduplicates a card that ran multiple executions (rework) into one precedent", async () => {
    const h = makeDeps();
    // two completed executions for the SAME card/task, one merged PR
    await seedMergedCard(h, { execId: "e-old", taskId: "c1", repo: "org/repo", title: "Add search endpoint", labels: ["backend"], prNumber: 7, at: new Date(1000) });
    await h.executions.save({ id: "e-new", routineId: "r", triggerType: "card-execution", skillName: "card-to-pr", status: "completed", sourceId: "trello", taskId: "c1", startedAt: new Date(2000) });

    const result = await findSimilarMergedCards({ title: "Add search endpoint v2", labels: ["backend"] }, "org/repo", h.deps);
    expect(result).toHaveLength(1);
  });
});

describe("makeSimilarCards — SimilarCardsFn adapter", () => {
  it("pulls the current card's own labels from the task snapshot via inputs", async () => {
    const h = makeDeps();
    await seedMergedCard(h, { execId: "e1", taskId: "c1", repo: "org/repo", title: "Add rate limiting", labels: ["security"], prNumber: 11 });
    // current card snapshot (labels only reachable via tasks.findByKey)
    await h.tasks.save(task({ id: "current", title: "Rate limit reset", labels: ["security"] }));

    const fn = makeSimilarCards(h.deps);
    const result = await fn("org/repo", { source_id: "trello", task_id: "current", title: "Rate limit reset" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Add rate limiting");
  });
});

describe("mapEscopoToSection", () => {
  it("maps gotcha → Gotchas and everything else → Instruções para Agentes", () => {
    expect(mapEscopoToSection("gotcha")).toBe("Gotchas");
    expect(mapEscopoToSection("Gotchas")).toBe("Gotchas");
    expect(mapEscopoToSection("convenção")).toBe("Instruções para Agentes");
    expect(mapEscopoToSection(undefined)).toBe("Instruções para Agentes");
  });
});

describe("promoteRecurringLearnings", () => {
  it("opens 1 docs PR per freq>=3 fact, marks it promoted, and never re-promotes on a second call", async () => {
    const repoLearnings = makeInMemoryRepoLearningRepository();
    // freq 3 → promotable; the section derives from escopo.
    for (let i = 0; i < 3; i++) await repoLearnings.upsertByFato("org/repo", { fato: "Run tests with CI=1", escopo: "gotcha" });
    // freq 2 → not promotable.
    for (let i = 0; i < 2; i++) await repoLearnings.upsertByFato("org/repo", { fato: "Prefers named exports", escopo: "convenção" });

    const prCalls: OpenProfilePrArgs[] = [];
    const openProfilePr = async (args: OpenProfilePrArgs) => {
      prCalls.push(args);
      return { url: `https://github.com/${args.repo}/pull/99` };
    };

    const first = await promoteRecurringLearnings({ repoLearnings, openProfilePr });
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0]).toMatchObject({ repo: "org/repo", section: "Gotchas", fato: "Run tests with CI=1" });
    expect(first).toEqual([{ repo: "org/repo", promoted: ["Run tests with CI=1"] }]);

    // idempotent: the fact is now marked promoted → no second PR.
    const second = await promoteRecurringLearnings({ repoLearnings, openProfilePr });
    expect(prCalls).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("returns [] and opens no PR when nothing is promotable", async () => {
    const repoLearnings = makeInMemoryRepoLearningRepository();
    await repoLearnings.upsertByFato("org/repo", { fato: "seen once" });
    let calls = 0;
    const result = await promoteRecurringLearnings({ repoLearnings, openProfilePr: async () => { calls++; return { url: "x" }; } });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });
});
