/**
 * card-to-pr / bloqueado (F3 #146)
 *
 * Moves the card to Blocked with a structured comment (Motivo / O que falta /
 * Próximo passo — the format .openroutines/02-FLUXO-TRELLO.md already uses).
 */
import { Effect } from "effect";
import type { ScriptHandler } from "../../script/registry.js";
import { runIdempotent } from "../../persistence/idempotent-action.js";
import type { CardToPrDeps } from "./index.js";
import type { PreparacaoOutput } from "./preparacao.js";
import type { VerifyOutput } from "./verify.js";

const BLOCK_DETAILS: Record<string, { faltando: string; proximoPasso: string }> = {
  "repo-nao-resolvivel": {
    faltando: "o campo Repositório do card não bate com nenhuma entrada de repos.yaml",
    proximoPasso: "corrigir o campo Repositório do card ou cadastrar o repo em repos.yaml",
  },
  "sem-branch-protection": {
    faltando: "a branch principal do repositório não tem branch protection (required_pull_request_reviews) configurada",
    proximoPasso: "configurar branch protection no GitHub e mover o card de volta para a Fila",
  },
  "verify-falhou": {
    faltando: "o verify continua falhando após a tentativa de retry (mesma falha nas duas rodadas)",
    proximoPasso: "revisar os logs de verify, ajustar a implementação manualmente e reabrir o card",
  },
};
const DEFAULT_BLOCK_DETAIL = { faltando: "motivo não mapeado", proximoPasso: "revisar a execução manualmente" };

const blockedBody = (reason: string): string => {
  const detail = BLOCK_DETAILS[reason] ?? DEFAULT_BLOCK_DETAIL;
  return `⛔ [Bloqueio]\nMotivo: ${reason}\nO que falta: ${detail.faltando}\nPróximo passo: ${detail.proximoPasso}`;
};

export const makeBloqueado = (deps: CardToPrDeps): ScriptHandler => async (ctx) => {
  const preparacao = ctx.outputs.preparacao as PreparacaoOutput | undefined;
  const verify = ctx.outputs.verify as VerifyOutput | undefined;
  const blockReason = preparacao?.blockReason ?? verify?.blockReason ?? "desconhecido";
  const sourceId = String(ctx.inputs.source_id);
  const taskId = String(ctx.inputs.task_id);

  await runIdempotent(
    deps.ledger,
    { executionId: ctx.executionId, stateId: "bloqueado", actionKey: "card:blocked" },
    async () => {
      const ts = deps.taskSourceFor(sourceId);
      if (ts) {
        await Effect.runPromise(ts.moveTo(taskId, "blocked"));
        await Effect.runPromise(ts.comment(taskId, blockedBody(blockReason)));
      }
      return {};
    }
  );

  return { blocked: true, blockReason };
};
