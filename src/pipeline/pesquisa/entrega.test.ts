import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeEntrega, formatProposalMarkdown, type EntregaOutput } from "./entrega.js";
import type { PesquisaDeps } from "./index.js";
import type { LevantamentoDoc } from "./levantamento.js";
import type { JulgamentoVerdict } from "./julgamento.js";
import type { TaskSource } from "../../task-source/types.js";

const doc = (phaseCount: number): LevantamentoDoc => ({
  summary: "resumo executivo",
  currentState: "como é hoje",
  options: [
    { name: "Opção A", tradeoffs: "rápida mas acopla", recommended: true },
    { name: "Opção B", tradeoffs: "flexível mas cara", recommended: false },
  ],
  dataChanges: ["migração: nova coluna"],
  filesAffected: ["src/a.ts"],
  phases: Array.from({ length: phaseCount }, (_, i) => `Fase ${i + 1}`),
});

const parecer: JulgamentoVerdict = {
  verdict: "aprovado",
  corrections: ["corrigir Y"],
  securityOpinion: { exposesNewSurface: false, notes: "sem novas superfícies" },
};

const prep = { repos: [{ slug: "acme", githubRepo: "acme/widgets", clonePath: "/c", baseBranch: "dev" }] };

interface Record_ {
  milestones: Array<{ title: string; description?: string }>;
  issues: Array<{ title: string; body: string; opts?: { milestone?: number } }>;
  comments: Array<{ id: string; body: string }>;
  attachments: Array<{ id: string; art: { filename: string; content: string; mimeType?: string } }>;
  moves: Array<{ id: string; state: string }>;
}
const freshRecord = (): Record_ => ({ milestones: [], issues: [], comments: [], attachments: [], moves: [] });

const baseDeps = (rec: Record_): PesquisaDeps => ({
  registry: { repos: {} },
  githubToken: "gh",
  worktreeBase: "/tmp",
  claudeApiKey: "sk",
  makeGithub: (() => ({
    createMilestone: (title: string, description?: string) => {
      rec.milestones.push({ title, description });
      return Effect.succeed({ number: 99, url: "https://github.com/acme/widgets/milestone/99" });
    },
    createIssue: (title: string, body: string, opts?: { milestone?: number }) => {
      rec.issues.push({ title, body, opts });
      const n = rec.issues.length;
      return Effect.succeed({ number: n, url: `https://github.com/acme/widgets/issues/${n}` });
    },
  })) as unknown as PesquisaDeps["makeGithub"],
  taskSourceFor: () =>
    ({
      comment: (id: string, body: string) => {
        rec.comments.push({ id, body });
        return Effect.succeed(undefined);
      },
      attachArtifact: (id: string, art: { filename: string; content: string; mimeType?: string }) => {
        rec.attachments.push({ id, art });
        return Effect.succeed(undefined);
      },
      moveTo: (id: string, state: string) => {
        rec.moves.push({ id, state });
        return Effect.succeed(undefined);
      },
    }) as unknown as TaskSource,
});

const inputs = { source_id: "trello", task_id: "card1", repo: "acme", title: "Pesquisar X", description: "D" };
const run = (deps: PesquisaDeps, outputs: Record<string, unknown>) =>
  makeEntrega(deps)({ inputs, outputs, executionId: "e", stateId: "entrega" }) as Promise<EntregaOutput>;

describe("card-pesquisa entrega", () => {
  it("phases=4 -> a milestone with 4 issues, each linked to it by number (criterion 4)", async () => {
    const rec = freshRecord();
    const out = await run(baseDeps(rec), { preparacao: prep, levantamento_proposta: doc(4), julgamento_arquitetura: parecer });

    expect(rec.milestones).toHaveLength(1);
    expect(rec.issues).toHaveLength(4);
    expect(rec.issues.every((i) => i.opts?.milestone === 99)).toBe(true);
    expect(out.milestoneUrl).toBe("https://github.com/acme/widgets/milestone/99");
    expect(out.issueUrl).toBe("https://github.com/acme/widgets/issues/1");
  });

  it("phases=2 -> 2 loose issues, NO milestone (criterion 4)", async () => {
    const rec = freshRecord();
    const out = await run(baseDeps(rec), { preparacao: prep, levantamento_proposta: doc(2), julgamento_arquitetura: parecer });

    expect(rec.milestones).toHaveLength(0);
    expect(rec.issues).toHaveLength(2);
    expect(rec.issues.every((i) => i.opts === undefined)).toBe(true);
    expect(out.milestoneUrl).toBeUndefined();
    expect(out.issueUrl).toBe("https://github.com/acme/widgets/issues/1");
  });

  it("phases=3 -> milestone (the >= 3 boundary is inclusive)", async () => {
    const rec = freshRecord();
    await run(baseDeps(rec), { preparacao: prep, levantamento_proposta: doc(3), julgamento_arquitetura: parecer });
    expect(rec.milestones).toHaveLength(1);
    expect(rec.issues).toHaveLength(3);
  });

  it("posts a summary comment, attaches the full .md, and moves the card to Review", async () => {
    const rec = freshRecord();
    const out = await run(baseDeps(rec), { preparacao: prep, levantamento_proposta: doc(2), julgamento_arquitetura: parecer });

    expect(rec.comments).toHaveLength(1);
    expect(rec.comments[0].body).toContain("[Pesquisa]");
    expect(rec.comments[0].body).toContain("aprovado");
    expect(rec.attachments).toHaveLength(1);
    expect(rec.attachments[0].art.filename).toBe("pesquisa-card1.md");
    expect(rec.attachments[0].art.mimeType).toBe("text/markdown");
    expect(rec.attachments[0].art.content).toContain("# Pesquisa: Pesquisar X");
    expect(rec.attachments[0].art.content).toContain("✅ RECOMENDADA");
    expect(rec.moves).toEqual([{ id: "card1", state: "review" }]);
    expect(out.cardCommentPosted).toBe(true);
    expect(out.attachmentPosted).toBe(true);
  });

  it("degrades to card-only delivery when no repo resolved (no GitHub issue, still delivered)", async () => {
    const rec = freshRecord();
    const out = await run(baseDeps(rec), { preparacao: { repos: [] }, levantamento_proposta: doc(2), julgamento_arquitetura: parecer });

    expect(rec.issues).toHaveLength(0);
    expect(rec.milestones).toHaveLength(0);
    expect(out.issueUrl).toBe("");
    expect(rec.comments).toHaveLength(1); // the card still receives the proposal
    expect(rec.attachments).toHaveLength(1);
    expect(rec.moves).toEqual([{ id: "card1", state: "review" }]);
  });

  it("formatProposalMarkdown always includes the security opinion and the full parecer", () => {
    const md = formatProposalMarkdown("X", doc(2), parecer);
    expect(md).toContain("## Parecer de arquitetura");
    expect(md).toContain("expõe nova superfície");
    expect(md).toContain("sem novas superfícies");
    expect(md).toContain("Opção A ✅ RECOMENDADA");
  });
});
