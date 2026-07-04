/**
 * card-to-pr / blocked (F3 #146)
 *
 * Moves the card to Blocked with a structured comment (Motivo / O que falta /
 * Próximo passo — the format .openroutines/02-FLUXO-TRELLO.md already uses).
 */
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import { runIdempotent } from "../../persistence/idempotent-action.js";
import { isSecurityBlockReason, sendTelegramAlert } from "../../notify/telegram.js";
import type { CardToPrDeps } from "./index.js";
import type { PreparationOutput } from "./preparation.js";
import type { VerifyOutput } from "./verify.js";
import type { ReviewOutput } from "../../review/aggregate.js";

const BLOCK_DETAILS: Record<string, { faltando: string; proximoPasso: string }> = {
  "repo-unresolvable": {
    faltando: "o campo Repositório do card não bate com nenhuma entrada de repos.yaml",
    proximoPasso: "corrigir o campo Repositório do card ou cadastrar o repo em repos.yaml",
  },
  "no-branch-protection": {
    faltando: "a branch principal do repositório não tem branch protection (required_pull_request_reviews) configurada",
    proximoPasso: "configurar branch protection no GitHub e mover o card de volta para a Fila",
  },
  "verify-failed": {
    faltando: "o verify continua falhando após a tentativa de retry (mesma falha nas duas rodadas)",
    proximoPasso: "revisar os logs de verify, ajustar a implementação manualmente e reabrir o card",
  },
  security: {
    faltando: "a revisão de segurança (security-judge) reprovou o diff",
    proximoPasso: "corrigir os achados de segurança apontados e reabrir o card",
  },
  "security-divergent": {
    faltando: "o 2º juiz de segurança divergiu do veredito do 1º em área crítica",
    proximoPasso: "revisar manualmente os achados divergentes antes de reabrir o card",
  },
  "security-exhausted": {
    faltando: "a revisão esgotou as tentativas de refutação com um gap de segurança ainda aberto",
    proximoPasso: "revisar o achado de segurança manualmente e reabrir o card",
  },
  "review-exhausted": {
    faltando: "a revisão esgotou as tentativas de refutação sem aprovar o diff",
    proximoPasso: "revisar os gaps remanescentes manualmente e reabrir o card",
  },
  "plan-refuted-2x": {
    faltando: "o plan de arquitetura (gate_plan) foi refutado duas vezes",
    proximoPasso: "revisar o plan manualmente, ajustá-lo e reabrir o card",
  },
};
const DEFAULT_BLOCK_DETAIL = { faltando: "motivo não mapeado", proximoPasso: "revisar a execução manualmente" };

const blockedBody = (reason: string): string => {
  const detail = BLOCK_DETAILS[reason] ?? DEFAULT_BLOCK_DETAIL;
  return `⛔ [Bloqueio]\nMotivo: ${reason}\nO que falta: ${detail.faltando}\nPróximo passo: ${detail.proximoPasso}`;
};

export const makeBlocked = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const preparation = ctx.outputs.preparation as PreparationOutput | undefined;
  const verify = ctx.outputs.verify as VerifyOutput | undefined;
  const review = ctx.outputs.review as ReviewOutput | undefined;
  // #153 security issue extends securityVerdict with `secondJudge` (independent
  // 2nd judge in a critical area) — read defensively; aggregate.ts's exported
  // type stays minimal (`{approved, findings, criticalArea}`) until that lands.
  const securityVerdict = review?.securityVerdict as { approved: boolean; secondJudge?: { diverged?: boolean } } | null | undefined;
  const securityBlockReason =
    securityVerdict?.approved === false
      ? securityVerdict.secondJudge?.diverged === true
        ? "security-divergent"
        : "security"
      : undefined;
  // F4 #185: gate_plan refuted twice escapes via on_exhausted (state-machine.ts
  // marks outputs.gate_plan.exhausted=true and routes here instead of failing).
  const gatePlano = ctx.outputs.gate_plan as { exhausted?: boolean } | undefined;
  const gatePlanoBlockReason = gatePlano?.exhausted === true ? "plan-refuted-2x" : undefined;
  // H3/#186: review->refutation exhausting its max_retries:2 (skill.yaml)
  // escapes the same on_exhausted way gate_plan does — state-machine.ts
  // stamps outputs.review.exhausted=true (keeping the last pass's own
  // gaps/securityVerdict) instead of failing. A security gap still open at
  // that point is a genuine security block (must alert + not read as
  // 'desconhecido'); any other remaining gap is just a stuck review.
  const reviewExhausted = (review as (ReviewOutput & { exhausted?: boolean }) | undefined)?.exhausted === true;
  const revisaoExhaustedBlockReason = reviewExhausted
    ? review?.gaps?.some((g) => g.lens === "security")
      ? "security-exhausted"
      : "review-exhausted"
    : undefined;
  const blockReason =
    preparation?.blockReason ??
    verify?.blockReason ??
    securityBlockReason ??
    revisaoExhaustedBlockReason ??
    gatePlanoBlockReason ??
    "desconhecido";
  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);

  await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "blocked", actionKey: "card:blocked" },
    async () => {
      const ts = deps.taskSourceFor(sourceId);
      if (ts) {
        await Effect.runPromise(ts.moveTo(taskId, "blocked"));
        await Effect.runPromise(ts.comment(taskId, blockedBody(blockReason)));
      }
      return {};
    }
  );

  // M3/D24: a REWORK round that ends up here (skill.yaml's rework_preparation/
  // rework/verify/review on_exhausted edges) must never leave the pr_link at
  // reviewState 'changes_requested' — admitReworkCards (night-coordinator/
  // run.ts) only skips a link once its reviewState is the terminal
  // 'rework-exhausted' (the same value blockExhaustedRework writes for the
  // rework-count cap); otherwise the SAME open PR gets re-admitted every
  // night. `rework`/`branch` are skill.yaml top-level inputs threaded through
  // the whole execution, so they're set here regardless of which state inside
  // the rework flow actually failed. A non-rework blocked (fresh card,
  // never touches an existing pr_link) leaves this untouched.
  if (ctx.inputs.rework === true) {
    const branch = String(ctx.inputs.branch ?? "");
    await runIdempotent(
      deps.ledger,
      { executionId: ctx.executionId, stateId: "blocked", actionKey: "pr-links:rework-exhausted" },
      async () => {
        await deps.prLinks.update({ sourceId, taskId, branch }, { reviewState: "rework-exhausted" });
        return {};
      }
    );
  }

  // D22/F4 #186: the ONE funnel every blockReason passes through before Blocked
  // — covers `security*` no matter which phase (preparation/verify/future) set
  // it. A sibling actionKey (not `card:blocked`) so a crash between the move
  // above and this alert re-fires only the alert on resume, not the move/comment.
  if (isSecurityBlockReason(blockReason)) {
    const sendAlert = deps.sendAlert ?? sendTelegramAlert;
    const title = String(ctx.inputs.title ?? "");
    const repo = String(ctx.inputs.repo ?? "");
    await runIdempotent(
      deps.ledger,
      { executionId: ctx.executionId, stateId: "blocked", actionKey: "notify:telegram" },
      async () => {
        await sendAlert(`⛔ [${sourceId}/${taskId}] blockReason=${blockReason}: ${title} — ${repo}`);
        return {};
      }
    );
  }

  return { blocked: true, blockReason };
};
