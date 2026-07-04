import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { canOpenPr, type CanOpenPrDeps } from "./pr-cap.js";
import { makeInMemoryPrLinkRepository } from "../persistence/pr-links-in-memory.js";
import type { RepoRegistry } from "../repo-registry/schema.js";

const registry: RepoRegistry = {
  repos: {
    "acme-widgets": {
      clonePath: "/tmp/acme",
      githubRepo: "acme/widgets",
      baseBranch: "development",
      verify: { build: "true", test: "true" },
    },
  },
};

const baseDeps = (overrides: Partial<CanOpenPrDeps> = {}): CanOpenPrDeps => ({
  prLinks: makeInMemoryPrLinkRepository(),
  nightPrCap: 6,
  perRepoOpenPrCap: 3,
  githubToken: "gh_test",
  registry,
  ...overrides,
});

describe("canOpenPr", () => {
  it("denies when the global night PR cap is already reached (AC4)", async () => {
    const prLinks = makeInMemoryPrLinkRepository();
    for (let i = 0; i < 6; i++) {
      await prLinks.create({ sourceId: "s", taskId: `t${i}`, repo: "acme-widgets", branch: `b${i}`, status: "open" });
    }
    const makeGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed([]) })) as unknown as CanOpenPrDeps["makeGithub"];
    const deps = baseDeps({ prLinks, nightPrCap: 6, makeGithub });

    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "acme-widgets" });

    expect(ok).toBe(false);
    expect(makeGithub).not.toHaveBeenCalled(); // global cap short-circuits before any GitHub call
  });

  it("denies when the repo already has 3 open openroutines/card-* PRs (AC4)", async () => {
    const openPrs = [
      { number: 1, title: "a", url: "u1", state: "OPEN", headRefName: "openroutines/card-a" },
      { number: 2, title: "b", url: "u2", state: "OPEN", headRefName: "openroutines/card-b" },
      { number: 3, title: "c", url: "u3", state: "OPEN", headRefName: "openroutines/card-c" },
      // A human PR on the same repo must not count against the cap.
      { number: 4, title: "human", url: "u4", state: "OPEN", headRefName: "feature/manual" },
    ];
    const makeGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed(openPrs) })) as unknown as CanOpenPrDeps["makeGithub"];
    const deps = baseDeps({ makeGithub });

    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "acme-widgets" });

    expect(ok).toBe(false);
    expect(makeGithub).toHaveBeenCalledWith({ token: "gh_test", repo: "acme/widgets" });
  });

  it("allows when under both caps", async () => {
    const openPrs = [{ number: 1, title: "a", url: "u1", state: "OPEN", headRefName: "openroutines/card-a" }];
    const makeGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed(openPrs) })) as unknown as CanOpenPrDeps["makeGithub"];
    const deps = baseDeps({ makeGithub });

    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "acme-widgets" });

    expect(ok).toBe(true);
  });

  it("resolves the repo by registry slug case-insensitively, like resolveRepoBySlug", async () => {
    const makeGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed([]) })) as unknown as CanOpenPrDeps["makeGithub"];
    const deps = baseDeps({ makeGithub });

    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "Acme-Widgets" });

    expect(ok).toBe(true);
    expect(makeGithub).toHaveBeenCalledWith({ token: "gh_test", repo: "acme/widgets" });
  });

  it("denies (fail-closed) when the repo cannot be resolved in the registry", async () => {
    const deps = baseDeps();
    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "unknown-repo" });
    expect(ok).toBe(false);
  });

  it("respects a custom perRepoOpenPrCap sourced from policy.yaml (F5 #168) — 1 open PR already denies under cap=1", async () => {
    const openPrs = [{ number: 1, title: "a", url: "u1", state: "OPEN", headRefName: "openroutines/card-a" }];
    const makeGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed(openPrs) })) as unknown as CanOpenPrDeps["makeGithub"];
    const deps = baseDeps({ makeGithub, perRepoOpenPrCap: 1 });

    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "acme-widgets" });

    expect(ok).toBe(false); // same 1-PR fixture that "allows when under both caps" (cap=3) permits
  });

  it("falls back to the pre-#168 default (3) when perRepoOpenPrCap is omitted, for callers not yet wired to policy", async () => {
    const openPrs = [
      { number: 1, title: "a", url: "u1", state: "OPEN", headRefName: "openroutines/card-a" },
      { number: 2, title: "b", url: "u2", state: "OPEN", headRefName: "openroutines/card-b" },
    ];
    const makeGithub = vi.fn(() => ({ listPullRequests: () => Effect.succeed(openPrs) })) as unknown as CanOpenPrDeps["makeGithub"];
    // Built directly (not via baseDeps, which always sets perRepoOpenPrCap) so
    // the field is genuinely absent, matching a caller not yet wired to policy.
    const deps: CanOpenPrDeps = { prLinks: makeInMemoryPrLinkRepository(), nightPrCap: 6, githubToken: "gh_test", registry, makeGithub };

    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "acme-widgets" });

    expect(ok).toBe(true); // 2 < default 3
  });

  it("denies (fail-closed) when the GitHub API call errors", async () => {
    const makeGithub = vi.fn(() => ({
      listPullRequests: () => Effect.fail(new Error("gh: rate limited")),
    })) as unknown as CanOpenPrDeps["makeGithub"];
    const deps = baseDeps({ makeGithub });

    const ok = await canOpenPr(deps, { nightId: "night-1", repo: "acme-widgets" });

    expect(ok).toBe(false);
  });
});
