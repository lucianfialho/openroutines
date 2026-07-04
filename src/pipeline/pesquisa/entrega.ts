/**
 * card-pesquisa / entrega (F5 #161)
 *
 * Delivery (D21): the FULL proposal .md is attached to the CARD (what a human
 * reads), while the canonical architecture the future implementation consumes
 * goes to GitHub — phases.length >= 3 becomes a milestone with one issue per
 * phase; <= 2 becomes loose issues. Then the card gets a 3-5 line summary
 * comment, the .md attachment, and a move to Review.
 *
 * ponytail: no action-ledger idempotency here (unlike card-to-pr/pr.ts). A
 * process crash mid-delivery + resume re-runs this state from scratch, which
 * could mint a duplicate milestone/issue — low-harm for a research card (a
 * human dedupes two issues) and rare. Wrap each effect in runIdempotent (the
 * ledger seam pr.ts uses) if duplicate delivery ever becomes a real problem.
 */
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import type { TaskArtifact } from "../../task-source/types.js";
import { resolveGithub, type PesquisaDeps } from "./index.js";
import type { LevantamentoDoc } from "./levantamento.js";
import type { JulgamentoVerdict } from "./julgamento.js";
import type { PreparacaoOutput } from "./preparacao.js";

export interface EntregaOutput {
  issueUrl: string;
  milestoneUrl?: string;
  cardCommentPosted: boolean;
  attachmentPosted: boolean;
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bullets = (items: string[], empty: string): string =>
  items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : empty;

export const formatProposalMarkdown = (title: string, doc: LevantamentoDoc, parecer: JulgamentoVerdict): string => {
  const options = doc.options
    .map((o, i) => `### ${i + 1}. ${o.name}${o.recommended ? " ✅ RECOMENDADA" : ""}\n${o.tradeoffs}`)
    .join("\n\n");
  return [
    `# Pesquisa: ${title}`,
    "",
    `> Veredito de arquitetura: **${parecer.verdict}**`,
    "",
    "## Resumo",
    doc.summary,
    "",
    "## Estado atual",
    doc.currentState,
    "",
    "## Alternativas",
    options || "_Nenhuma alternativa registrada._",
    "",
    "## Mudanças de dados",
    bullets(doc.dataChanges, "_Nenhuma._"),
    "",
    "## Arquivos / áreas afetadas",
    bullets(doc.filesAffected, "_Nenhum._"),
    "",
    "## Fases de implementação",
    doc.phases.length > 0 ? doc.phases.map((p, i) => `${i + 1}. ${p}`).join("\n") : "_Sem fases discretas._",
    "",
    "## Parecer de arquitetura",
    `- Veredito: **${parecer.verdict}**`,
    `- Correções:\n${bullets(parecer.corrections, "  - _Nenhuma._")}`,
    `- Segurança: expõe nova superfície = **${parecer.securityOpinion.exposesNewSurface}**; ${parecer.securityOpinion.notes}`,
    ...(parecer.escalateReason ? [`- Motivo de escalada: ${parecer.escalateReason}`] : []),
    "",
  ].join("\n");
};

const buildPhaseIssueBody = (
  taskId: string,
  title: string,
  doc: LevantamentoDoc,
  parecer: JulgamentoVerdict,
  phase: string,
  index: number,
  total: number
): string => {
  const recommended = doc.options.find((o) => o.recommended);
  return [
    `**Fase ${index + 1}/${total} da pesquisa "${title}".**`,
    "",
    phase,
    "",
    `**Alternativa recomendada:** ${recommended?.name ?? "(nenhuma marcada)"}`,
    "",
    `**Resumo da proposta:** ${doc.summary}`,
    "",
    `**Parecer (${parecer.verdict}) — correções:**`,
    bullets(parecer.corrections, "- _Nenhuma._"),
    "",
    `_Proposta completa (.md) anexada ao card de origem (task ${taskId})._`,
  ].join("\n");
};

const buildCardComment = (
  doc: LevantamentoDoc,
  parecer: JulgamentoVerdict,
  primaryUrl: string,
  isMilestone: boolean,
  issueCount: number
): string => {
  const recommended = doc.options.find((o) => o.recommended);
  const grouping = isMilestone ? `milestone (${issueCount} issues)` : `${issueCount} issue(s)`;
  return [
    `🔬 [Pesquisa] ${clip(doc.summary, 200)}`,
    `Veredito de arquitetura: **${parecer.verdict}**. Alternativa recomendada: ${recommended?.name ?? "—"}.`,
    `Entregue no GitHub como ${grouping}: ${primaryUrl || "(sem repo alvo resolvido)"}`,
    `Proposta completa (.md) anexada acima.`,
  ].join("\n");
};

export const makeEntrega = (deps: PesquisaDeps): ScriptHandler => async (ctx) => {
  const doc = ctx.outputs.levantamento_proposta as LevantamentoDoc;
  const parecer = ctx.outputs.julgamento_arquitetura as JulgamentoVerdict;
  const prep = ctx.outputs.preparacao as PreparacaoOutput | undefined;
  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);
  const title = String(ctx.inputs.title);

  const fullMd = formatProposalMarkdown(title, doc, parecer);

  // GitHub: file against the product repo (the card's first resolved repo). A
  // docs/ecosystem card with no resolvable repo still delivers to the card
  // (issueUrl stays "").
  const targetRepo = prep?.repos?.[0]?.githubRepo;
  let issueUrl = "";
  let milestoneUrl: string | undefined;
  if (targetRepo) {
    const github = resolveGithub(deps, targetRepo);
    const phases = doc.phases;
    const useMilestone = phases.length >= 3;
    const effectivePhases = phases.length > 0 ? phases : ["(proposta completa — sem fases discretas)"];

    let milestoneNumber: number | undefined;
    if (useMilestone) {
      const ms = await Effect.runPromise(github.createMilestone(`Pesquisa: ${clip(title, 120)}`, doc.summary));
      milestoneNumber = ms.number;
      milestoneUrl = ms.url;
    }

    const createdUrls: string[] = [];
    for (let i = 0; i < effectivePhases.length; i++) {
      const issue = await Effect.runPromise(
        github.createIssue(
          `[Pesquisa] ${clip(title, 60)} — Fase ${i + 1}: ${clip(effectivePhases[i], 80)}`,
          buildPhaseIssueBody(taskId, title, doc, parecer, effectivePhases[i], i, effectivePhases.length),
          milestoneNumber !== undefined ? { milestone: milestoneNumber } : undefined
        )
      );
      createdUrls.push(issue.url);
    }
    issueUrl = createdUrls[0] ?? "";
  }

  // Card: summary comment + full .md attachment + move to Review.
  const ts = deps.taskSourceFor(sourceId);
  let cardCommentPosted = false;
  let attachmentPosted = false;
  if (ts) {
    const artifact: TaskArtifact = {
      filename: `pesquisa-${slugify(taskId)}.md`,
      content: fullMd,
      mimeType: "text/markdown",
    };
    await Effect.runPromise(
      ts.comment(
        taskId,
        buildCardComment(doc, parecer, milestoneUrl ?? issueUrl, Boolean(milestoneUrl), doc.phases.length || 1)
      )
    );
    cardCommentPosted = true;
    await Effect.runPromise(ts.attachArtifact(taskId, artifact));
    attachmentPosted = true;
    await Effect.runPromise(ts.moveTo(taskId, "review"));
  }

  return {
    issueUrl,
    ...(milestoneUrl ? { milestoneUrl } : {}),
    cardCommentPosted,
    attachmentPosted,
  } satisfies EntregaOutput;
};
