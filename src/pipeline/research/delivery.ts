/**
 * card-research / delivery (F5 #161)
 *
 * Delivery (D21): the FULL proposal .md is attached to the CARD (what a human
 * reads), while the canonical architecture the future implementation consumes
 * goes to GitHub — phases.length >= 3 becomes a milestone with one issue per
 * phase; <= 2 becomes loose issues. Then the card gets a 3-5 line summary
 * comment, the .md attachment, and a move to Review.
 *
 * Idempotency (F5 #162 hardening): when a ledger is wired, the GitHub delivery
 * (milestone + issues) and the card handoff (comment + attach + move) each fire
 * at most once per (executionId, actionKey) — a crash mid-delivery + resume no
 * longer mints a duplicate milestone/issue on GitHub. Without a ledger (the
 * legacy e2e harness) it runs directly, unchanged.
 */
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import type { TaskArtifact } from "../../task-source/types.js";
import { runIdempotent } from "../../persistence/idempotent-action.js";
import { resolveGithub, type ResearchDeps } from "./index.js";
import type { SurveyDoc } from "./survey.js";
import type { JudgmentVerdict } from "./judgment.js";
import type { PreparationOutput } from "./preparation.js";

export interface DeliveryOutput {
  issueUrl: string;
  milestoneUrl?: string;
  cardCommentPosted: boolean;
  attachmentPosted: boolean;
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bullets = (items: string[], empty: string): string =>
  items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : empty;

export const formatProposalMarkdown = (title: string, doc: SurveyDoc, parecer: JudgmentVerdict): string => {
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
  doc: SurveyDoc,
  parecer: JudgmentVerdict,
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
  doc: SurveyDoc,
  parecer: JudgmentVerdict,
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

export const makeDelivery = (deps: ResearchDeps): ScriptHandler => async (ctx) => {
  const doc = ctx.outputs.survey_proposal as SurveyDoc;
  const parecer = ctx.outputs.architecture_judgment as JudgmentVerdict;
  const prep = ctx.outputs.preparation as PreparationOutput | undefined;
  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);
  const title = String(ctx.inputs.title);

  const fullMd = formatProposalMarkdown(title, doc, parecer);

  // Fire an external effect at most once per (executionId, actionKey) when a
  // ledger is wired; otherwise run it directly (legacy path). Same guard pr.ts
  // uses — a crash mid-delivery + resume never re-creates the GitHub issues.
  const once = async (
    actionKey: string,
    run: () => Promise<{ externalRef?: string }>
  ): Promise<{ externalRef?: string }> => {
    if (!deps.ledger) return run();
    return runIdempotent(deps.ledger, { executionId: ctx.executionId, stateId: ctx.stateId, actionKey }, run);
  };

  // GitHub: file against the product repo (the card's first resolved repo). A
  // docs/ecosystem card with no resolvable repo still delivers to the card
  // (issueUrl stays ""). externalRef carries {issueUrl, milestoneUrl} so a
  // ledger-skip resume recovers both without re-hitting GitHub.
  const targetRepo = prep?.repos?.[0]?.githubRepo;
  const delivery = await once("github:delivery", async () => {
    if (!targetRepo) return { externalRef: JSON.stringify({ issueUrl: "" }) };
    const github = resolveGithub(deps, targetRepo);
    const phases = doc.phases;
    const useMilestone = phases.length >= 3;
    const effectivePhases = phases.length > 0 ? phases : ["(proposta completa — sem fases discretas)"];

    let milestoneNumber: number | undefined;
    let msUrl: string | undefined;
    if (useMilestone) {
      const ms = await Effect.runPromise(github.createMilestone(`Pesquisa: ${clip(title, 120)}`, doc.summary));
      milestoneNumber = ms.number;
      msUrl = ms.url;
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
    return { externalRef: JSON.stringify({ issueUrl: createdUrls[0] ?? "", milestoneUrl: msUrl }) };
  });
  const { issueUrl, milestoneUrl } = JSON.parse(delivery.externalRef ?? '{"issueUrl":""}') as {
    issueUrl: string;
    milestoneUrl?: string;
  };

  // Card: summary comment + full .md attachment + move to Review.
  const ts = deps.taskSourceFor(sourceId);
  if (ts) {
    await once("card:handoff", async () => {
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
      await Effect.runPromise(ts.attachArtifact(taskId, artifact));
      await Effect.runPromise(ts.moveTo(taskId, "review"));
      return { externalRef: issueUrl || milestoneUrl || taskId };
    });
  }

  return {
    issueUrl,
    ...(milestoneUrl ? { milestoneUrl } : {}),
    cardCommentPosted: Boolean(ts),
    attachmentPosted: Boolean(ts),
  } satisfies DeliveryOutput;
};
