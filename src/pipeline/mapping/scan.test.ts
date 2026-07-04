import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Effect } from "effect";
import {
  fileShape,
  commitShape,
  parseGitLog,
  mineExemplars,
  detectFrontend,
  makeScan,
  type ScanOutput,
} from "./scan.js";
import type { MappingDeps, MappingProvider } from "./index.js";
import type { CompletionResponse } from "../../provider/types.js";
import type { MappingPreparationOutput } from "./preparation.js";

describe("card-mapping scan — change-shape mining (#162)", () => {
  it("fileShape classifies by path, test winning over ui-component for a .test.tsx", () => {
    expect(fileShape("prisma/migrations/001_x/migration.sql")).toBe("migration");
    expect(fileShape("db/schema.sql")).toBe("migration");
    expect(fileShape("src/routes/pedidos.ts")).toBe("route");
    expect(fileShape("app/pedidos/[id]/page.tsx")).toBe("route");
    expect(fileShape("pages/checkout.tsx")).toBe("route");
    expect(fileShape("src/services/order-service.ts")).toBe("service");
    expect(fileShape("src/tools/github-tool.ts")).toBe("agent-tool");
    expect(fileShape("src/components/Button.tsx")).toBe("ui-component");
    expect(fileShape("src/components/Button.test.tsx")).toBe("test");
    expect(fileShape("src/routes/pedidos.test.ts")).toBe("test");
    expect(fileShape("README.md")).toBeUndefined();
  });

  it("commitShape picks the highest-importance shape (route+test commit is a route)", () => {
    expect(commitShape(["src/routes/x.ts", "src/routes/x.test.ts"])).toBe("route");
    expect(commitShape(["prisma/migrations/001/migration.sql", "src/services/x.ts"])).toBe("migration");
    expect(commitShape(["only.test.ts"])).toBe("test");
    expect(commitShape(["README.md"])).toBeUndefined();
  });

  it("parseGitLog splits `--format=%H --name-only` into commits with their files", () => {
    const out = `${"a".repeat(40)}\nsrc/routes/x.ts\n\n${"b".repeat(40)}\nprisma/migrations/1/migration.sql\n`;
    const commits = parseGitLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe("a".repeat(40));
    expect(commits[0].files).toEqual(["src/routes/x.ts"]);
    expect(commits[1].files).toEqual(["prisma/migrations/1/migration.sql"]);
  });

  it("criterion 5: >=6 commits of distinct shapes yield >=3 distinct change-shapes in exemplars", () => {
    const sha = (c: string) => c.repeat(40);
    const commits = [
      { sha: sha("a"), files: ["prisma/migrations/001/migration.sql"] },
      { sha: sha("b"), files: ["src/routes/pedidos.ts"] },
      { sha: sha("c"), files: ["src/services/order.ts"] },
      { sha: sha("d"), files: ["src/components/Card.tsx"] },
      { sha: sha("e"), files: ["src/tools/gh.ts"] },
      { sha: sha("f"), files: ["src/routes/pedidos.test.ts"] },
    ];
    const exemplars = mineExemplars(commits);
    const distinct = new Set(exemplars.map((e) => e.changeShape));
    expect(distinct.size).toBeGreaterThanOrEqual(3);
    // one exemplar PER change-shape, never two of the same shape
    expect(exemplars.length).toBe(distinct.size);
  });

  it("mineExemplars keeps the newest commit per shape and caps at 8", () => {
    const sha = (c: string) => c.repeat(40);
    const commits = [
      { sha: sha("a"), files: ["src/routes/a.ts"] },
      { sha: sha("b"), files: ["src/routes/b.ts"] }, // 2nd route — dropped
    ];
    const ex = mineExemplars(commits);
    expect(ex).toHaveLength(1);
    expect(ex[0].sha).toBe(sha("a"));
  });
});

describe("card-mapping scan — front-end detection (#162)", () => {
  it("detects a front-end framework in deps/devDeps", () => {
    expect(detectFrontend({ dependencies: { next: "14" } })).toBe(true);
    expect(detectFrontend({ devDependencies: { vite: "5" } })).toBe(true);
    expect(detectFrontend({ dependencies: { "react-native": "0.7" } })).toBe(true);
  });
  it("returns false for a backend-only package.json or garbage", () => {
    expect(detectFrontend({ dependencies: { express: "4", pg: "8" } })).toBe(false);
    expect(detectFrontend(undefined)).toBe(false);
    expect(detectFrontend("nope")).toBe(false);
  });
});

const resp = (content: string): CompletionResponse => ({
  content,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  model: "claude-sonnet-5",
  finishReason: "stop",
});

const validProfile = JSON.stringify({
  profile: { "Tese de arquitetura": "**X**", "Comandos canônicos": "npm test", "Arquivos-chave": "`src/x.ts`" },
  coreSectionsComplete: true,
  goldenRoutes: ["/login", "/pedidos"],
});

describe("card-mapping scan — handler (#162)", () => {
  it("merges deterministic exemplars + hasFrontend into the LLM profile output", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "or-scan-"));
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));

    const gitLog =
      `${"a".repeat(40)}\nsrc/routes/x.ts\n\n${"b".repeat(40)}\nprisma/migrations/1/migration.sql\n`;
    const provider: MappingProvider = { complete: () => Effect.succeed(resp(validProfile)) };
    const deps = {
      registry: { repos: {} },
      githubToken: "gh",
      worktreeBase: "/tmp",
      ledger: undefined as never,
      taskSourceFor: () => undefined,
      makeCliProvider: () => provider,
      runGit: async (args: string[]) => (args[0] === "log" ? { stdout: gitLog, stderr: "" } : { stdout: "", stderr: "" }),
    } as unknown as MappingDeps;

    const prep: MappingPreparationOutput = {
      repo: { slug: "acme", githubRepo: "acme/w", clonePath: "/c", baseBranch: "dev" },
      worktree: { path: workdir, branch: "openroutines/mapeamento-acme-2026-07-04" },
      baseSha: "base",
    };

    const out = (await makeScan(deps)({
      inputs: { title: "Mapear acme", description: "d" },
      outputs: { preparation: prep },
      executionId: "e",
      stateId: "scan",
    })) as unknown as ScanOutput;

    expect(out.hasFrontend).toBe(true);
    expect(out.coreSectionsComplete).toBe(true);
    expect(out.goldenRoutes).toEqual(["/login", "/pedidos"]);
    // exemplars are mined by the handler, NOT taken from the LLM output
    const shapes = out.exemplars.map((e) => e.changeShape).sort();
    expect(shapes).toEqual(["migration", "route"]);

    rmSync(workdir, { recursive: true, force: true });
  });

  it("hasFrontend=false when package.json has no front-end dep", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "or-scan-"));
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { express: "4" } }));
    const provider: MappingProvider = { complete: () => Effect.succeed(resp(validProfile)) };
    const deps = {
      registry: { repos: {} },
      githubToken: "gh",
      worktreeBase: "/tmp",
      taskSourceFor: () => undefined,
      makeCliProvider: () => provider,
      runGit: async () => ({ stdout: "", stderr: "" }),
    } as unknown as MappingDeps;
    const prep: MappingPreparationOutput = {
      repo: { slug: "acme", githubRepo: "acme/w", clonePath: "/c", baseBranch: "dev" },
      worktree: { path: workdir, branch: "b" },
      baseSha: "base",
    };
    const out = (await makeScan(deps)({
      inputs: { title: "t", description: "d" },
      outputs: { preparation: prep },
      executionId: "e",
      stateId: "scan",
    })) as unknown as ScanOutput;
    expect(out.hasFrontend).toBe(false);
    rmSync(workdir, { recursive: true, force: true });
  });
});
