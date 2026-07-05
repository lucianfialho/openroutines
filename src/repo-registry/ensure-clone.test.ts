import { describe, it, expect, vi } from "vitest";
import { ensureRepoAvailable, resolveGithubRepo } from "./ensure-clone.js";
import type { RepoConfig } from "./schema.js";

const cfg = (over: Partial<RepoConfig> = {}): RepoConfig => ({
  clonePath: "/base/foo",
  githubRepo: "acme/foo",
  baseBranch: "development",
  verify: { build: "b", test: "t" },
  compose: null,
  critical: false,
  ...over,
});

describe("ensureRepoAvailable", () => {
  it("registry hit -> returned as-is, never cloned (legacy contract)", async () => {
    const cloneRepo = vi.fn();
    const known = cfg();
    const r = await ensureRepoAvailable("foo", known, { githubToken: "t", baseDir: "/base", cloneRepo });
    expect(r.config).toBe(known);
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it("unknown name with no REPOS_BASE_DIR -> repo-unresolvable", async () => {
    const r = await ensureRepoAvailable("bar", undefined, { githubToken: "t" });
    expect(r.blockReason).toBe("repo-unresolvable");
  });

  it("unknown name already on disk under baseDir -> discovered, not cloned", async () => {
    const cloneRepo = vi.fn();
    const discovered = cfg({ clonePath: "/base/bar", githubRepo: "acme/bar" });
    const r = await ensureRepoAvailable("bar", undefined, {
      githubToken: "t",
      baseDir: "/base",
      cloneRepo,
      isGitRepo: () => true,
      discover: () => discovered,
    });
    expect(r.config).toBe(discovered);
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it("unknown name resolves owner via the allowlist and clones", async () => {
    const cloneRepo = vi.fn(async () => {});
    const discovered = cfg({ clonePath: "/base/baz", githubRepo: "acme/baz" });
    const r = await ensureRepoAvailable("baz", undefined, {
      githubToken: "t",
      baseDir: "/base",
      allowedOwners: ["nope", "acme"],
      isGitRepo: () => false,
      repoExists: async (gh) => gh === "acme/baz",
      cloneRepo,
      discover: () => discovered,
    });
    expect(cloneRepo).toHaveBeenCalledWith("acme/baz", "/base/baz");
    expect(r.config).toBe(discovered);
  });

  it("no allowed owner resolves -> repo-unresolvable, no clone", async () => {
    const cloneRepo = vi.fn();
    const r = await ensureRepoAvailable("ghost", undefined, {
      githubToken: "t",
      baseDir: "/base",
      allowedOwners: ["acme"],
      isGitRepo: () => false,
      repoExists: async () => false,
      cloneRepo,
    });
    expect(r.blockReason).toBe("repo-unresolvable");
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it("fence: a slug escaping REPOS_BASE_DIR is never cloned", async () => {
    const cloneRepo = vi.fn();
    const r = await ensureRepoAvailable("../evil", undefined, {
      githubToken: "t",
      baseDir: "/base",
      allowedOwners: ["acme"],
      isGitRepo: () => false,
      repoExists: async () => true,
      cloneRepo,
    });
    expect(r.blockReason).toBe("repo-unresolvable");
    expect(cloneRepo).not.toHaveBeenCalled();
  });
});

describe("resolveGithubRepo", () => {
  it("returns the first allowed owner that resolves on GitHub", async () => {
    const r = await resolveGithubRepo("foo", {
      githubToken: "t",
      allowedOwners: ["a", "b"],
      repoExists: async (gh) => gh === "b/foo",
    });
    expect(r).toBe("b/foo");
  });
  it("returns '' when no owner resolves", async () => {
    const r = await resolveGithubRepo("foo", { githubToken: "t", allowedOwners: ["a"], repoExists: async () => false });
    expect(r).toBe("");
  });
});
