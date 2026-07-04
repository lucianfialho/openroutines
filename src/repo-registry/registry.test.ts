import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseRepoRegistry, RepoRegistryParseError } from "./parser.js";
import { loadRepoRegistry, resolveRepo, resolveRepoBySlug } from "./registry.js";
import { RepoConfigSchema } from "./schema.js";

// The real repos.yaml at repo root — read directly, mirroring the pattern in
// connector/trello.test.ts (readFileSync against a URL relative to this file).
const rootRegistry = parseRepoRegistry(
  readFileSync(new URL("../../repos.yaml", import.meta.url), "utf-8")
);

describe("repos.yaml (root) — acceptance criteria", () => {
  it("1. validates the 2 pilot repos against RepoRegistrySchema without error", () => {
    expect(Object.keys(rootRegistry.repos).sort()).toEqual(["detectwater", "openroutines"]);
  });

  it("2. resolveRepo('openroutines') returns the expected config; unknown name returns undefined", () => {
    expect(resolveRepo(rootRegistry, "openroutines")).toMatchObject({
      clonePath: "/home/openroutines/repos/openroutines",
      githubRepo: "lucianfialho/openroutines",
      baseBranch: "development",
    });
    expect(resolveRepo(rootRegistry, "does-not-exist")).toBeUndefined();
  });

  it("6. resolveRepoBySlug('DetectWater') resolves to the same entry as 'detectwater'", () => {
    expect(resolveRepoBySlug(rootRegistry, "DetectWater")).toBe(rootRegistry.repos.detectwater);
    expect(resolveRepoBySlug(rootRegistry, "  DetectWater  ")).toBe(rootRegistry.repos.detectwater);
  });

  it("resolveRepoBySlug: no fuzzy match — an unknown slug returns undefined", () => {
    expect(resolveRepoBySlug(rootRegistry, "detect-water")).toBeUndefined();
  });
});

describe("3. RepoConfigSchema rejects baseBranch main/master", () => {
  const base = {
    clonePath: "/x",
    githubRepo: "owner/repo",
    verify: { build: "npm run build", test: "npm test" },
  };

  it("rejects main with a clear message", () => {
    const result = RepoConfigSchema.safeParse({ ...base, baseBranch: "main" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/main\/master/);
    }
  });

  it("rejects master", () => {
    expect(RepoConfigSchema.safeParse({ ...base, baseBranch: "master" }).success).toBe(false);
  });

  it("accepts a non-main/master branch", () => {
    expect(RepoConfigSchema.safeParse({ ...base, baseBranch: "development" }).success).toBe(true);
  });
});

describe("RepoConfigSchema.critical (F4 #158, D29)", () => {
  const base = {
    clonePath: "/x",
    githubRepo: "owner/repo",
    baseBranch: "development",
    verify: { build: "npm run build", test: "npm test" },
  };

  it("defaults to false when absent", () => {
    const result = RepoConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.critical).toBe(false);
  });

  it("accepts an explicit critical: true", () => {
    const result = RepoConfigSchema.safeParse({ ...base, critical: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.critical).toBe(true);
  });
});

describe("RepoConfigSchema.family (F5 #164, D26)", () => {
  const base = {
    clonePath: "/x",
    githubRepo: "owner/repo",
    baseBranch: "development",
    verify: { build: "npm run build", test: "npm test" },
  };

  it("is absent (undefined) when not declared", () => {
    const result = RepoConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.family).toBeUndefined();
  });

  it("is preserved when declared", () => {
    const result = RepoConfigSchema.safeParse({ ...base, family: "whatsapp-agent" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.family).toBe("whatsapp-agent");
  });
});

describe("loadRepoRegistry", () => {
  const originalEnv = process.env.REPOS_REGISTRY_PATH;
  const dirs: string[] = [];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.REPOS_REGISTRY_PATH;
    else process.env.REPOS_REGISTRY_PATH = originalEnv;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const writeRegistry = (yaml: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "repo-registry-"));
    dirs.push(dir);
    const file = join(dir, "repos.yaml");
    writeFileSync(file, yaml);
    return file;
  };

  it("reads REPOS_REGISTRY_PATH when no explicit path is given", () => {
    process.env.REPOS_REGISTRY_PATH = writeRegistry(
      "repos:\n  foo:\n    clonePath: /x\n    githubRepo: acme/foo\n    baseBranch: development\n    verify:\n      build: npm run build\n      test: npm test\n"
    );

    expect(resolveRepo(loadRepoRegistry(), "foo")?.githubRepo).toBe("acme/foo");
  });

  it("an explicit path argument overrides REPOS_REGISTRY_PATH", () => {
    process.env.REPOS_REGISTRY_PATH = "/should/not/be/read.yaml";
    const file = writeRegistry(
      "repos:\n  bar:\n    clonePath: /x\n    githubRepo: acme/bar\n    baseBranch: development\n    verify:\n      build: npm run build\n      test: npm test\n"
    );

    expect(resolveRepo(loadRepoRegistry(file), "bar")?.githubRepo).toBe("acme/bar");
  });

  it("throws RepoRegistryParseError for a registry with an invalid baseBranch", () => {
    const file = writeRegistry(
      "repos:\n  bad:\n    clonePath: /x\n    githubRepo: acme/bad\n    baseBranch: main\n    verify:\n      build: npm run build\n      test: npm test\n"
    );

    expect(() => loadRepoRegistry(file)).toThrow(RepoRegistryParseError);
  });
});
