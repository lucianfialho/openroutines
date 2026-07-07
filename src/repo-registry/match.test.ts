import { describe, it, expect } from "vitest";
import { matchRepoByLabels, suggestRepoSlug, type RepoResolution } from "./match.js";
import type { RepoConfig, RepoRegistry } from "./schema.js";

const repo = (over: Partial<RepoConfig> = {}): RepoConfig => ({
  clonePath: "/tmp/x",
  githubRepo: "org/x",
  baseBranch: "development",
  verify: { build: "true", test: "true" },
  critical: false,
  ...over,
});

const registry: RepoRegistry = {
  repos: {
    openroutines: repo(),
    "openroutines-sandbox": repo(),
    detectwater: repo({ labels: ["Detect Water"] }),
    "beta-app": repo(),
  },
};

describe("matchRepoByLabels", () => {
  it("matches a registry key case-insensitively/trimmed", () => {
    expect(matchRepoByLabels(registry, ["  Beta-App "], [])).toBe("beta-app");
  });

  it("matches an alias (RepoConfig.labels) and returns the KEY", () => {
    expect(matchRepoByLabels(registry, ["Detect Water"], [])).toBe("detectwater");
    expect(matchRepoByLabels(registry, ["detect water"], [])).toBe("detectwater");
  });

  it("skips excluded flag labels (the OpenRoutines flag never routes to the same-named repo)", () => {
    expect(matchRepoByLabels(registry, ["OpenRoutines"], ["OpenRoutines"])).toBeUndefined();
  });

  it("routes on a later non-excluded label after skipping the excluded flag", () => {
    expect(matchRepoByLabels(registry, ["OpenRoutines", "beta-app"], ["OpenRoutines"])).toBe("beta-app");
  });

  it("does not resolve a label ambiguous across two repos — it tries the next label instead", () => {
    // "shared" is an alias of two different repos → ambiguous.
    const ambig: RepoRegistry = {
      repos: { one: repo({ labels: ["shared"] }), two: repo({ labels: ["shared"] }), "beta-app": repo() },
    };
    expect(matchRepoByLabels(ambig, ["shared"], [])).toBeUndefined();
    expect(matchRepoByLabels(ambig, ["shared", "beta-app"], [])).toBe("beta-app");
  });

  it("takes the FIRST matching label, in order", () => {
    expect(matchRepoByLabels(registry, ["beta-app", "detectwater"], [])).toBe("beta-app");
  });

  it("returns undefined when no label matches", () => {
    expect(matchRepoByLabels(registry, ["bug", "urgent"], [])).toBeUndefined();
  });
});

describe("suggestRepoSlug", () => {
  it("suggests a key for a typo within edit distance 2", () => {
    expect(suggestRepoSlug(registry, "openroutine")).toBe("openroutines"); // missing trailing 's', dist 1
    expect(suggestRepoSlug(registry, "beta-ap")).toBe("beta-app"); // dist 1
  });

  it("suggests the KEY even when the closest match is an alias", () => {
    expect(suggestRepoSlug(registry, "detect wate")).toBe("detectwater"); // near the "Detect Water" alias
  });

  it("returns undefined when nothing is within distance 2", () => {
    expect(suggestRepoSlug(registry, "totally-different")).toBeUndefined();
  });

  it("breaks ties by smallest distance then alphabetical key", () => {
    const reg: RepoRegistry = { repos: { alpha: repo(), alpen: repo() } };
    // "alphx": dist 1 to "alpha", dist 2 to "alpen" → smaller distance wins
    expect(suggestRepoSlug(reg, "alphx")).toBe("alpha");
    const tie: RepoRegistry = { repos: { cat: repo(), car: repo() } };
    // "cap": dist 1 to both → alphabetical key wins ("car" < "cat")
    expect(suggestRepoSlug(tie, "cap")).toBe("car");
  });
});

describe("RepoResolution type", () => {
  it("narrows on ok and on reason", () => {
    const ok: RepoResolution = { ok: true, repo: "beta-app" };
    const unmatched: RepoResolution = { ok: false, reason: "field_unmatched", field: "nope", suggestion: "beta-app" };
    const unresolved: RepoResolution = { ok: false, reason: "unresolved" };
    expect(ok.ok && ok.repo).toBe("beta-app");
    expect(!unmatched.ok && unmatched.reason === "field_unmatched" && unmatched.suggestion).toBe("beta-app");
    expect(!unresolved.ok && unresolved.reason).toBe("unresolved");
  });
});
