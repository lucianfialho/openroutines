import { describe, it, expect } from "vitest";
import { makeValidacao, extractKeyFiles, extractCommands, type ValidacaoOutput, type ValidacaoProbes } from "./validacao.js";
import type { MapeamentoDeps } from "./index.js";

describe("card-mapeamento validacao — parse helpers (#162)", () => {
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
const varredura = (profile: Record<string, string>, coreSectionsComplete = true) => ({
  profile,
  coreSectionsComplete,
  goldenRoutes: [],
  exemplars: [],
  hasFrontend: false,
});
const ctx = (v: unknown) => ({
  inputs: { title: "t", description: "d" },
  outputs: { preparacao: prep, varredura: v },
  executionId: "e",
  stateId: "validacao",
});

const probes = (over: Partial<ValidacaoProbes>): ValidacaoProbes => ({
  fileExists: () => true,
  readScripts: () => ({ build: "tsc", test: "vitest" }),
  readMakeTargets: () => new Set(),
  ...over,
});

describe("card-mapeamento validacao — audit (#162)", () => {
  it("passes when every arquivo-chave exists and every command resolves", async () => {
    const deps = { validacao: probes({}) } as unknown as MapeamentoDeps;
    const out = (await makeValidacao(deps)(
      ctx(varredura({ "Arquivos-chave": "`src/x.ts`", "Comandos canônicos": "npm run build\nnpm test" }))
    )) as unknown as ValidacaoOutput;
    expect(out.passed).toBe(true);
    expect(out.issues).toEqual([]);
  });

  it("criterion 3: a canonical command whose npm script is absent reproves, naming it", async () => {
    const deps = { validacao: probes({ readScripts: () => ({ test: "vitest" }) }) } as unknown as MapeamentoDeps;
    const out = (await makeValidacao(deps)(
      ctx(varredura({ "Arquivos-chave": "`src/x.ts`", "Comandos canônicos": "npm run build\nnpm test" }))
    )) as unknown as ValidacaoOutput;
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.includes('"build"'))).toBe(true);
  });

  it("reproves when a listed arquivo-chave does not exist in the worktree", async () => {
    const deps = { validacao: probes({ fileExists: (_w, p) => p !== "src/missing.ts" }) } as unknown as MapeamentoDeps;
    const out = (await makeValidacao(deps)(
      ctx(varredura({ "Arquivos-chave": "`src/present.ts` e `src/missing.ts`", "Comandos canônicos": "npm test" }))
    )) as unknown as ValidacaoOutput;
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.includes("src/missing.ts"))).toBe(true);
  });

  it("reproves when varredura itself flagged the core incomplete", async () => {
    const deps = { validacao: probes({}) } as unknown as MapeamentoDeps;
    const out = (await makeValidacao(deps)(ctx(varredura({}, false)))) as unknown as ValidacaoOutput;
    expect(out.passed).toBe(false);
    expect(out.issues.some((i) => i.includes("coreSectionsComplete"))).toBe(true);
  });
});
