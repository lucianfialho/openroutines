import { describe, it, expect } from "vitest";
import {
  parseGithubRemote,
  detectVerify,
  detectBaseBranch,
  discoverRepos,
  type DiscoveryDeps,
} from "./discovery.js";
import { VERIFY_DEFAULTS } from "./schema.js";

const deps = (over: Partial<DiscoveryDeps> = {}): DiscoveryDeps => ({
  listDir: () => [],
  isGitRepo: () => true,
  git: () => "",
  fileExists: () => false,
  ...over,
});

describe("parseGithubRemote", () => {
  it("parses ssh, https, and https-without-.git remotes", () => {
    expect(parseGithubRemote("git@github.com:lucianfialho/openroutines.git")).toBe("lucianfialho/openroutines");
    expect(parseGithubRemote("https://github.com/acme/foo.git")).toBe("acme/foo");
    expect(parseGithubRemote("https://github.com/acme/foo")).toBe("acme/foo");
  });
  it("returns '' for empty or non-github remotes", () => {
    expect(parseGithubRemote("")).toBe("");
    expect(parseGithubRemote("git@gitlab.com:x/y.git")).toBe("");
  });
});

describe("detectVerify", () => {
  it("no package.json -> no-op gate (refined by a Mapping card later)", () => {
    expect(detectVerify("/r", deps({ fileExists: () => false }))).toEqual({ build: "true", test: "true" });
  });
  it("pnpm lockfile -> pnpm preset", () => {
    const d = deps({ fileExists: (_r, f) => f === "package.json" || f === "pnpm-lock.yaml" });
    expect(detectVerify("/r", d)).toEqual(VERIFY_DEFAULTS.pnpm);
  });
  it("plain package.json -> npm preset", () => {
    expect(detectVerify("/r", deps({ fileExists: (_r, f) => f === "package.json" }))).toEqual(VERIFY_DEFAULTS.npm);
  });
});

describe("detectBaseBranch (never main/master — D14)", () => {
  it("prefers development when the remote branch exists", () => {
    const d = deps({ git: (args) => (args.join(" ").includes("refs/remotes/origin/development") ? "sha" : "") });
    expect(detectBaseBranch("/r", d)).toBe("development");
  });
  it("falls back to the repo's default branch when it isn't main/master", () => {
    const d = deps({ git: (args) => (args[0] === "symbolic-ref" ? "origin/staging" : "") });
    expect(detectBaseBranch("/r", d)).toBe("staging");
  });
  it("never returns main — falls back to development", () => {
    const d = deps({ git: (args) => (args[0] === "symbolic-ref" ? "origin/main" : "") });
    expect(detectBaseBranch("/r", d)).toBe("development");
  });
});

describe("discoverRepos", () => {
  it("registers git dirs by name; skips non-git dirs and dotfiles", () => {
    const d = deps({
      listDir: () => ["repo-a", ".hidden", "not-git"],
      isGitRepo: (p) => p.endsWith("repo-a"),
      git: (args) => (args[0] === "remote" ? "git@github.com:acme/repo-a.git" : ""),
      fileExists: (_r, f) => f === "package.json",
    });
    const repos = discoverRepos("/base", d);
    expect(Object.keys(repos)).toEqual(["repo-a"]);
    expect(repos["repo-a"]).toMatchObject({
      clonePath: "/base/repo-a",
      githubRepo: "acme/repo-a",
      baseBranch: "development",
      verify: VERIFY_DEFAULTS.npm,
    });
  });
});
