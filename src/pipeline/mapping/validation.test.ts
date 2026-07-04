import { describe, it, expect } from "vitest";
import { makeValidation, extractKeyFiles, extractCommands, type ValidationOutput, type ValidationProbes } from "./validation.js";
import type { MappingDeps } from "./index.js";

describe("card-mapping validation — parse helpers (#162)", () => {
  it("extractKeyFiles takes only backtick path tokens (never a prose slash)", () => {
    const section = "- `src/routes/pedidos.ts` → rota principal\n- `prisma/schema.prisma` → schema\n- este e/ou aquele";
    expect(extractKeyFiles(section).sort()).toEqual(["prisma/schema.prisma", "src/routes/pedidos.ts"]);
  });

  it("extractCommands resolves npm/pnpm/yarn scripts + make targets, ignoring install/infra", () => {
    const section = "| build | npm run build |\n| test | npm test |\n| deps | npm install |\n| sandbox | docker compose up |\n| gen | make codegen |";
    const cmds = extractCommands(section);
    const npm = cmds.filter((c) => c.kind === "npm-script").map((c) => c.name).sort();
    const make = cmds.filter((c) => c.kind === "make-target").map((c) => c.name);
    expect(npm).toEqual(["build", "test"]); // install excluded; docker not matched
    expect(make).toEqual(["codegen"]);
  });
});

const prep = { worktree: { path: "/wt", branch: "b" }, repo: { slug: "acme" }, baseSha: "s" };
const scan = (profile: Record<string, string>, coreSectionsComplete = true) => ({
  profile,
  coreSectionsComplete,
  goldenRoutes: [],
  exemplars: [],
  hasFrontend: false,
});
const ctx = (v: unknown) => ({
  inputs: { title: "t", description: "d" },
  outputs: { preparation: prep, scan: v },
  executionId: "e",
  stateId: "validation",
});

const probes = (over: Partial<ValidationProbes>): ValidationProbes => ({
  fileExists: () => true,
  readScripts: () => ({ build: "tsc", test: "vitest" }),
  readMakeTargets: () => new Set(),
  ...over,
});

describe("card-mapping validation — audit (#162)", () => {
  it("passes when every arquivo-chave exists and every command resolves", async () => {
    const deps = { validation: probes({}) } as unknown as MappingDeps;
    const out = (await makeValidation(deps)(
      ctx(scan({ "Arquivos-chave": "`src/x.ts`", "Comandos canônicos": "npm run build\nnpm test" }))
    )) as unknown as ValidationOutput;
    expect(out.passed).toBe(true);
    expect(out.issues).toEqual([]);
  });

  it("criterion 3: a canonical command whose npm script is absent reproves, naming it", async () => {
    const deps = { validation: probes({ readScripts: () => ({ test: "vitest" }) }) } as unknown as MappingDeps;
    const out = (await makeValidation(deps)(
      ctx(scan({ "Arquivos-chave": "`src/x.ts`", "Comandos canônicos": "npm run build\nnpm test" }))
    )) as unknown as ValidationOutput;
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.includes('"build"'))).toBe(true);
  });

  it("reproves when a listed arquivo-chave does not exist in the worktree", async () => {
    const deps = { validation: probes({ fileExists: (_w, p) => p !== "src/missing.ts" }) } as unknown as MappingDeps;
    const out = (await makeValidation(deps)(
      ctx(scan({ "Arquivos-chave": "`src/present.ts` e `src/missing.ts`", "Comandos canônicos": "npm test" }))
    )) as unknown as ValidationOutput;
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.includes("src/missing.ts"))).toBe(true);
  });

  it("reproves when scan itself flagged the core incomplete", async () => {
    const deps = { validation: probes({}) } as unknown as MappingDeps;
    const out = (await makeValidation(deps)(ctx(scan({}, false)))) as unknown as ValidationOutput;
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.includes("coreSectionsComplete"))).toBe(true);
  });
});
